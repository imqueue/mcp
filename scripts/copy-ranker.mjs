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
//    ESM, and the ranker is CommonJS (it assigns `module.exports` when it sees no
//    `document`). Imported as .js it would not fail loudly — `module` is simply not
//    defined in an ES module, so it throws at load with a message about `module`
//    rather than about the ranker. Hence the .cjs extension: it is what tells Node
//    the truth about the file, and it costs nothing else.
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
const SOURCE = join(ROOT, "vendor", "search-ranker", "search.js");
const TARGETS = [join(ROOT, "src", "search-ranker.cjs"), join(ROOT, "dist", "search-ranker.cjs")];

if (!existsSync(SOURCE)) {
  console.error(
    `The search ranker is missing: vendor/search-ranker/search.js\n\n`
      + "It is a git submodule (github.com/imqueue/search-ranker), and a plain `git clone`\n"
      + "does not populate it. Run:\n\n"
      + "    git submodule update --init\n\n"
      + "or clone with `--recurse-submodules` next time.",
  );
  process.exit(1);
}

// Refuse a ranker that would not export anything under Node. The file serves two
// environments from one source, and the branch this server depends on is the one the
// browser never takes — so it is the branch a well-meaning edit can delete without
// the website noticing. Cheap to assert here, expensive to discover in a Worker.
const source = readFileSync(SOURCE, "utf8");

if (!source.includes("typeof document === \"undefined\"") || !source.includes("module.exports")) {
  console.error(
    "vendor/search-ranker/search.js no longer exports itself under Node.\n\n"
      + "This server imports the ranker as a CommonJS module; the file must keep its\n"
      + "`if (typeof document === \"undefined\") { module.exports = … }` branch. If the ranker\n"
      + "changed shape on purpose, update src/ranker.ts and src/search-ranker.d.cts with it.",
  );
  process.exit(1);
}

for (const target of TARGETS) {
  // dist/ does not exist before the first tsc run, and this script runs before it so
  // that a missing ranker stops the build at the cheapest possible moment.
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(SOURCE, target);
}

console.log(`ranker: copied search.js -> src/ and dist/search-ranker.cjs`);
