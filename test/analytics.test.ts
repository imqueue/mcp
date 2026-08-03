// MCP telemetry: what is recorded, and — more important — what is not.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildEvent, readCall, report } from "../worker/analytics.js";

const NOW = 1_770_000_000_000;

const req = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
const ok = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, result });

test("a tool call records the tool, the count and the outcome", () => {
  const facts = readCall(
    req("tools/call", { name: "search_docs", arguments: { query: "delayed jobs" } }),
    ok({ content: [{ type: "text", text: "3 results" }], structuredContent: { query: "delayed jobs", count: 3, results: [1, 2, 3] } }),
  );

  assert.equal(facts?.tool, "search_docs");
  assert.equal(facts?.results, 3);
  assert.equal(facts?.status, "ok");
});

test("a query that found something is not recorded", () => {
  // The privacy line: `query` is text a person typed, and a search that found what
  // it wanted needs no recording.
  const facts = readCall(
    req("tools/call", { name: "search_docs", arguments: { query: "my-company-internal-service" } }),
    ok({ structuredContent: { count: 2, results: [1, 2] } }),
  );

  assert.equal(facts?.query, undefined);
});

test("a query that found nothing is recorded, truncated", () => {
  // The corpus-gap signal, and the one thing no other source can provide.
  const long = "x".repeat(500);
  const facts = readCall(
    req("tools/call", { name: "search_docs", arguments: { query: long } }),
    ok({ structuredContent: { count: 0, results: [] } }),
  );

  assert.equal(facts?.results, 0);
  assert.equal(facts?.query?.length, 100);
});

test("an error result is recorded as one", () => {
  const failed = readCall(
    req("tools/call", { name: "get_doc", arguments: { url: "https://example.com/" } }),
    ok({ content: [{ type: "text", text: "Error: refused" }], isError: true }),
  );

  assert.equal(failed?.status, "error");

  const rpcError = readCall(
    req("tools/call", { name: "get_doc" }),
    JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad params" } }),
  );

  assert.equal(rpcError?.status, "error");
});

test("a malformed request is not an event", () => {
  assert.equal(readCall("not json", ok({})), null);
  assert.equal(readCall(JSON.stringify({ jsonrpc: "2.0" }), ok({})), null);
});

test("an SSE-framed reply is still read", () => {
  const facts = readCall(
    req("tools/call", { name: "list_packages" }),
    `event: message\ndata: ${ok({ structuredContent: { packages: [] } })}\n\n`,
  );

  assert.equal(facts?.tool, "list_packages");
  assert.equal(facts?.status, "ok");
});

test("initialize is a distinct event and the only place a client names itself", () => {
  const facts = readCall(
    req("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "Claude Code", version: "2" } }),
    ok({ serverInfo: { name: "imqueue" } }),
  );

  assert.equal(facts?.clientName, "Claude Code");

  const event = buildEvent(facts!, "", NOW, "3.2.0");

  // Three distinct names across the two populations, so no report can add up
  // gtag's page_view, the site edge's srv_page_view and this by accident.
  assert.equal(event.events[0].name, "mcp_connect");
  assert.equal(event.client_id, "mcp.claude-code");
});

test("the event reuses the dimensions the property already has", () => {
  const facts = readCall(req("tools/call", { name: "get_doc" }), ok({ structuredContent: { url: "x" } }))!;
  const { params, name } = buildEvent(facts, "imqueue-mcp/3.2.0", NOW, "3.2.0").events[0];

  assert.equal(name, "mcp_tool_call");
  assert.equal(params.kind, "assistant.mcp");
  assert.equal(params.surface, "mcp");
  assert.equal(params.tool, "get_doc");
  // Without both of these the event lands with no session and every engagement
  // metric in the property reads zero.
  assert.ok(params.session_id);
  assert.equal(params.engagement_time_msec, 1);
});

test("telemetry is a no-op until it is configured", async () => {
  const real = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = (async () => {
    calls++;

    return new Response("{}");
  }) as typeof fetch;

  try {
    const facts = readCall(req("tools/call", { name: "list_packages" }), ok({}))!;
    const ctx = { waitUntil: (p: Promise<unknown>) => void p };

    // Ships dormant: no secret, no request. Turning it on is `wrangler secret put`.
    report({}, ctx, facts, "", NOW, "3.2.0");
    report({ GA4_MP_MEASUREMENT_ID: "G-X" }, ctx, facts, "", NOW, "3.2.0");
    report({ GA4_MP_API_SECRET: "s" }, ctx, facts, "", NOW, "3.2.0");
    assert.equal(calls, 0);

    report({ GA4_MP_MEASUREMENT_ID: "G-X", GA4_MP_API_SECRET: "s" }, ctx, facts, "", NOW, "3.2.0");
    assert.equal(calls, 1);

    // No ExecutionContext (i.e. not on Cloudflare) must not throw either.
    report({ GA4_MP_MEASUREMENT_ID: "G-X", GA4_MP_API_SECRET: "s" }, undefined, facts, "", NOW, "3.2.0");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = real;
  }
});

test("a measurement failure never becomes a tool failure", async () => {
  const real = globalThis.fetch;
  const pending: Promise<unknown>[] = [];

  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  try {
    const facts = readCall(req("tools/call", { name: "list_packages" }), ok({}))!;

    report(
      { GA4_MP_MEASUREMENT_ID: "G-X", GA4_MP_API_SECRET: "s" },
      { waitUntil: (p) => pending.push(p) },
      facts,
      "",
      NOW,
      "3.2.0",
    );

    // Whatever is handed to waitUntil must resolve, never reject: an unhandled
    // rejection there is a Worker error for a request that already succeeded.
    await Promise.all(pending);
  } finally {
    globalThis.fetch = real;
  }
});
