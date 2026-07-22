# @imqueue/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for **[@imqueue](https://imqueue.org)**. It lets AI coding agents (Claude Code, Cursor, Windsurf, VS Code, …) **search the @imqueue documentation** and **scaffold typed services & clients** — so they generate correct, idiomatic @imqueue code instead of guessing.

## Tools

| Tool | What it does |
|---|---|
| `search_docs` | Search the official docs (guides, tutorial, CLI manual, API reference, articles) and return the most relevant pages + URLs. |
| `get_doc` | Fetch the full markdown of a doc page by URL. |
| `list_packages` | List the main @imqueue packages with install commands. |
| `scaffold_service` | Generate an `IMQService` subclass with `@expose()`d, JSDoc-typed methods + a bootstrap. |
| `scaffold_client` | Show how to generate and use the fully-typed client for a service. |

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

### Cursor / Windsurf / VS Code / Claude Desktop

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

GPL-3.0. Commercial licensing & support for closed-source products: [imqueue.com](https://imqueue.com).

See [SPEC.md](./SPEC.md) for the full design and registry-distribution plan.
