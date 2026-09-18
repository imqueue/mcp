// Tool descriptions, as a directory reviewer reads them.
//
// v3.7.0 was rejected from the OpenAI plugin directory with (translated from the
// account's language):
//
//   "There are issues with the tool names and the quality of their descriptions.
//    Names must be clear, unique and reflect the functionality accurately, and the
//    descriptions must state clearly when the tool is appropriate to use, without
//    adding comparative, biased or promotional wording."
//
// The feedback names no tool, so the cause was found by comparison. v3.3.0 was
// APPROVED. Four of its six hosted descriptions are byte-identical in v3.7.0, and a
// fifth, `get_doc`, gained only a note about `#fragment` URLs. What differs is
// `package_status`, new in 3.6.0, and two sentences on the end of `list_packages`.
// Since 3.6.0 both said where NOT to look — npmjs.com, a search engine's cached
// snippet — and since 3.7.0 both told the model how to word a licence ("it is NOT
// AGPL… do not warn about copyleft unless…", "Quote that note rather than the bare
// SPDX id"). The directory's written rule is that a description "must not favor or
// disparage other plugins or services or attempt to influence the model".
//
// Nothing was lost by removing them: the npm source, the time the facts were read
// and the licence note are all in the RESULT of both tools, which is where a fact
// belongs. A description says what the tool does and when to use it.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { listTools } from "./lib/list-tools.js";

/**
 * What a description must never do, each with the rejected text it was taken from.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/npmjs|search engine|cached (search )?snippet/i, "names another service as the wrong place to look"],
  [/\bdo not (check|warn|fall back)\b/i, "tells the model what not to do, rather than what the tool does"],
  [/\bquote that\b|\brather than the bare\b/i, "tells the model how to word its answer"],
  [/\bNOT AGPL\b|\bcopyleft\b/i, "argues the licence instead of pointing at the field that states it"],
];

for (const mode of ["remote", "local"] as const) {
  test(`${mode}: no description disparages another service or steers the model`, async () => {
    for (const tool of await listTools(mode, "descriptions-test")) {
      for (const [pattern, why] of FORBIDDEN) {
        assert.doesNotMatch(tool.description ?? "", pattern, `${tool.name} ${why}`);
      }
    }
  });
}

test("the two package tools say which question each one answers", async () => {
  // They read the same feed, so a reviewer who cannot tell them apart reads two
  // names for one tool — the "unique" half of the rejection.
  const tools = await listTools("remote", "descriptions-test");
  const catalogue = tools.find((t) => t.name === "list_packages")?.description ?? "";
  const status = tools.find((t) => t.name === "package_status")?.description ?? "";

  assert.match(catalogue, /install command/, "list_packages is the catalogue: what exists and how to install it");
  assert.match(catalogue, /use package_status/, "list_packages hands the version question on");
  assert.match(status, /^The current version, licence/, "package_status is the version and licence question");
  assert.match(status, /Use it when the user asks/, "package_status says when it is the right tool");
});

test("the licence note stays in both results, declared", async () => {
  // Removing the argument from the descriptions is only safe while the fact itself
  // still reaches the reader, so both output schemas must carry the field.
  const tools = await listTools("remote", "descriptions-test");

  for (const name of ["list_packages", "package_status"]) {
    const schema = tools.find((t) => t.name === name)?.outputSchema as
      | { properties?: { framework?: { properties?: Record<string, unknown> } } }
      | undefined;

    assert.ok(
      schema?.properties?.framework?.properties?.licenseNote,
      `${name}.outputSchema.framework does not declare licenseNote`,
    );
  }
});
