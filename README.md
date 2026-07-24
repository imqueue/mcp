# @imqueue/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[@imqueue](https://imqueue.org)**. It lets AI coding agents (Claude Code, Cursor, VS Code, JetBrains, …) **search the @imqueue documentation**, **scaffold typed services & clients**, and **drive the `imq` CLI** — so they generate correct, idiomatic @imqueue code instead of guessing.

📖 **Full documentation: [imqueue.org/mcp](https://imqueue.org/mcp/)** — per-client setup, complete tools reference, agent workflows and the safety model.

## Tools

| Tool | What it does |
|---|---|
| `search_docs` | Search the official docs (guides, tutorial, CLI manual, API reference, articles) and return the most relevant pages + URLs. |
| `get_doc` | Fetch the full markdown of a doc page by URL. |
| `list_packages` | List the main @imqueue packages with install commands. |
| `scaffold_service` | Generate an `IMQService` subclass with `@expose()`d, JSDoc-typed methods + a bootstrap (offline, no CLI needed). |
| `scaffold_client` | Show how to generate and use the fully-typed client for a service (offline). |

### CLI-backed tools (require `@imqueue/cli` on PATH)

When the `imq` CLI is installed locally, these drive the **real** CLI:

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

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # run from source with tsx
npm run smoke      # JSON-RPC handshake + tools/list + tool calls
```

## Example

> **User:** *"Create an @imqueue user service with a getUser(id) method."*
>
> The agent calls `scaffold_service({ name: "user", methods: [{ name: "getUser", params: [{ name: "id", type: "number" }], returns: "User" }] })` and gets a ready-to-paste `UserService` + bootstrap, then `search_docs("run a service")` / `get_doc(...)` to wire it up.

## License

GPL-3.0 — free and open source.

## Commercial licensing

Need to use @imqueue/mcp in a closed-source product, or want commercial support? A commercial license is available — see [imqueue.com](https://imqueue.com).
Full docs: **[imqueue.org/mcp](https://imqueue.org/mcp/)**. See [SPEC.md](./SPEC.md) for the design and registry-distribution plan.
