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
import { readCall, report, type AnalyticsEnv, type WaitUntil } from "./analytics.js";
import pkg from "../package.json";

const version = (pkg as { version: string }).version;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  // POST only, matching what /mcp answers. GET and DELETE were advertised and are
  // now refused, and this server is stateless — `sessionIdGenerator: undefined`, so
  // it never issues an Mcp-Session-Id and had no business exposing the header.
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Protocol-Version, Authorization",
};

/** Worker bindings. Every one is a secret, set out of band. */
interface Env extends AnalyticsEnv {
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

/**
 * Origins the transport will answer.
 *
 * Validating Origin is a MUST in every protocol revision this server speaks, and it
 * was passing no allowlist at all — `POST … -H 'Origin: https://evil.example'`
 * returned 200. Exploit value is close to zero here (six read-only tools, no auth,
 * no user data), so what this really costs is directory review, where "does not
 * validate Origin" is a one-line scripted check.
 *
 * The SDK matches with `Array.includes`, so there are no wildcards and localhost
 * ports have to be enumerated: wrangler's default below, plus vite's. A request
 * with NO Origin — every non-browser client, which is nearly all of them — passes
 * untouched, because the SDK only rejects an Origin that is present and unlisted.
 *
 * `allowedHosts` is deliberately NOT set, although the audit suggested it. Read the
 * SDK: `if (!hostHeader || !allowedHosts.includes(hostHeader))` → 403. A MISSING
 * Host header is rejected, not just a wrong one, so any request path that fails to
 * surface one would take the whole endpoint down — and that cannot be verified
 * without deploying, which is precisely what the freeze forbids. The Host check
 * exists to protect servers bound to a loopback interface from DNS rebinding; this
 * is a public edge Worker on one custom domain, so it buys nothing here and risks
 * everything. Origin alone satisfies the MUST.
 */
const ALLOWED_ORIGINS = [
  "https://imqueue.org",
  "https://imqueue.com",
  "https://mcp.imqueue.org",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:5173",
];

/** Handle one MCP request statelessly: fresh server + transport, JSON response. */
async function handleMcp(request: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  // Buffered so the same bytes can be measured and handled. `enableJsonResponse`
  // means both bodies are one complete JSON document, and the largest possible one
  // is a capped page read — already fully in memory either way.
  const requestBody = await request.text();
  const forTransport = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: requestBody,
  });

  const server = createServer({ version, mode: "remote" });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no sessions
    enableJsonResponse: true, // request/response JSON, no long-lived SSE
    enableDnsRebindingProtection: true,
    allowedOrigins: ALLOWED_ORIGINS,
  });
  await server.connect(transport);

  const res = await transport.handleRequest(forTransport);
  const headers = new Headers(res.headers);

  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

  // Buffered for the same reason as the request. Telemetry runs after the Response
  // is constructed and inside ctx.waitUntil, so it cannot delay or fail the answer;
  // with no GA4 secret configured `report` is a no-op and this costs one JSON.parse.
  const responseBody = await res.text();

  try {
    report(env, ctx, readCall(requestBody, responseBody), request.headers.get("user-agent") ?? "", Date.now(), version);
  } catch {
    // Measurement must never become a tool failure.
  }

  return new Response(responseBody, { status: res.status, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
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
    //
    // HEAD is answered here too: it was falling through to the MCP handler, which
    // is an RFC 9110 violation (HEAD must behave as GET without a body) and is what
    // registry validators and uptime probes send. A Response built with a null body
    // is the correct way to answer it.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
      const headers = { "content-type": "text/plain; charset=utf-8", ...CORS };

      return new Response(request.method === "HEAD" ? null : LANDING, { headers });
    }

    // MCP endpoint. Accept /mcp, and also / for clients that omit the path.
    if (url.pathname === "/mcp" || url.pathname === "/") {
      // Non-POST is refused BEFORE the transport sees it.
      //
      // `GET /mcp` with an SSE accept header returned 200 and an empty stream,
      // which the SDK client treats as a clean EOF: `_scheduleReconnection(…, 0)`
      // resets attemptCount on every one, so maxRetries is never reached and the
      // client reconnects at roughly 1/s forever. Nothing user-visible breaks —
      // no onerror fires and tool calls are unaffected — which is exactly why it
      // went unnoticed at ~74k requests/day/client. DELETE returned 200 as well.
      //
      // 405 is the one status client/streamableHttp.js treats as a clean no-op, so
      // a client that opens the stream out of habit stops instead of looping. This
      // server speaks several protocol revisions rather than only the newest, so
      // the spec's GET/DELETE→405 rule is a SHOULD here, not a MUST — but the
      // alternative on offer is a permanent poll for a stream that carries nothing.
      if (request.method !== "POST") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: `${request.method} is not supported on ${url.pathname}. This server is stateless: POST a JSON-RPC request.`,
            },
            id: null,
          }),
          {
            status: 405,
            headers: { "content-type": "application/json", allow: "POST, OPTIONS", ...CORS },
          },
        );
      }

      return handleMcp(request, env, ctx);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
