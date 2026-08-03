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
| `create_service`, `generate_client` | ✅ (real CLI) | **not registered** |
| `cli_status`, `cli_help`, `cli_install`, `fleet`, `config`, `logs` | ✅ | **not registered** |
| `local_install_guide` | — | ✅ (returns the local-install steps) |

The CLI/fleet tools act on the **user's own machine** (their project files, their
running services), which a remote server can't reach.

Until 3.0.0 the hosted server registered them anyway and returned a "run me
locally" hand-off. That was worse than not offering them: a client saw thirteen
tools, eight of which could never do what their names said, and an agent that
picked `fleet` got prose instead of a fleet. **Registration is now gated by mode**
(`registerCliTools` vs `registerInstallGuide` in [`../src/server.ts`](../src/server.ts)),
so the hosted tool list contains only tools it can actually run — all six of them
read-only.

That is also what makes the endpoint submittable to the public directories: both
OpenAI's app directory and the Anthropic Connectors Directory check that a tool's
name, description and annotations match its real behaviour, and Anthropic rejects
outright any single tool that spans safe and unsafe operations. `fleet`
(`status` + `stop`), `config` (`get` + `set`) and `logs` (`dump` + `clean`) are all
that shape — which is fine for a local server the user installed deliberately, and
disqualifying for a listed remote one. Keep it that way: `scripts/remote-smoke.mjs`
asserts the exact six-tool list and fails if anything else appears.

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

You should get the tool list back. Or run the full check, which is what CI-worthy
verification looks like here:

```bash
node ../scripts/remote-smoke.mjs http://localhost:8787/mcp   # from worker/
node scripts/remote-smoke.mjs http://localhost:8787/mcp      # from the repo root
```

It asserts the exact six-tool list, that every tool is `readOnlyHint: true` and
non-destructive, that each one returns a usable response, that `get_doc` refuses a
non-imqueue.org URL, and the challenge-route behaviour described below.

## Domain verification (`/.well-known/openai-apps-challenge`)

The OpenAI app directory verifies you control the MCP host by issuing a token and
fetching it back from `/.well-known/openai-apps-challenge` on that host (or a
parent of it). The Worker serves it from a secret:

```bash
npx wrangler secret put OPENAI_APPS_CHALLENGE   # paste the token from the portal
```

Secrets are stored on the Worker, not in this repo, and **survive
`wrangler deploy`** — so the automated `postpublish` deploy will not wipe it and it
never needs to be committed.

With no secret set the path returns a plain `404`, exactly like any other unknown
path. That is deliberate: an empty `200` (or the literal string `undefined`) would
be read by the portal as a *wrong* token rather than a missing one, which is a
far more confusing failure to diagnose from the other side.

Anthropic's directory does not use a challenge file — it verifies through the
submitting organisation instead — so this route exists for the OpenAI side only.

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
  connect, but it advertises `POST, OPTIONS` only — which is all `/mcp` answers —
  and no longer exposes `Mcp-Session-Id`, a header this stateless server never
  issues.
- **Origin IS validated**, and that is a protocol MUST rather than a preference:
  the transport gets `enableDnsRebindingProtection: true` plus an `allowedOrigins`
  allowlist. The SDK matches with `Array.includes`, so there are no wildcards and
  each localhost port has to be listed. A request with **no** Origin header — every
  non-browser client, i.e. nearly all of them — passes untouched, because only a
  present-and-unlisted Origin is rejected.

  `allowedHosts` is deliberately left unset. In the SDK a **missing** Host header
  is a 403, not just a mismatched one, so any request path that failed to surface
  one would take the endpoint down for everybody — and the Host check exists to stop
  DNS rebinding against servers bound to a loopback interface, which this public
  edge Worker on one custom domain is not. If you ever add a second route (a
  `workers.dev` subdomain, a staging host), that is the moment to reconsider, and
  you must enumerate every hostname you serve on before enabling it.
- **Non-POST on `/mcp` is 405 with `Allow: POST, OPTIONS`.** `GET` used to return
  200 and an empty SSE stream, which the SDK client reads as a clean EOF and then
  retries indefinitely — roughly 1 req/s, forever, per connected client, with
  nothing visibly broken. 405 is the one status the client treats as a clean no-op.
  `HEAD /` now serves the landing page's headers with no body; it used to fall
  through to the MCP handler, and HEAD is what registry validators and uptime
  probes send.
- **Upstream fetches are bounded**: 5 s per request, an `imqueue-mcp/<version>`
  user agent so the site's own analytics can see them, and a fall back to the
  stale in-process cache rather than reporting that the docs cannot be searched.
- **Telemetry ships dormant.** `worker/analytics.ts` reports `mcp_connect` and
  `mcp_tool_call` to the imqueue.org GA4 property via the Measurement Protocol, so
  the question the GEO programme is scored on — is an agent reaching for these docs
  instead of its priors — becomes answerable. With no secret set it is a no-op:

  ```bash
  npx wrangler secret put GA4_MP_MEASUREMENT_ID   # G-XXXXXXXX (the imqueue.org property)
  npx wrangler secret put GA4_MP_API_SECRET       # GA4 → Admin → Data streams → Measurement Protocol
  npx wrangler secret put GA4_MP_DEBUG            # optional: POST to GA4's debug endpoint and log its verdict
  ```

  Two things to do before setting those:

  1. Register `tool`, `client_name`, `query` and `results` as **event-scoped**
     custom dimensions in GA4. The other parameters reuse dimensions the property
     already has (`kind`, `surface`, `crawler`, `operator`, `status`, `visit_id`).
     Unregistered parameters are collected and unreportable.
  2. Add a line to imqueue.com/privacy. `query` is text a person typed. It is sent
     **only when the search returned nothing**, truncated to 100 characters — the
     corpus-gap signal, and the smallest collection that provides it — but that is
     still user-entered text leaving the server, and it should be disclosed before
     it starts.

  There is no per-user identity to collect: the server is stateless and cookieless,
  so `client_id` is a stable label for a client *family* (`mcp.claude-code`), and
  every user of one client shares it.
- **Propagation is not observable from one client, so the smoke distinguishes rather
  than waits.** `wrangler deploy` accepting an upload is not every colo serving it,
  and consecutive probes from one machine mostly reach the same colo over a reused
  connection — three matches in a row prove very little. (3.2.1 and 3.2.2 both
  confirmed the new version and were then answered by the previous one seconds later.)

  So `remote-smoke.mjs` takes the expected version as its second argument and has
  **three** outcomes: `0` all passed, `1` failed while consistently serving the
  expected build — real, stop — and `2` failed *and* saw another version during the
  run, which is a rollout in progress. `deploy-worker.mjs` retries only `2`. A genuine
  contract break fails on the first attempt and is never retried into silence; a
  lagging isolate resolves itself. The smoke also waits for the expected version
  before asserting, and re-reads it at the end in case a colo rolls over mid-run.

  If you need to check what is live right now:

  ```bash
  MCP_WORKER_VERIFY_ONLY=1 npm run deploy:worker   # propagation + full contract, no deploy
  ```

  This is what to run after a `postpublish` failure, before deciding whether to fix
  forward or `npx wrangler rollback`. 3.2.1 is why it exists: the deploy succeeded,
  one smoke request landed on the previous version, and the only way to re-check was
  to deploy again.
- **A failure in one postpublish step no longer cancels the others.** `postpublish`
  runs `scripts/postpublish.mjs`, which runs the Worker deploy, the MCP registry
  publish and the GitHub Release **all three**, then reports and exits non-zero if
  any failed. It used to chain them with `&&`, which let the strictest step (the
  deploy, which exits non-zero by design) silently skip the two that describe
  themselves as cosmetic — so a release could reach npm with a registry record
  pointing at the old version and no release notes.
- **The Worker is a separate artifact from the npm package** — it is bundled from
  `worker/worker.ts` + `src/`, while the tarball builds `src/` only. That is why
  the deploy needs its own trigger: before it was automated the hosted endpoint
  sat five releases behind npm (serving `2.0.0` while npm was on `2.0.5`),
  because `npm publish` never touched it.
- **`prepublishOnly` does not cover this directory.** It runs `npm run build`,
  which uses the root `tsconfig.json` and so compiles `src/` only — the Worker
  has its own `worker/tsconfig.json`. That is why the deploy script type-checks
  it separately instead of trusting the publish gate.
