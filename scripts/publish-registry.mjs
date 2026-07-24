// Publish the current server.json to the official MCP Registry
// (registry.modelcontextprotocol.io) after a successful `npm publish`.
//
// Wired as the npm `postpublish` lifecycle hook so every `npm publish` keeps
// the registry entry in lock-step with npm. The registry pins an EXACT version
// and does NOT track npm automatically — each release needs its own publish,
// which is exactly what this automates.
//
// Everything here is optional: if the CLI or key is missing on the machine
// doing the publish, the script prints a reminder and exits 0 so it NEVER
// blocks `npm publish` (which has already completed by the time this runs).
//
// Requirements on the publishing machine to actually run:
//   - the `mcp-publisher` CLI on PATH (or set MCP_PUBLISHER_BIN to its path)
//   - MCP_REGISTRY_KEY: the ed25519 private key for the imqueue.org domain
//     namespace (org.imqueue). NEVER commit this — export it in your shell
//     profile or a gitignored .env, and store it as a CI secret for CI runs.
// Optional overrides:
//   - MCP_REGISTRY_DOMAIN       (default: imqueue.org)
//   - MCP_REGISTRY_LOGIN_METHOD (default: dns; set "http" if the imqueue.org
//                                namespace was verified over HTTP instead)
//   - MCP_PUBLISHER_BIN         (default: mcp-publisher)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = process.env.MCP_PUBLISHER_BIN || "mcp-publisher";
const KEY = process.env.MCP_REGISTRY_KEY;
const DOMAIN = process.env.MCP_REGISTRY_DOMAIN || "imqueue.org";
const METHOD = process.env.MCP_REGISTRY_LOGIN_METHOD || "dns";

const version = JSON.parse(readFileSync(join(root, "server.json"), "utf8")).version;

const skip = (why) => {
  console.warn(`\n⚠  MCP registry update skipped — ${why}.`);
  console.warn("   npm publish succeeded; the registry is just not auto-updated here.");
  console.warn("   To update it manually (or set this up on this machine):");
  console.warn(`     ${BIN} login ${METHOD} --domain ${DOMAIN} --private-key <key>`);
  console.warn(`     cd ${root} && ${BIN} publish\n`);
  process.exit(0); // never block a completed npm publish
};

// Is the CLI present? spawnSync sets .error (ENOENT) when the binary is missing.
if (spawnSync(BIN, ["--help"], { stdio: "ignore" }).error) {
  skip(`\`${BIN}\` not found (install it, or set MCP_PUBLISHER_BIN)`);
}
if (!KEY) skip("MCP_REGISTRY_KEY is not set");

const run = (args) => {
  console.log(`→ ${BIN} ${args.map((a) => (a === KEY ? "***" : a)).join(" ")}`);
  const r = spawnSync(BIN, args, { stdio: "inherit", cwd: root });
  if (r.status !== 0) {
    console.error(
      `\n✖ MCP registry step failed (exit ${r.status}). npm publish already ` +
        `completed — fix the issue and re-run \`${BIN} publish\` from ${root}.\n`,
    );
    process.exit(r.status || 1);
  }
};

console.log(`\nPublishing org.imqueue/mcp@${version} to the MCP registry…`);
run(["login", METHOD, "--domain", DOMAIN, "--private-key", KEY]);
run(["publish"]);
console.log(`✔ MCP registry updated to ${version}\n`);
