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

**`npm publish` deploys this Worker automatically.**
[`../scripts/deploy-worker.mjs`](../scripts/deploy-worker.mjs) runs from the
`postpublish` hook, so the hosted endpoint tracks npm without anyone remembering
to ship it. It type-checks the Worker, runs `wrangler deploy`, then polls the
live MCP handshake until `serverInfo.version` matches `package.json` — a deploy
that silently doesn't take effect is an error rather than something nobody
notices. Pre-releases are skipped so they never take over the production
endpoint.

The only requirement is that `wrangler` is authenticated on the publishing
machine (`npx wrangler whoami` to check, `npx wrangler login` once if not).
Because the deploy runs from `postpublish`, wrangler bundles the very same
working tree npm just packed — the tarball and the Worker cannot disagree.

To deploy by hand — a branch, a pre-release, or a catch-up after a publish where
the deploy step failed:

```bash
npx wrangler login      # first time only
npm run deploy:worker   # wrangler deploy → provisions mcp.imqueue.org
```

Set `MCP_WORKER_SKIP=1` to publish without touching the hosted server.

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
- **The Worker is a separate artifact from the npm package** — it is bundled from
  `worker/worker.ts` + `src/`, while the tarball builds `src/` only. That is why
  the deploy needs its own trigger: before it was automated the hosted endpoint
  sat five releases behind npm (serving `2.0.0` while npm was on `2.0.5`),
  because `npm publish` never touched it.
- **`prepublishOnly` does not cover this directory.** It runs `npm run build`,
  which uses the root `tsconfig.json` and so compiles `src/` only — the Worker
  has its own `worker/tsconfig.json`. That is why the deploy script type-checks
  it separately instead of trusting the publish gate.
