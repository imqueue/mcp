// The dialect every advertised schema declares, read off the real wire.
//
// THIS IS THE TEST WHOSE ABSENCE COST THE DOCS TOOLS IN CLAUDE CODE. The SDK
// labels every schema it generates `http://json-schema.org/draft-07/schema#`, and
// the Claude Code / Agent SDK client refuses any tool whose `outputSchema` declares
// a dialect other than 2020-12:
//
//   Tool 'search_docs' has an invalid outputSchema: JSON Schema declares an
//   unsupported dialect (...). The default validator supports JSON Schema 2020-12 only
//
// So search_docs, get_doc, list_packages and both scaffolders errored on call —
// five of the six tools the hosted endpoint advertises — while every test here was
// green and both smoke scripts passed. They were green because they all speak to
// the SDK's own client, which accepts what the SDK emits. Nothing looked at the
// label.
//
// Asserted through an in-memory client for the same reason annotations.test.ts is:
// what a strict client rejects is the serialised `tools/list` output, not an
// internal field.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { DIALECT, toCurrentDialect } from "../src/schema-dialect.js";
import { listTools } from "./lib/list-tools.js";

/** Every `$schema` in the tree, with the root's first. */
function dialects(schema: unknown): { root: unknown; nested: unknown[] } {
  const nested: unknown[] = [];
  const walk = (node: unknown, root: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, false);

      return;
    }
    if (!node || typeof node !== "object") return;

    const obj = node as Record<string, unknown>;

    if (!root && "$schema" in obj) nested.push(obj.$schema);

    for (const [key, value] of Object.entries(obj)) {
      if (key !== "$schema") walk(value, false);
    }
  };

  walk(schema, true);

  return { root: (schema as Record<string, unknown>)?.$schema, nested };
}

for (const mode of ["local", "remote"] as const) {
  test(`${mode}: every advertised schema declares 2020-12`, async () => {
    const tools = await listTools(mode);

    assert.ok(tools.length > 0, "no tools advertised");

    for (const tool of tools) {
      // inputSchema is mandatory on every tool; outputSchema is not, and the CLI
      // tools deliberately have none.
      const found = dialects(tool.inputSchema);

      assert.equal(found.root, DIALECT, `${tool.name}: inputSchema declares ${String(found.root)}`);
      assert.deepEqual(found.nested, [], `${tool.name}: inputSchema has a nested $schema`);

      if (!tool.outputSchema) continue;

      const out = dialects(tool.outputSchema);

      assert.equal(out.root, DIALECT, `${tool.name}: outputSchema declares ${String(out.root)}`);
      assert.deepEqual(out.nested, [], `${tool.name}: outputSchema has a nested $schema`);
    }
  });
}

test("the relabel refuses a schema whose meaning would change", () => {
  // The relabel is only honest while the schemas read the same under both drafts.
  // These are the ways a zod shape can produce one that does not — each must throw
  // rather than get a 2020-12 label stuck on it.
  const cases: Array<[string, unknown]> = [
    ["definitions", { type: "object", definitions: { X: { type: "string" } } }],
    ["dependencies", { type: "object", dependencies: { a: ["b"] } }],
    ["boolean exclusiveMinimum", { type: "number", minimum: 0, exclusiveMinimum: true }],
    ["tuple items", { type: "array", items: [{ type: "string" }, { type: "number" }] }],
    ["nested definitions", { type: "object", properties: { p: { definitions: {} } } }],
  ];

  for (const [what, schema] of cases) {
    assert.throws(() => toCurrentDialect(schema, "test_tool"), /cannot advertise this schema/, what);
  }
});

test("the relabel leaves a compatible schema saying the same thing", () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { q: { type: "string", description: "a query" }, n: { type: "number", exclusiveMinimum: 0 } },
    required: ["q"],
    additionalProperties: false,
  };

  toCurrentDialect(schema, "test_tool");

  assert.equal(schema.$schema, DIALECT);
  assert.deepEqual(schema.required, ["q"]);
  assert.equal(schema.properties.q.description, "a query");
  // A NUMERIC exclusiveMinimum means the same in both drafts and must survive.
  assert.equal(schema.properties.n.exclusiveMinimum, 0);
});
