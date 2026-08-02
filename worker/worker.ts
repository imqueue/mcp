// Hosted (edge) entry for the @imqueue MCP server.
//
// Runs on any Web-Standard runtime — Cloudflare Workers (primary target), Deno,
// Bun, Node 18+. It serves the remote-safe tools (docs search + scaffolding, plus
// a local-install guide) over Streamable HTTP. The CLI/fleet tools are not
// registered in remote mode at all (see ../src/server.ts). Deploy with
// `wrangler deploy`.
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

/** Worker bindings. `OPENAI_APPS_CHALLENGE` is a secret, set out of band. */
interface Env {
  /**
   * Domain-verification token issued by the OpenAI app-directory portal. Served
   * verbatim from /.well-known/openai-apps-challenge. Set with
   * `npx wrangler secret put OPENAI_APPS_CHALLENGE` — secrets survive
   * `wrangler deploy`, so the automated postpublish deploy will not wipe it.
   */
  OPENAI_APPS_CHALLENGE?: string;
}

const LANDING = `@imqueue MCP server (hosted)

Model Context Protocol endpoint:  POST ${"/mcp"}

Tools here: search_docs, get_doc, list_packages, scaffold_service,
scaffold_client, local_install_guide. All read-only.

The CLI/fleet tools act on your own machine — your project files, your running
services — so a hosted server cannot offer them. Install the full server
locally to get them:

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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Domain verification for the OpenAI app directory. The portal issues a token
    // and then fetches it back from this path on the MCP host (or a parent of it).
    //
    // With no secret set this is a plain 404 — the same answer as any other unknown
    // path. It must never emit an empty 200 or the string "undefined": the portal
    // would compare that against the real token and report a mismatch, which looks
    // like a wrong token rather than a missing one.
    if (request.method === "GET" && url.pathname === "/.well-known/openai-apps-challenge") {
      const token = env?.OPENAI_APPS_CHALLENGE?.trim();

      return token
        ? new Response(token, { headers: { "content-type": "text/plain; charset=utf-8", ...CORS } })
        : new Response("Not found", { status: 404, headers: CORS });
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
