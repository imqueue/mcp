// The hosted Worker's HTTP surface, exercised directly.
//
// worker.ts is a plain Web-Standard fetch handler, so it can be called with a
// Request and asserted on the Response — no wrangler, no deploy, no network for
// anything except a docs-backed tool call, which is not needed here. That matters
// because every defect below was invisible in normal use: `GET /mcp` answering 200
// with an empty stream broke nothing a user could see, and drove ~74k requests a
// day per connected client for months.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import worker from "../worker/worker.js";

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`https://mcp.imqueue.org${path}`, init), {});

test("non-POST on the MCP endpoint is refused, not answered", async () => {
  for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
    const res = await call("/mcp", { method });

    assert.equal(res.status, 405, `${method} /mcp`);
    // 405 is the one status the SDK client treats as a clean no-op, so a client
    // that opens the stream out of habit stops instead of reconnecting forever.
    assert.equal(res.headers.get("allow"), "POST, OPTIONS", `${method} /mcp Allow`);

    const body = await res.json() as { error?: { message?: string } };

    // JSON-RPC-shaped, because that is what the caller is parsing.
    assert.match(body.error?.message ?? "", /not supported/);
  }
});

test("an SSE accept header does not get a stream either", async () => {
  // The exact request that returned 200 with a zero-byte body.
  const res = await call("/mcp", { method: "GET", headers: { accept: "text/event-stream" } });

  assert.equal(res.status, 405);
});

test("HEAD on the root behaves as GET without a body", async () => {
  // It fell through to the MCP handler: an RFC 9110 violation, and HEAD is what
  // registry validators and uptime probes send.
  const res = await call("/", { method: "HEAD" });

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(await res.text(), "");
});

test("the root still serves the landing page to a browser", async () => {
  const res = await call("/");
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(body, /POST \/mcp/);
  assert.match(body, /npx -y @imqueue\/mcp/);
});

test("CORS advertises only what the endpoint answers", async () => {
  const res = await call("/mcp", { method: "OPTIONS" });

  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  // Stateless: sessionIdGenerator is undefined, so no session id is ever issued
  // and exposing the header advertised something that does not exist.
  assert.equal(res.headers.get("access-control-expose-headers"), null);
  assert.ok(!(res.headers.get("access-control-allow-headers") ?? "").includes("Mcp-Session-Id"));
});

test("a POST completes the handshake and carries the instructions", async () => {
  const res = await call("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }),
  });

  assert.equal(res.status, 200);

  const text = await res.text();
  const framed = text.match(/^data:\s*(.*)$/m);
  const json = JSON.parse(framed ? framed[1] : text) as {
    result?: { instructions?: string; serverInfo?: { name?: string; title?: string } };
  };

  assert.equal(json.result?.serverInfo?.name, "imqueue");
  assert.equal(json.result?.serverInfo?.title, "@imqueue");
  assert.match(json.result?.instructions ?? "", /search_docs/);
});

test("the domain-verification route is a specific match, and never a partial token", async () => {
  // A 200 carrying nothing useful is the failure that matters: the portal reads
  // that as a WRONG token rather than an absent one.
  const absent = await call("/.well-known/openai-apps-challenge");

  assert.equal(absent.status, 404);
  assert.equal(await absent.text(), "Not found");

  const present = await worker.fetch(
    new Request("https://mcp.imqueue.org/.well-known/openai-apps-challenge"),
    { OPENAI_APPS_CHALLENGE: "  token-value  " },
  );

  assert.equal(present.status, 200);
  assert.equal(await present.text(), "token-value");
  assert.match(present.headers.get("content-type") ?? "", /text\/plain/);

  const other = await call("/.well-known/something-else");

  assert.equal(other.status, 404);
});

test("an unknown path 404s", async () => {
  assert.equal((await call("/nope")).status, 404);
});
