// Run every postpublish step, then report — instead of stopping at the first
// failure.
//
// WHY THIS EXISTS. `postpublish` used to be:
//
//   node scripts/deploy-worker.mjs && node scripts/publish-registry.mjs && node scripts/publish-github-release.mjs
//
// `&&` makes each step a gate on the next, and that is backwards here. The three
// steps are independent artifacts — the Cloudflare Worker, the MCP registry record,
// the GitHub Release — and they have deliberately different severities:
// deploy-worker.mjs exits non-zero on failure because leaving the hosted server on
// stale code affects every user, while the other two say in their own comments that a
// missed registry entry or release page is "cosmetic, fixable later".
//
// So the strictest step was silently able to cancel the other two. It happened on
// 3.2.1: the deploy succeeded, its smoke test was answered by an isolate still
// serving the previous version, deploy-worker exited 1, and the registry publish and
// the GitHub Release never ran. Neither did anything on that machine (both skip
// without credentials), but the release could just as easily have been published to
// npm with a registry record still pointing at the old version and no release notes.
//
// Every step now runs. The exit code is still non-zero if any of them failed, so a
// broken release is never silent — it just is not allowed to hide the other two.
//
// Ordering is deliberate: the deploy goes first because it is the one users feel, and
// because if the whole machine is misconfigured it is better to learn that before
// touching a public registry.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STEPS = [
  { name: "Cloudflare Worker", script: "deploy-worker.mjs", critical: true },
  { name: "MCP registry", script: "publish-registry.mjs", critical: false },
  { name: "GitHub Release", script: "publish-github-release.mjs", critical: false },
];

const results = [];

for (const step of STEPS) {
  const { status, error } = spawnSync("node", [join("scripts", step.script)], {
    stdio: "inherit",
    cwd: root,
  });

  results.push({
    ...step,
    // A step that could not even be spawned is a failure, not a skip.
    ok: !error && status === 0,
    detail: error ? error.message : `exit ${status}`,
  });
}

const failed = results.filter((r) => !r.ok);

console.log("\npostpublish summary");

for (const r of results) {
  console.log(`  ${r.ok ? "✔" : "✖"} ${r.name}${r.ok ? "" : ` — ${r.detail}`}`);
}

if (!failed.length) {
  console.log("\nAll postpublish steps completed.\n");
  process.exit(0);
}

// npm publish has already completed by the time any of this runs, so nothing here
// can undo the release. A non-zero exit exists to make the gap visible and to name
// exactly which command to re-run.
console.error(
  `\n✖ ${failed.length} postpublish step(s) failed. The npm publish itself succeeded.\n`
    + failed.map((r) => `    re-run:  node scripts/${r.script}`).join("\n")
    + "\n",
);

process.exit(1);
