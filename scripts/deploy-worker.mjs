// Deploy the hosted MCP server (Cloudflare Worker) after a successful
// `npm publish`, then verify the live endpoint actually serves this version.
//
// Wired as part of the npm `postpublish` lifecycle hook, alongside the MCP
// registry publish and the GitHub Release.
//
// WHY this exists: the Worker at https://mcp.imqueue.org is a SEPARATE artifact
// from the npm package. Wrangler bundles `worker/worker.ts` + `src/`, while the
// tarball builds `src/` only, so `npm publish` does nothing to the hosted
// endpoint. Before this was automated it sat five releases behind npm — serving
// 2.0.0 while npm was on 2.0.5 — handing out scaffolds that no longer compiled.
//
// Deploying from `postpublish` (rather than from CI on the release event) means
// wrangler bundles the very same working tree npm just packed, so the tarball
// and the Worker cannot disagree.
//
// Requirements on the publishing machine:
//   - wrangler authenticated for the account holding the imqueue.org zone:
//       npx wrangler login     (one-off; `npx wrangler whoami` to check)
//     An OAuth login needs the `workers_scripts:write` scope, which the default
//     login grants. CI would instead set CLOUDFLARE_API_TOKEN +
//     CLOUDFLARE_ACCOUNT_ID, which wrangler picks up automatically.
// Optional overrides:
//   - MCP_WORKER_URL       endpoint to verify (default: https://mcp.imqueue.org/mcp)
//   - MCP_WORKER_TRIES     verification attempts (default: 20)
//   - MCP_WORKER_DELAY_MS  delay between attempts (default: 3000)
//   - MCP_WORKER_SKIP      set to any value to skip the deploy entirely
//
// NOTE: unlike its two sibling postpublish scripts, a real failure here exits
// non-zero instead of warning and exiting 0. Those two leave an out-of-date
// registry entry or a missing release — cosmetic, fixable later. This one
// leaves the hosted server serving stale code to every user of
// mcp.imqueue.org, which is worth interrupting for. npm publish has already
// completed regardless; a non-zero exit only makes the problem visible.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const isPrerelease = version.includes("-"); // e.g. 2.1.0-beta.1

const URL_ = process.env.MCP_WORKER_URL || "https://mcp.imqueue.org/mcp";
const TRIES = Number(process.env.MCP_WORKER_TRIES || 20);
const DELAY = Number(process.env.MCP_WORKER_DELAY_MS || 3000);

const skip = (why) => {
  console.warn(`\n⚠  Worker deploy skipped — ${why}.`);
  console.warn("   npm publish succeeded; the hosted server is just not updated here.");
  console.warn(`   To deploy manually:  cd ${root} && npm run deploy:worker\n`);
  process.exit(0);
};

const fail = (msg) => {
  console.error(
    `\n✖ Worker deploy failed — ${msg}\n` +
      `  npm publish already completed, so npm serves ${version} while\n` +
      `  ${URL_} does NOT. Fix the issue and re-run:\n` +
      `    cd ${root} && npm run deploy:worker\n`,
  );
  process.exit(1);
};

if (process.env.MCP_WORKER_SKIP) skip("MCP_WORKER_SKIP is set");
// Pre-releases must not take over the production endpoint; ship them by hand.
if (isPrerelease) skip(`${version} is a pre-release`);

console.log(`\nDeploying the hosted MCP server (${version}) to Cloudflare…`);

// Type-check first: the same gate worker/README.md tells a human to run. The
// Worker has its own tsconfig and is NOT covered by `prepublishOnly`'s build.
console.log("→ npm run typecheck:worker");
if (spawnSync("npm", ["run", "typecheck:worker"], { stdio: "inherit", cwd: root }).status !== 0) {
  fail("the Worker does not type-check (nothing was deployed)");
}

console.log("→ npx wrangler deploy");
const deploy = spawnSync("npx", ["wrangler", "deploy"], { stdio: "inherit", cwd: root });
if (deploy.error) fail(`could not run wrangler (${deploy.error.message})`);
if (deploy.status !== 0) {
  fail(
    `\`wrangler deploy\` exited ${deploy.status} — if it complains about ` +
      `authentication, run \`npx wrangler login\``,
  );
}

// A green `wrangler deploy` is NOT proof the endpoint moved: it means Cloudflare
// accepted an upload. Poll the real MCP handshake until serverInfo.version
// matches, so a deploy that didn't take effect is loud instead of invisible.
// That unverified gap is exactly how five releases of drift went unnoticed.
const liveVersion = async () => {
  const res = await fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "postpublish", version: "0" },
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  // The transport may answer with plain JSON or an SSE `data:` frame.
  const framed = text.match(/^data:\s*(.*)$/m);
  return JSON.parse(framed ? framed[1] : text)?.result?.serverInfo?.version;
};

console.log(`\nVerifying ${URL_} serves ${version}…`);
for (let i = 1; i <= TRIES; i++) {
  let live;
  try {
    live = await liveVersion();
  } catch (e) {
    live = `no response (${e.message})`;
  }
  if (live === version) {
    console.log(`✔ ${URL_} is live on ${version} (attempt ${i})\n`);
    process.exit(0);
  }
  if (i < TRIES) {
    console.log(`  waiting for propagation… got '${live}' (${i}/${TRIES})`);
    await new Promise((r) => setTimeout(r, DELAY));
  } else {
    fail(`it still reports '${live}' after ${TRIES} attempts — the deploy did not take effect`);
  }
}
