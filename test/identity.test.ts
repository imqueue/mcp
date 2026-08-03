// Server identity and the `instructions` string.
//
// These are the two pieces of metadata nothing else can catch. `instructions`
// lands in the host model's system prompt, so it is charged to every request on
// every connection and there is no upper bound enforced anywhere by the protocol.
// `title`/`websiteUrl` are duplicated out of server.json because that file is not
// in the published tarball (see IDENTITY), and a copy with no assertion is a copy
// that drifts.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { IDENTITY, INSTRUCTIONS, createServer } from "../src/server.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverJson = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as {
  title?: string;
  websiteUrl?: string;
};

test("IDENTITY matches server.json", () => {
  assert.equal(IDENTITY.title, serverJson.title, "title differs from server.json");
  assert.equal(IDENTITY.websiteUrl, serverJson.websiteUrl, "websiteUrl differs from server.json");
});

test("server.json declares a title", () => {
  // Registries and subregistries fall back to the reverse-DNS name without it,
  // i.e. a listing headed `org.imqueue/mcp`.
  assert.ok(serverJson.title && serverJson.title.length > 0);
});

test("instructions stay within their budget", () => {
  const words = INSTRUCTIONS.split(/\s+/).filter(Boolean).length;

  assert.ok(words > 0, "instructions are empty");
  assert.ok(
    words <= 150,
    `instructions are ${words} words; the budget is 150 because this text is charged to every request`,
  );
});

test("instructions state the rules that fail silently", () => {
  // Each of these is a defect that COMPILES: the omission has no error to catch
  // it, which is the entire reason the rule is worth spending system-prompt
  // tokens on. A rewrite that drops one should fail here rather than quietly
  // stop preventing it.
  for (const rule of ["search_docs", "list_packages", "@expose()", "@classType()", "@property()", "imq client generate"]) {
    assert.ok(INSTRUCTIONS.includes(rule), `instructions no longer mention ${rule}`);
  }
});

test("the server reports its instructions and title in both modes", async () => {
  for (const mode of ["local", "remote"] as const) {
    const server = createServer({ version: "0.0.0-test", mode });
    // The SDK stores both on the low-level Server and emits them from
    // `initialize`; reading them back is what proves ServerOptions was actually
    // passed, which is the thing that was missing.
    const impl = (server.server as unknown as { _serverInfo: Record<string, unknown> })._serverInfo;

    assert.equal(impl.title, IDENTITY.title, `${mode}: title absent from serverInfo`);
    assert.equal(impl.websiteUrl, IDENTITY.websiteUrl, `${mode}: websiteUrl absent from serverInfo`);
    assert.equal(
      (server.server as unknown as { _instructions?: string })._instructions,
      INSTRUCTIONS,
      `${mode}: instructions absent`,
    );
  }
});
