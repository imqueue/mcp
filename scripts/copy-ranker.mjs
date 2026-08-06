// Put the search ranker where both builds can import it.
//
// The ranker is github.com/imqueue/search-ranker, pinned as a submodule at
// vendor/search-ranker and pinned identically by the imqueue.com repo. That is the
// point: this server and the website answer the same query with the same code. It is
// not on npm and it is not fetched at runtime — see SPEC.md and the plan for why
// fetching executable code from a website is the one thing this must never do.
//
// TWO PROBLEMS, ONE COPY.
//
// 1. `tsc` with rootDir "src" emits .ts -> .js and copies nothing else, and
//    package.json publishes `files: ["dist"]`. So without a copy step the PUBLISHED
//    server has no ranker while the local checkout works perfectly — the worst shape
//    of bug this repo can ship, and the reason the import in src/ranker.ts is static.
//
// 2. This package is `"type": "module"`. Node therefore reads any .js inside it as
//    ESM, and the ranker is CommonJS (it assigns `module.exports` when there is a
//    `module` to assign to). Imported as .js it would not fail loudly — `module` is
//    simply not defined in an ES module, so it throws at load with a message about
//    `module` rather than about the ranker. Hence the .cjs extension: it is what
//    tells Node the truth about the file, and it costs nothing else.
//
// ONE HALF OF TWO. Since 2026-08-06 the submodule holds ranker.js — a scoring engine
// with no DOM and no network in it — and search.js, imqueue's browser UI. This server
// wants the engine and only the engine: the UI is 1,150 lines of dialog, analytics and
// feed URLs that could not survive `require()` and were never reachable from here. The
// website serves the two concatenated into one asset; this copies one of them.
//
// The destination is inside src/ because that is the only tree tsc maps into dist/,
// which is what lets ONE import specifier — "./search-ranker.cjs" — resolve for all
// three consumers: tsx running from src, node running from dist, and esbuild
// bundling the Worker. The copy in src/ is generated and gitignored; the copy in
// dist/ is what ships.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "vendor", "search-ranker", "ranker.js");
const TARGETS = [join(ROOT, "src", "search-ranker.cjs"), join(ROOT, "dist", "search-ranker.cjs")];

if (!existsSync(SOURCE)) {
  console.error(
    `The search ranker is missing: vendor/search-ranker/ranker.js\n\n`
      + "It is a git submodule (github.com/imqueue/search-ranker), and a plain `git clone`\n"
      + "does not populate it. Run:\n\n"
      + "    git submodule update --init\n\n"
      + "or clone with `--recurse-submodules` next time.\n\n"
      + "If the directory IS populated and holds only search.js, the submodule is pinned to a\n"
      + "commit from before the engine was split out of the UI — update the pin.",
  );
  process.exit(1);
}

const source = readFileSync(SOURCE, "utf8");

// Refuse a ranker that would not export anything under Node. This is the branch the
// browser never takes, so it is the branch a well-meaning edit can delete without the
// website noticing. Cheap to assert here, expensive to discover in a Worker.
if (!source.includes("module.exports")) {
  console.error(
    "vendor/search-ranker/ranker.js no longer exports itself under Node.\n\n"
      + "This server imports the ranker as a CommonJS module; the file must keep the\n"
      + "`module.exports = API` branch of its export tail. If the ranker changed shape on\n"
      + "purpose, update src/ranker.ts and src/search-ranker.d.cts with it.",
  );
  process.exit(1);
}

// And refuse an engine that has grown a DOM. `document` is the discriminator: it appears
// nowhere in a scorer, and its arrival means UI code has crossed back over the split —
// which here is not a style problem but a deploy failure, because the Worker this bundles
// into has no `document` and would throw at load. The website would not notice: it has
// one. imqueue.com asserts the same thing from the other side, in
// scripts/check-search-ranker.js, so neither repo depends on the other having run.
if (/\bdocument\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, ""))) {
  console.error(
    "vendor/search-ranker/ranker.js references `document`.\n\n"
      + "The engine half must stay loadable outside a browser — this server bundles it into a\n"
      + "Cloudflare Worker, where `document` throws at load. Whatever needs a DOM belongs in\n"
      + "the submodule's search.js, which this server does not copy.",
  );
  process.exit(1);
}

for (const target of TARGETS) {
  // dist/ does not exist before the first tsc run, and this script runs before it so
  // that a missing ranker stops the build at the cheapest possible moment.
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(SOURCE, target);
}

console.log(`ranker: copied ranker.js -> src/ and dist/search-ranker.cjs`);
