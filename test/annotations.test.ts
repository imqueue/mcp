// Tool annotations, read off the real wire.
//
// THIS IS THE TEST WHOSE ABSENCE COST A DIRECTORY LISTING. v3.1.1 was rejected from
// the OpenAI plugin directory with:
//
//   "One or more of your tool's annotations do not appear to match the tool's
//    behavior. Please confirm annotations are explicitly set to true or false (not
//    null) for every tool."
//
// The cause was mechanical: the spec defines FOUR hints and the server set three.
// `idempotentHint` was absent — not false, absent — on all thirteen tools. Both
// smoke scripts checked `readOnlyHint`, `destructiveHint` and `openWorldHint` and
// were green, so nothing anywhere looked at the fourth.
//
// Asserted through an in-memory client rather than by reading the server's private
// fields, because what a reviewer inspects is `tools/list` output. A hint that is
// set internally but not serialised would pass an introspection test and fail the
// review again.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, type CliHandlers } from "../src/server.js";

/** Every hint the spec defines. The whole point is that none may be missing. */
const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/** Stub handlers, so local mode registers the CLI tools without an `imq` binary. */
const stubCli = new Proxy({}, { get: () => async () => "" }) as CliHandlers;

async function listTools(mode: "local" | "remote") {
  const server = createServer({ version: "0.0.0-test", mode, cli: mode === "local" ? stubCli : undefined });
  const client = new Client({ name: "annotations-test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const { tools } = await client.listTools();

  await client.close();

  return tools;
}

/**
 * The values every tool must serialise, as a table rather than as logic — so a
 * change of judgement has to be made deliberately, in both places, and shows up in
 * a diff as a claim about behaviour.
 *
 * [readOnly, destructive, idempotent, openWorld]
 */
const EXPECTED: Record<string, [boolean, boolean, boolean, boolean]> = {
  // Reads live pages from imqueue.org / imqueue.com: open-world. Idempotent because
  // reading changes nothing, so a second identical call adds no effect — which is a
  // different question from whether the bytes are the same.
  search_docs: [true, false, true, true],
  get_doc: [true, false, true, true],
  // Renders a catalogue compiled into the build: closed world.
  list_packages: [true, false, true, false],
  // Return generated source TEXT. The names say "scaffold", which in most tooling
  // means writing files — hence the descriptions now lead with READ-ONLY.
  scaffold_service: [true, false, true, false],
  scaffold_client: [true, false, true, false],
  // Static text.
  local_install_guide: [true, false, true, false],
  // Inspects a local binary; shells out read-only.
  cli_status: [true, false, true, false],
  cli_help: [true, false, true, false],
  // Writes a project, and with apply=true can push to a remote. NOT idempotent: a
  // second apply meets a populated directory and can create a second repository.
  create_service: [false, false, false, true],
  // Overwrites two files at a fixed path, so a repeat leaves the same state.
  generate_client: [false, false, true, true],
  // Replaces whatever `imq` was installed; installing the same version twice lands
  // the same binary, so the destruction is all in the first call.
  cli_install: [false, true, true, true],
  // `restart` twice really does restart twice — new processes, in-flight work
  // dropped again.
  fleet: [false, true, false, false],
  // `init` rewrites the config file and is interactive, so a repeat is not a no-op.
  config: [false, true, false, false],
  // A running fleet writes logs continuously, so a second `clean` deletes DIFFERENT
  // data rather than the same data again. A client must not auto-retry it.
  logs: [false, true, false, false],
};

for (const mode of ["remote", "local"] as const) {
  test(`${mode}: every tool sets all four hints to a boolean`, async () => {
    const tools = await listTools(mode);

    assert.ok(tools.length > 0);

    for (const tool of tools) {
      const a = (tool.annotations ?? {}) as Record<string, unknown>;

      for (const hint of HINTS) {
        assert.equal(
          typeof a[hint],
          "boolean",
          `${tool.name}.${hint} is ${a[hint] === undefined ? "ABSENT" : JSON.stringify(a[hint])}, not a boolean — this is the exact wording of the rejection`,
        );
      }

      assert.equal(typeof a.title, "string", `${tool.name} has no annotations.title`);
      assert.equal(typeof tool.title, "string", `${tool.name} has no top-level title`);
    }
  });

  test(`${mode}: each hint matches this tool's documented behaviour`, async () => {
    for (const tool of await listTools(mode)) {
      const expected = EXPECTED[tool.name];

      assert.ok(expected, `${tool.name} has no expected annotations — add it to EXPECTED with a justification`);

      const a = tool.annotations as Record<string, boolean>;

      assert.deepEqual(
        HINTS.map((h) => a[h]),
        expected,
        `${tool.name}: [${HINTS.join(", ")}] disagrees with the table`,
      );
    }
  });
}

test("the hints are internally consistent", async () => {
  // A reviewer checks these against each other, and a contradiction between two
  // hints is the clearest possible form of "does not match behaviour".
  for (const tool of await listTools("local")) {
    const a = tool.annotations as Record<string, boolean>;

    if (a.readOnlyHint) {
      assert.equal(a.destructiveHint, false, `${tool.name} claims to be read-only AND destructive`);
      // A tool with no effect on its environment cannot have an additional effect
      // on a second call.
      assert.equal(a.idempotentHint, true, `${tool.name} is read-only but claims not to be idempotent`);
    }

    if (a.destructiveHint) {
      assert.equal(a.readOnlyHint, false, `${tool.name} claims to be destructive AND read-only`);
    }
  }
});

test("no description contradicts its own hints", async () => {
  // The other half of the rejection was about APPEARANCE: `scaffold_service` and
  // `scaffold_client` are named like write operations, so their descriptions have to
  // say plainly that they do not write. A reader who stops after one sentence must
  // not come away with the wrong model.
  const tools = await listTools("remote");

  for (const name of ["scaffold_service", "scaffold_client"]) {
    const tool = tools.find((t) => t.name === name);

    assert.ok(tool, `${name} missing from the hosted surface`);
    assert.match(
      tool.description ?? "",
      /^READ-ONLY/,
      `${name}'s description must open by saying it writes nothing — the name suggests otherwise`,
    );
    assert.match(tool.description ?? "", /writes nothing/i, name);
  }

  // And the converse: nothing read-only may describe itself as writing.
  for (const tool of await listTools("local")) {
    const a = tool.annotations as Record<string, boolean>;

    if (!a.readOnlyHint) continue;

    assert.doesNotMatch(
      tool.description ?? "",
      /\bwrites files\b|\bactually create\b/i,
      `${tool.name} is read-only but its description claims to write`,
    );
  }
});
