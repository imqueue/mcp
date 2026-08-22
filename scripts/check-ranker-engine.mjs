#!/usr/bin/env node
// check-ranker-engine.mjs — is the ranker we pinned still the ranker that ships?
//
//   node scripts/check-ranker-engine.mjs
//
// NETWORKED, so it is not in `npm test` — that runs offline, and `npm run verify`
// is a publish gate that should not need GitHub to be up. It runs in checks.yml.
//
// WHAT IT IS FOR. The ranker is a submodule, and two repos pin it: imqueue.com
// takes ranker.js and search.js, this server takes ranker.js alone. Because they
// pin by COMMIT and consume different halves, the pins fall out of step on a commit
// to either half — in August 2026 they sat a fortnight apart with nothing red in
// either repo. That one was harmless, the divergent commit being search.js, and
// harmless is the problem: a signal that fires on a UI commit is one both repos
// learn to ignore, so the next divergence goes through on the same shrug.
//
// So this compares ENGINE_V, not the SHA. ENGINE_V moves only when the ANSWERS
// move, and the ranker repo's own CI enforces that. A UI-only commit never turns
// this red; when it does go red it means this server would answer a query
// differently from imqueue.org's own search box.
//
// This is the BUILD-time half. The runtime half is in src/ranker.ts, which compares
// the engine version stamped into each live feed against the bundled one and warns.
// Both are needed and neither is redundant: green CI on main says nothing about what
// the published package or the deployed Worker is actually running, because a repin
// only reaches production through `npm publish` and `deploy:worker`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = "https://raw.githubusercontent.com/imqueue/search-ranker/master/ranker.js";
const TIMEOUT_MS = 15000;

// Read as TEXT on both sides. The vendored copy could be require()d, but reading
// both the same way means one regex to be wrong in rather than two paths that can
// disagree — and fetching 2,900 lines of JavaScript to execute them for a version
// number would be a genuinely bad trade.
const DECLARATION = /^\s*var\s+ENGINE_V\s*=\s*(\d+)\s*;/m;

function declaredIn(source, where) {
  const m = DECLARATION.exec(source);

  if (!m) throw new Error(`${where} declares no ENGINE_V — the pin predates it, or the constant was renamed`);

  return Number(m[1]);
}

const vendored = declaredIn(
  readFileSync(join(ROOT, "vendor", "search-ranker", "ranker.js"), "utf8"),
  "vendor/search-ranker/ranker.js",
);

const res = await fetch(RAW, { signal: AbortSignal.timeout(TIMEOUT_MS) });

if (!res.ok) {
  // A GitHub outage is not a drift. Failing on one teaches everyone to re-run the
  // job until it passes, which is how a real failure gets clicked through too.
  console.error(`  SKIP  could not read ${RAW} (HTTP ${res.status}) — not treating an unreachable GitHub as a mismatch`);
  process.exit(0);
}

const upstream = declaredIn(await res.text(), "search-ranker@master");

if (upstream === vendored) {
  console.log(`  ok    engine v${vendored} — the pin matches search-ranker@master`);
  process.exit(0);
}

console.error(`  FAIL  search-ranker@master is engine v${upstream}; this repo pins v${vendored}.`);
console.error("");
console.error("        The engine's ANSWERS changed. Until this server repins, publishes and");
console.error("        redeploys, it ranks the live feeds with an older engine than the one that");
console.error("        built them — imqueue.org and search_docs can disagree about the same query.");
console.error("");
console.error("          git submodule update --remote vendor/search-ranker");
console.error("          npm run verify");
console.error("");
console.error("        imqueue.com owns the measurement (scripts/search-kpi). Read its paired");
console.error("        result before taking a ranking change here.");
process.exit(1);
