// Hosted (edge) entry for the @imqueue MCP server.
//
// Runs on any Web-Standard runtime — Cloudflare Workers (primary target), Deno,
// Bun, Node 18+. It serves the remote-safe tools (docs search + scaffolding)
// over Streamable HTTP; the CLI/fleet tools hand off to the local install
// (see ../src/server.ts, mode: "remote"). Deploy with `wrangler deploy`.
//
// NOTE: not part of the published npm package (the main tsconfig only builds
// src/). It is bundled independently by wrangler/esbuild. See worker/README.md.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { createServer } from "../src/server.js";
import pkg from "../package.json";

const version = (pkg as { version: string }).version;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

const LANDING = `@imqueue MCP server (hosted)

Model Context Protocol endpoint:  POST ${"/mcp"}

Docs search + scaffolding tools work here. The CLI/fleet tools run on your own
machine — install the full server locally:

    claude mcp add imqueue -- npx -y @imqueue/mcp

or add to your client's MCP config:

    { "mcpServers": { "imqueue": { "command": "npx", "args": ["-y", "@imqueue/mcp"] } } }

Learn more: https://imqueue.org/mcp
`;

/** Handle one MCP request statelessly: fresh server + transport, JSON response. */
async function handleMcp(request: Request): Promise<Response> {
  const server = createServer({ version, mode: "remote" });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no sessions
    enableJsonResponse: true, // request/response JSON, no long-lived SSE
  });
  await server.connect(transport);

  const res = await transport.handleRequest(request);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Friendly landing page at the root for humans hitting it in a browser.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(LANDING, {
        headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
      });
    }

    // MCP endpoint. Accept /mcp, and also / for clients that omit the path.
    if (url.pathname === "/mcp" || url.pathname === "/") {
      return handleMcp(request);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
