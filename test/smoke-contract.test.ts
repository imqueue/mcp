// The two smoke scripts must not assert the same thing twice.
//
// scripts/smoke.mjs drives the local build over stdio; scripts/remote-smoke.mjs
// drives the deployed Worker over HTTPS. Both are wanted — a local pass does not
// prove the deployment agrees — but the properties that are the SAME property
// against two targets used to be copied into both files, with a comment asking
// whoever edited one to remember the other.
//
// That convention failed twice:
//
//   * `no blog post outranks a doc page` was removed from smoke.mjs and left in
//     remote-smoke.mjs. The local gate went green, `npm publish` proceeded, and
//     the HOSTED gate failed after the package was already on the registry.
//   * `get_doc schema carries the page body, not just metadata` drifted into two
//     different assertions under one label — one required `markdown` AND `url`,
//     the other only `markdown`.
//
// The shared properties now live in scripts/lib/contract.mjs. This test is what
// stops them being copied back: a label declared inline in BOTH scripts is a
// duplicate by construction, because anything both targets assert belongs in the
// module instead.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

/** Every assertion label a script declares INLINE — not the ones it imports. */
function inlineLabels(file: string): Set<string> {
  const source = readFileSync(join(SCRIPTS, file), "utf8");

  return new Set(
    [...source.matchAll(/check\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]),
  );
}

test("no assertion label is declared inline in both smoke scripts", () => {
  const local = inlineLabels("smoke.mjs");
  const hosted = inlineLabels("remote-smoke.mjs");
  const both = [...local].filter((label) => hosted.has(label)).sort();

  assert.deepEqual(
    both,
    [],
    `declared in both scripts — move to scripts/lib/contract.mjs:\n  ${both.join("\n  ")}`,
  );
});

test("both smoke scripts assert the shared contract", () => {
  for (const file of ["smoke.mjs", "remote-smoke.mjs"]) {
    const source = readFileSync(join(SCRIPTS, file), "utf8");

    assert.match(source, /from "\.\/lib\/contract\.mjs"/, `${file} does not import the shared contract`);

    // Named, so deleting a shared assertion from one target is a test failure
    // rather than a silent narrowing of what that target checks.
    for (const fn of ["assertHandshake", "assertGetDocSchema", "assertQuestionRanking"]) {
      assert.ok(source.includes(fn), `${file} does not call ${fn}`);
    }
  }
});
