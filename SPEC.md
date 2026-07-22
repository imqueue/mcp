# @imqueue/mcp — design spec

## 1. Purpose

Make @imqueue **first-class inside AI coding agents**. When a developer asks their
assistant to "build an @imqueue service" or "how do I expose a method", the agent
should reach for authoritative docs and correct scaffolding rather than
hallucinating an API. This is the GEO (Generative Engine Optimization) counterpart
to SEO: instead of ranking in a search page, we rank **at code-time**, inside the
tools developers already use.

Three capabilities, thirteen tools:

- **Docs access** — `search_docs`, `get_doc`, `list_packages`
- **Offline scaffolding** — `scaffold_service`, `scaffold_client` (templates, no deps)
- **CLI bridge** — `cli_status`, `cli_install`, `cli_help`, `create_service`,
  `generate_client`, `fleet` (`imq ctl`), `config` (`imq config`), `logs` (`imq log`)
  (drive the installed `imq` binary — install it, create projects, generate clients,
  manage the local fleet and CLI configuration)

## 2. Architecture

```
AI agent (Claude Code / Cursor / …)
        │  MCP (JSON-RPC over stdio)
        ▼
  @imqueue/mcp  ── fetch ──▶  imqueue.org
   ├─ docs.ts       (/llms.txt, /<page>/index.md)
   ├─ packages.ts   (static catalog)
   └─ scaffold.ts   (code templates)
```

- **Transport:** stdio (the universal local-MCP transport; works with every host
  today). A hosted **Streamable HTTP** variant is a later option (§7).
- **Runtime:** Node ≥ 18, TypeScript, `@modelcontextprotocol/sdk` high-level
  `McpServer`, `zod` input schemas. Ships as an npm bin (`npx -y @imqueue/mcp`).
- **Docs source:** fetched live from imqueue.org's existing machine-readable feeds
  and cached in-process (1 h TTL). No docs are bundled, so the server can never go
  stale against a release. **Only `imqueue.org` is ever fetched** (host-checked).

### Why reuse the site feeds
imqueue.org already emits, for GEO:
- `/llms.txt` — curated index (`## Section` + `- [Title](url): description`)
- `/<page-url>index.md` — a plain-markdown mirror of every page
- `/blog/search-index.json` — structured post index

The MCP server is a thin, agent-facing adapter over those — one source of truth.

## 3. Tools

### `search_docs(query, limit?=6)`
Parse `/llms.txt` into `{title, url, description, section}` entries; rank by query-term
overlap (title ×3, section/description/url ×1); return the top *N* with URLs.
→ *"how do I expose a method" → the RPC guide + API pages.*

### `get_doc(url)`
Resolve a page URL to its markdown mirror (`…/index.md`) and return the raw markdown
for reading/quoting. Host-restricted to imqueue.org.

### `list_packages()`
Static catalog (rpc, core, cli, job, pg-pubsub, pg-cache, async-logger, http-protect)
with one-liners + install commands, so the agent picks the right package first.

### `scaffold_service(name, methods?)`
Emit an `IMQService` subclass with `@expose()`d, **JSDoc-typed** methods (JSDoc is
@imqueue's type source) + a bootstrap that `start()`s it. Omitting `methods` yields a
starter template. Points to `imq service create` for a fully provider-wired project.

### `scaffold_client(service, methods?)`
@imqueue generates the **real** typed client from a **running** service
(`imq client generate <Name>`), so types never drift. The tool returns that command
plus an illustrative usage snippet (it does not fabricate a client that could go stale).

### CLI bridge — `cli_status`, `cli_help`, `create_service`, `generate_client`
The server runs locally, so when `@imqueue/cli` is on PATH it can drive the **real**
`imq` (see `src/cli.ts`). Safety posture:
- Every call runs `imq` with **stdin closed and a timeout**, so an interactive prompt
  (a missing flag) fails fast with guidance rather than hanging the server.
- `create_service` runs `imq service create … --dry-run` **by default** (writes
  nothing); a real run requires an explicit `apply: true` — an agent must never
  create repos / push to remotes silently. `cli_help` surfaces the exact flags to
  pass so the run is non-interactive.
- `generate_client` runs `imq client generate` (the service must be running).
- `cli_install` runs `npm install -g @imqueue/cli` to bootstrap the CLI when absent.
- `fleet` wraps `imq ctl <start|stop|restart|status>` (status is read-only; the
  others change running processes).
- `config` wraps `imq config <check|get|set|init>` (get/check read-only; set writes a
  single value; init is interactive so automation should prefer set).
- If `imq` is absent, the tools return an install hint and the offline `scaffold_*`
  tools remain available.

## 4. Input schemas (zod)

- `search_docs`: `{ query: string, limit?: 1..20 }`
- `get_doc`: `{ url: string }`
- `list_packages`: `{}`
- `scaffold_service` / `scaffold_client`: `{ name|service: string, methods?: Method[] }`
  where `Method = { name, description?, params?: {name,type,description?}[], returns? }`.

Every tool returns `{ content: [{ type: "text", text }] }`; errors return the same
shape with `isError: true` (so the agent sees a message, not a transport failure).

## 5. Distribution to registries

Publish `@imqueue/mcp` to npm, then list it everywhere agents discover servers:

| Channel | Artifact / action |
|---|---|
| **Official MCP registry** | `server.json` (this repo) → publish via `mcp-publisher`. Namespace `org.imqueue/mcp` (DNS auth on imqueue.org). |
| **Smithery** | `smithery.yaml` (this repo) → connect the GitHub repo. |
| **mcp.so / PulseMCP / Glama** | Auto-index from npm + GitHub; submit/claim the listing. |
| **Cursor / VS Code directories** | Add the `mcpServers` JSON snippet to their community lists. |
| **awesome-mcp-servers** | PR the repo into the list. |
| **imqueue.org** | Add an "MCP server" section to `/using-ai-assistants/` with the install snippet. |

Install snippet promoted everywhere:
```json
{ "mcpServers": { "imqueue": { "command": "npx", "args": ["-y", "@imqueue/mcp"] } } }
```

## 6. Verification

`npm run smoke` spawns the built server and drives the JSON-RPC handshake:
`initialize` → `tools/list` (asserts all five) → `tools/call` for `scaffold_service`
and `list_packages` (offline) and `search_docs` (live). CI can run it on every push.

## 7. Roadmap

- **Streamable HTTP** deployment (a hosted endpoint) for zero-install use and for
  hosts that prefer remote servers.
- **`generate_client` for real** — spin up against a reachable running service and
  return the actual generated client.
- **Resources** — expose docs pages as MCP *resources* (not just tool results) so
  hosts can surface them in their UI.
- **Prompts** — ship an "author an @imqueue service" prompt template.
- **Richer search** — fold in `/blog/search-index.json` topics and light stemming to
  improve recall (e.g. "delayed jobs" → job/scheduling pages).

## 8. Licensing

GPL-3.0, matching the framework; commercial licensing via imqueue.com.
