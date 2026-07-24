# Hosted @imqueue MCP server (Cloudflare Worker)

This directory holds the **hosted** entry for the @imqueue MCP server —
`worker.ts`, a Web-Standard `fetch` handler that serves the server over
**Streamable HTTP** (e.g. at `https://mcp.imqueue.org/mcp`).

It shares all tool logic with the local server via [`../src/server.ts`](../src/server.ts).
The difference is **mode**:

| | Local (`npx @imqueue/mcp`, stdio) | Hosted (`mcp.imqueue.org`, this Worker) |
|---|---|---|
| `search_docs`, `get_doc`, `list_packages` | ✅ | ✅ |
| `scaffold_service`, `scaffold_client` | ✅ | ✅ |
| `create_service`, `generate_client` | ✅ (real CLI) | ↩︎ returns an offline scaffold + "install locally" |
| `cli_status`, `cli_help`, `cli_install`, `fleet`, `config`, `logs` | ✅ | ↩︎ "install locally" hand-off |
| `install_locally` | — | ✅ (returns the local-install steps) |

The CLI/fleet tools act on the **user's own machine** (their project files, their
running services), which a remote server can't reach — so on the hosted server
they hand off to the local install instead of failing.

> **Not shipped to npm.** The published package builds `src/` only (see the root
> `tsconfig.json`). This Worker is bundled independently by Wrangler.

## Prerequisites

- A Cloudflare account (free tier is fine — Workers are always-on, no cold-sleep).
- `wrangler` (installed as a devDependency): `npm install`
- To bind `mcp.imqueue.org`: the **imqueue.org zone must be in the same
  Cloudflare account** you deploy from (it is — the site is already on Cloudflare).

## Develop & verify locally

```bash
npm run typecheck:worker   # tsc --noEmit over the Worker
npm run dev:worker         # wrangler dev — serves on http://localhost:8787
```

Smoke-test the running dev server with any MCP client, or by hand:

```bash
curl -s http://localhost:8787/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq .
```

You should get the tool list back. Try `search_docs` / `scaffold_service` calls too.

## Deploy

```bash
npx wrangler login      # first time only
npm run deploy:worker   # wrangler deploy → provisions mcp.imqueue.org
```

`wrangler.jsonc` binds the Worker to `mcp.imqueue.org` via a custom domain. If you
prefer to wire the domain in the dashboard, remove the `routes` block and add a
Custom Domain under the Worker's **Settings → Domains**.

## How clients connect

```json
{ "mcpServers": { "imqueue": { "url": "https://mcp.imqueue.org/mcp" } } }
```

## Notes

- **Stateless**: each request builds a fresh server + transport and returns JSON
  (`enableJsonResponse: true`, no sessions) — no Durable Objects needed. If you
  later want server-initiated streaming/notifications, switch to a
  `sessionIdGenerator` + Durable Object for session storage.
- **CORS** is permissive (`*`) so browser-based MCP clients / a web playground can
  connect. Tighten `Access-Control-Allow-Origin` if you want to restrict it.
- This Worker has been type-checked here but **not yet deployed** — validate with
  `npm run dev:worker` before the first `deploy`.
