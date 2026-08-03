# @imqueue/mcp

[![smithery badge](https://smithery.ai/badge/mikhus/imqueue)](https://smithery.ai/servers/mikhus/imqueue)

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[@imqueue](https://imqueue.org)**. It lets AI coding agents (Claude Code, Cursor, VS Code, JetBrains, …) **search the @imqueue documentation**, **scaffold typed services & clients**, and **drive the `imq` CLI** — so they generate correct, idiomatic @imqueue code instead of guessing.

📖 **Full documentation: [imqueue.org/mcp](https://imqueue.org/mcp/)** — per-client setup, complete tools reference, agent workflows and the safety model.

## Tools

Two surfaces, and they are not the same. The **local** server (`npx -y @imqueue/mcp`) has all 13 tools. The **hosted** server ([`mcp.imqueue.org/mcp`](#hosted-server-no-install)) has six, all read-only — see [below](#hosted-server-no-install) for why.

### Hosted + local

| Tool | What it does |
|---|---|
| `search_docs` | Search the official docs (guides, tutorial, CLI manual, API reference, articles) and return the most relevant pages + URLs. |
| `get_doc` | Fetch the full markdown of a doc page by URL. |
| `list_packages` | List the main @imqueue packages with install commands. |
| `scaffold_service` | Generate an `IMQService` subclass with `@expose()`d, JSDoc-typed methods + a bootstrap (offline, no CLI needed). |
| `scaffold_client` | Show how to generate and use the fully-typed client for a service (offline). |

All five are read-only: they fetch or generate text and write nothing.

All five also declare an MCP **`outputSchema`** and return `structuredContent` alongside the human-readable markdown, so a client can consume results as data — take `results[0].url` from `search_docs` and hand it to `get_doc`, or write `scaffold_service`'s `files[]` straight to disk — instead of parsing prose and code fences. For the scaffolders and the catalogue the markdown is *rendered from* that same structure, so the two can't drift.

**`get_doc`'s schema is metadata only, on purpose** — and that turns out to be the more interesting design than having no schema at all. A schema obliges the server to send `structuredContent`, but nothing says `structuredContent` must repeat what is in `content`: it describes the structured *part* of the answer. So the page travels once, in `content`, and the schema carries `url` (the mirror actually fetched, which is not always the URL you passed), `mimeType`, `bytes` (so a caller can decide before reading) and `truncated`. Putting `markdown` in there as well would have doubled the largest response the server can produce — measured on `/api/rpc/latest/`, 16.6 kB of text plus 16.6 kB of structure for one read. The absence of a body field is itself self-describing: a caller reading the schema sees no content field and knows the page is in `content`, which is where every client already looks.

The CLI-backed tools have no schema: they return `imq` stdout, which has no shape worth promising.

### CLI-backed tools — local only (require `@imqueue/cli` on PATH)

These drive the **real** CLI, so they act on the machine the server runs on. They exist in the local install only; the hosted server does not register them.

| Tool | What it does |
|---|---|
| `cli_status` | Detect `imq` and report its version. |
| `cli_install` | Install `@imqueue/cli` globally (`npm i -g @imqueue/cli`) when it's missing. |
| `cli_help` | `imq <command> --help` — exact, version-accurate flags (no side effects). |
| `create_service` | `imq service create` — **dry-run by default** (writes nothing); pass `apply: true` to actually create the project. |
| `generate_client` | `imq client generate <Service>` — the real typed client (the service must be running). |
| `fleet` | `imq ctl <start\|stop\|restart\|status>` — manage a directory of service repos. `status` is read-only. |
| `config` | `imq config <check\|get\|set\|init>` — read/write CLI configuration (`set` for automation; `init` is interactive). |
| `logs` | `imq log` — `dump` current fleet logs (never follows; capped) or `clean` them. |

Calls run with stdin closed and a timeout, so a missing-flag prompt fails fast instead of hanging. If `imq` isn't installed, run `cli_install` or use the offline `scaffold_*` tools.

Docs are fetched live from imqueue.org's machine-readable feeds (`/llms.txt`, per-page `…/index.md` mirrors), so the server never ships stale content. It only ever fetches `imqueue.org`.

## Install

Requires Node.js ≥ 18. No build step for users — run straight from npm:

```bash
npx -y @imqueue/mcp
```

### Claude Code

```bash
claude mcp add imqueue -- npx -y @imqueue/mcp
```

### Other clients (Cursor, Claude Desktop, JetBrains, Windsurf, Zed, …)

Add to your MCP config (`.cursor/mcp.json`, `claude_desktop_config.json`, …):

```json
{
  "mcpServers": {
    "imqueue": {
      "command": "npx",
      "args": ["-y", "@imqueue/mcp"]
    }
  }
}
```

> **VS Code and Visual Studio** use a top-level `servers` key with `"type": "stdio"` instead of `mcpServers`. See **[imqueue.org/mcp/installation](https://imqueue.org/mcp/installation/)** for the exact config file path and snippet for every client.

## Hosted server (no install)

If your client supports remote MCP servers and you only need docs and scaffolding, point it at the hosted endpoint instead:

```json
{ "mcpServers": { "imqueue": { "url": "https://mcp.imqueue.org/mcp" } } }
```

It serves six tools, **all read-only**: the five above plus `local_install_guide`, which returns the setup steps for the local install.

**It does not offer the CLI-backed tools, by design.** Those act on *your* machine — your project files, your running services, your CLI config — which a server running on Cloudflare's edge cannot reach. Advertising them there would mean listing tools that can never do what their names say, so they are not registered at all in remote mode. If you need them, install locally.

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # run from source with tsx
npm run smoke      # local surface: handshake + tools/list + annotations + tool calls
```

The hosted surface has its own check, because it is a different contract:

```bash
npm run dev:worker                                   # wrangler dev on :8787
node scripts/remote-smoke.mjs http://localhost:8787/mcp
npm run smoke:remote                                 # or against production
```

It asserts the **exact** six-tool list and that every one of them is read-only — the assertion that stops a future refactor from quietly re-exposing a CLI tool on the hosted endpoint.

## Example

> **User:** *"Create an @imqueue user service with a getUser(id) method."*
>
> The agent calls `scaffold_service({ name: "user", methods: [{ name: "getUser", params: [{ name: "id", type: "number" }], returns: "User" }] })` and gets a ready-to-paste `UserService` + bootstrap, then `search_docs("run a service")` / `get_doc(...)` to wire it up.

## License

GPL-3.0 — free and open source.

## Commercial licensing

Need to use @imqueue/mcp in a closed-source product, or want commercial support? A commercial license is available — see [imqueue.com](https://imqueue.com).
Full docs: **[imqueue.org/mcp](https://imqueue.org/mcp/)**. See [SPEC.md](./SPEC.md) for the design and registry-distribution plan.
