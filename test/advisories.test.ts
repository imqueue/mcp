// Mutually exclusive packages, and why the rule must travel with the results.
//
// `search_docs "tracing"` returns six @imqueue/datadog symbols and no
// @imqueue/opentelemetry, because datadog's symbols are literally named `Tracing*`.
// No term weighting fixes that. The mitigation was a sentence in search_docs'
// description telling the caller to get the choosing rule from list_packages — and
// when actually asked "which @imqueue package should I use for tracing?", ChatGPT
// answered:
//
//     Use @imqueue/datadog for distributed tracing.
//     npm install @imqueue/datadog dd-trace
//
// The wrong one of the two, plus the dependency @imqueue/datadog exists to replace,
// and list_packages was never called. A mitigation that needs the model to read prose
// and then choose to make a second call is not a mitigation, so the rule now ships
// inside the search response.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EXCLUSIVE_PAIRS, PACKAGES, exclusiveAdvisories } from "../src/packages.js";
import { createServer } from "../src/server.js";

test("a result set from one half of a pair names both halves", () => {
  const advisories = exclusiveAdvisories(
    "API · @imqueue/datadog class https://imqueue.org/api/datadog/latest/datadog.tracingplugin/",
  );

  assert.equal(advisories.length, 1);
  // Both options, so the reader is not left to infer the alternative exists.
  assert.match(advisories[0], /@imqueue\/opentelemetry/);
  assert.match(advisories[0], /@imqueue\/datadog/);
  // The default, in the project's own words.
  assert.match(advisories[0], /default choice for tracing/);
  // The failure mode, because it is silent.
  assert.match(advisories[0], /Never both/);
  // The install command for each, so nothing has to be guessed.
  assert.match(advisories[0], /npm i @imqueue\/opentelemetry/);
});

test("it stays quiet when no pair is involved", () => {
  assert.deepEqual(
    exclusiveAdvisories("API · @imqueue/core method https://imqueue.org/api/core/latest/core.redisqueue.send/"),
    [],
  );
});

test("it matches by /api/ path as well as by package name", () => {
  // Symbol sections carry `@imqueue/<pkg>`; curated package indexes carry the path.
  assert.equal(exclusiveAdvisories("https://imqueue.org/api/pg-sequelize/latest/").length, 1);
  assert.equal(exclusiveAdvisories("Reference · @imqueue/pg-prisma").length, 1);
});

test("every pair member exists in the catalogue and states a rule", () => {
  // An advisory rendered from a missing entry would silently degrade to a bare name,
  // which is worse than nothing: it would assert a choice without explaining it.
  for (const pair of EXCLUSIVE_PAIRS) {
    for (const name of pair) {
      const info = PACKAGES.find((p) => p.name === name);
      const other = pair.find((n) => n !== name);

      assert.ok(info, `${name} is in EXCLUSIVE_PAIRS but not in PACKAGES`);
      assert.ok(other, `${name} has no counterpart — a pair must have two members`);
      assert.ok(info.pick, `${name} is one of an exclusive pair but has no \`pick\` rule`);
      // Phrasing-independent, and the thing that actually matters: a rule that does
      // not name the alternative cannot be used to choose between them.
      assert.ok(
        info.pick.includes(other),
        `${name}'s pick rule never mentions ${other}, so it cannot be used to choose`,
      );
    }
  }
});

test("search_docs declares advisories in its output schema", async () => {
  const server = createServer({ version: "0.0.0-test", mode: "remote" });
  const client = new Client({ name: "advisories-test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(b), client.connect(a)]);

  const { tools } = await client.listTools();
  const search = tools.find((t) => t.name === "search_docs");

  await client.close();

  assert.ok(search?.outputSchema);

  const props = (search.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};

  // A client consuming structure rather than prose must be able to find the rule too.
  assert.ok("advisories" in props, "search_docs does not declare `advisories`");
});
