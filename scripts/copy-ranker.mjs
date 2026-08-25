// Put the search ranker where both builds can import it.
//
// The ranker is github.com/imqueue/search-ranker, pinned as a submodule at
// vendor/search-ranker and pinned by the imqueue.com repo too. The intent is that
// this server and the website answer the same query with the same code. It is not
// on npm and it is not fetched at runtime — see SPEC.md and the plan for why
// fetching executable code from a website is the one thing this must never do.
//
// THE TWO PINS ARE NOT ENFORCED EQUAL, and this comment used to say they were. They
// sat apart for a fortnight in August 2026 and nothing noticed, here or there,
// because nothing compares them — it was harmless only by luck, the divergent commit
// having touched search.js, the UI half this script does not copy. Read the claim
// above as the goal, not as a guarantee.
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
// ONE HALF OF TWO. Since 2026-08-06 the submodule holds an engine — a scorer with no DOM
// and no network in it — and imqueue's browser UI. This server wants the engine and only
// the engine: the UI is a dialog, analytics and feed URLs that could not survive
// `require()` and were never reachable from here. The website serves the two concatenated
// into one asset; this copies one of them.
//
// AND IT IS BUILT NOW. The ranker was rewritten in TypeScript, so the two files are
// dist/ranker.js and dist/search.js, produced by the submodule's own `npm run build` and
// deliberately not committed to it — a generated file in git is a second copy of the source
// that can disagree with it. Nothing about what is copied changed: dist/ranker.js is the
// same IIFE assigning the same `module.exports` under Node.
//
// The destination is inside src/ because that is the only tree tsc maps into dist/,
// which is what lets ONE import specifier — "./search-ranker.cjs" — resolve for all
// three consumers: tsx running from src, node running from dist, and esbuild
// bundling the Worker. The copy in src/ is generated and gitignored; the copy in
// dist/ is what ships.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RANKER_DIR = join(ROOT, "vendor", "search-ranker");
const RANKER_MANIFEST = join(RANKER_DIR, "package.json");
const SOURCE = join(RANKER_DIR, "dist", "ranker.js");
const SOURCE_REL = "vendor/search-ranker/dist/ranker.js";
const TARGETS = [join(ROOT, "src", "search-ranker.cjs"), join(ROOT, "dist", "search-ranker.cjs")];

// POPULATE THE SUBMODULE RATHER THAN LECTURE ABOUT IT. Telling a human to run
// `git submodule update --init` works; telling a build robot does not. The MCP
// directories (glama.ai, Smithery and anyone else building from source) generate their
// own Dockerfile around a plain `git clone` + `git checkout <sha>`, which leaves the
// gitlink empty, and this script was the first thing to notice — so the published
// server built fine from npm while every directory's build failed on the same line.
//
// We cannot edit their Dockerfile, so the repo has to be clonable the way they clone it.
// The conditions are all met inside such a build: it IS a git checkout (they cloned it),
// .gitmodules and the pinned SHA are in the tree, the submodule is public, and the step
// has network — it just ran npm install. Nothing here fetches anything the build did not
// already require: same URL, same pinned commit, same code the error message asked for.
//
// This runs only when the ranker is absent, so a populated checkout is never touched, and
// a failure (no git, no network, a private-mirror clone) falls through to the message
// below exactly as before.
function populateSubmodule() {
  // `.git` is a directory in a normal clone and a file in a worktree or submodule; both
  // are checkouts. Neither exists in an unpacked tarball, where git cannot help us.
  if (!existsSync(join(ROOT, ".git"))) return false;

  try {
    execFileSync("git", ["-C", ROOT, "submodule", "update", "--init", "vendor/search-ranker"], {
      stdio: "inherit",
    });
  } catch {
    return false;
  }

  return checkedOut();
}

/**
 * Is the submodule checked out at all, in EITHER layout?
 *
 * Not "does dist/ranker.js exist", and not "does package.json exist": a pin from before the
 * TypeScript rewrite is fully checked out and has neither. Conflating the three is how a
 * populated directory gets reported as an empty one, with an instruction that does nothing.
 */
const checkedOut = () =>
  existsSync(RANKER_MANIFEST) || existsSync(join(RANKER_DIR, "ranker.js"));

// BUILD IT RATHER THAN LECTURE ABOUT IT, for exactly the reason populateSubmodule() exists.
// The ranker's build output is not committed, so a checkout — however it was obtained — has
// src/ and no dist/, and telling a build robot to go and run two commands works no better
// here than telling it to initialise a submodule did. Every condition is already met inside
// such a build: the submodule is checked out, its lockfile is in the tree, and npm just ran.
//
// A failure falls through to the message below, which names the two commands, exactly as the
// submodule case does.
function buildSubmodule() {
  if (!existsSync(RANKER_MANIFEST)) return false;

  try {
    if (!existsSync(join(RANKER_DIR, "node_modules"))) {
      execFileSync("npm", ["ci"], { cwd: RANKER_DIR, stdio: "inherit" });
    }

    execFileSync("npm", ["run", "build"], { cwd: RANKER_DIR, stdio: "inherit" });
  } catch {
    return false;
  }

  return existsSync(SOURCE);
}

// THREE STATES, and they are not interchangeable: an empty directory needs git, a checked-out
// one needs a build, and a pre-rewrite pin needs the pin moved. Reported separately because
// the wrong instruction sends someone to look for a problem that is not there.
if (!existsSync(SOURCE)) {
  if (!checkedOut()) {
    populateSubmodule();
  }

  if (checkedOut() && !existsSync(RANKER_MANIFEST)) {
    console.error(
      "The search ranker pin predates its TypeScript rewrite.\n\n"
        + "vendor/search-ranker/ holds the old layout — ranker.js at its root, no package.json —\n"
        + `and this server now copies the built ${SOURCE_REL}. Move the pin:\n\n`
        + "    git submodule update --remote vendor/search-ranker\n",
    );
    process.exit(1);
  }

  if (!buildSubmodule()) {
    console.error(
      `The search ranker is missing: ${SOURCE_REL}\n\n`
        + "It is a git submodule (github.com/imqueue/search-ranker), and that file is BUILD\n"
        + "output — a plain `git clone` does not populate the submodule, and a populated one\n"
        + "has src/ and no dist/ until it is built. This script just tried to do both for you\n"
        + "and could not — no git, no network, or this is not a git checkout. Run:\n\n"
        + "    git submodule update --init\n"
        + "    npm --prefix vendor/search-ranker ci && npm --prefix vendor/search-ranker run build\n\n"
        + "or clone with `--recurse-submodules` next time.",
    );
    process.exit(1);
  }
}

const source = readFileSync(SOURCE, "utf8");

// Refuse a ranker that would not export anything under Node. This is the branch the
// browser never takes, so it is the branch a well-meaning edit can delete without the
// website noticing. Cheap to assert here, expensive to discover in a Worker.
if (!source.includes("module.exports")) {
  console.error(
    `${SOURCE_REL} no longer exports itself under Node.\n\n`
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
// scripts/check-search-ranker.ts, so neither repo depends on the other having run.
//
// Upstream now compiles the engine without the DOM lib at all, which makes this hard to
// violate in the SOURCE. It is asserted here anyway because what this copies is a BUNDLE:
// a build reconfigured to pull the UI's modules in would produce an artifact nobody had
// looked at, and this file is what would ship it into a Worker.
if (/\bdocument\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, ""))) {
  console.error(
    `${SOURCE_REL} references \`document\`.\n\n`
      + "The engine half must stay loadable outside a browser — this server bundles it into a\n"
      + "Cloudflare Worker, where `document` throws at load. Whatever needs a DOM belongs in\n"
      + "the submodule's src/ui/, which this server does not copy.",
  );
  process.exit(1);
}

for (const target of TARGETS) {
  // dist/ does not exist before the first tsc run, and this script runs before it so
  // that a missing ranker stops the build at the cheapest possible moment.
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(SOURCE, target);
}

console.log(`ranker: copied ${SOURCE_REL} -> src/ and dist/search-ranker.cjs`);
