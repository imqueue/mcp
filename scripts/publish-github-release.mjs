// Publish a GitHub Release for the just-published version after `npm publish`.
//
// Wired as part of the npm `postpublish` lifecycle hook (alongside the MCP
// registry publish) so every `npm publish` also cuts a matching GitHub Release
// from the `v<version>` tag. A published GitHub Release (not just a git tag)
// is what tooling like Glama's maintenance score, Dependabot and release feeds
// look for.
//
// Everything here is optional: if no token is available on the machine doing
// the publish, the script prints a reminder and exits 0 so it NEVER blocks
// `npm publish` (which has already completed by the time this runs).
//
// Requirements on the publishing machine to actually run:
//   - a token that can create releases on the repo, from the FIRST of these that is
//     set: GH_AUTH_TOKEN, GITHUB_TOKEN, GH_TOKEN.
//       * fine-grained PAT: "Contents: Read and write" on imqueue/mcp
//       * classic PAT: `repo` scope
//     GH_AUTH_TOKEN is checked first because it is the one a maintainer exports
//     deliberately, while GITHUB_TOKEN in CI is the ambient repo-scoped token and
//     may have narrower permissions. An explicit credential should win over an
//     inherited one.
//     NEVER commit this — export it in your shell profile or a gitignored .env,
//     and store it as a CI secret for CI runs. The script logs which VARIABLE
//     supplied the token and never the token itself.
// Optional overrides:
//   - GITHUB_RELEASE_REPO   owner/repo (default: parsed from package.json "repository")
//   - GITHUB_API_URL        API base (default: https://api.github.com; set for GH Enterprise)
//
// Note: the `v<version>` tag should exist on the remote (that's what
// `npm version` + `git push --follow-tags` produces) so the release points at
// the exact published commit. If the tag isn't on the remote yet, GitHub
// creates it from the current HEAD commit (or the default branch as a fallback).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const isPrerelease = version.includes("-"); // e.g. 2.1.0-beta.1

const TOKEN_VARS = ["GH_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];
// The name of the variable that supplied the token, so a failed release says which
// credential it used. Only the NAME is ever printed.
const TOKEN_VAR = TOKEN_VARS.find((v) => process.env[v]);
const TOKEN = TOKEN_VAR ? process.env[TOKEN_VAR] : undefined;
const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

const skip = (why) => {
  console.warn(`\n⚠  GitHub Release skipped — ${why}.`);
  console.warn("   npm publish succeeded; there just isn't a GitHub Release for this version here.");
  console.warn(`   To set it up: export one of ${TOKEN_VARS.join(", ")} (a PAT with`);
  console.warn("   Contents:write / `repo` scope), or create the release manually for");
  console.warn(`   tag ${tag}.\n`);
  process.exit(0); // never block a completed npm publish
};

const fail = (msg) => {
  console.error(
    `\n✖ GitHub Release step failed — ${msg}\n` +
      `  npm publish already completed. Fix the issue and create the release for ` +
      `${tag} manually (or re-run this script).\n`,
  );
  process.exit(1);
};

if (typeof fetch !== "function") skip("global fetch is unavailable (needs Node >= 18)");
if (!TOKEN) skip(`none of ${TOKEN_VARS.join(" / ")} is set`);

// Resolve owner/repo: explicit override, else parse the package.json repository URL.
function resolveRepo() {
  if (process.env.GITHUB_RELEASE_REPO) return process.env.GITHUB_RELEASE_REPO.trim();
  const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "";
  const m = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  if (!m) fail(`could not determine owner/repo from package.json "repository" (${url || "missing"}); set GITHUB_RELEASE_REPO`);
  return `${m[1]}/${m[2]}`;
}
const repo = resolveRepo();

// Current commit, so a not-yet-on-remote tag is created at the published commit.
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const commit = head.status === 0 ? head.stdout.trim() : null;

const gh = async (path, init = {}) => {
  const res = await fetch(`${API}/repos/${repo}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "imqueue-mcp-release-script",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return res;
};

async function createRelease(withTarget) {
  const body = {
    tag_name: tag,
    name: tag,
    generate_release_notes: true,
    prerelease: isPrerelease,
    make_latest: isPrerelease ? "false" : "true",
    ...(withTarget && commit ? { target_commitish: commit } : {}),
  };
  return gh("/releases", { method: "POST", body: JSON.stringify(body) });
}

console.log(`\nCreating GitHub Release ${repo}@${tag} (auth from ${TOKEN_VAR})…`);

// Idempotent: don't duplicate an existing release for this tag.
const existing = await gh(`/releases/tags/${encodeURIComponent(tag)}`);
if (existing.ok) {
  const rel = await existing.json();
  console.log(`✔ GitHub Release already exists for ${tag} — nothing to do.\n  ${rel.html_url}\n`);
  process.exit(0);
}

let res = await createRelease(true);
// If pinning to HEAD failed because that commit isn't on the remote, let GitHub
// resolve the tag/default branch itself.
if (res.status === 422 && commit) {
  const detail = await res.clone().text();
  console.warn(`  Retrying without target_commitish (${detail.slice(0, 200)})`);
  res = await createRelease(false);
}

if (res.ok) {
  const rel = await res.json();
  console.log(`✔ Published GitHub Release ${tag}${isPrerelease ? " (pre-release)" : ""}\n  ${rel.html_url}\n`);
  process.exit(0);
}

// Treat a lost create-race (already exists) as success.
const errText = await res.text();
if (res.status === 422 && /already_exists/i.test(errText)) {
  console.log(`✔ GitHub Release for ${tag} already exists (created concurrently) — nothing to do.\n`);
  process.exit(0);
}
fail(`GitHub API responded ${res.status}: ${errText.slice(0, 400)}`);
