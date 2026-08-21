# @imqueue/mcp — AI agent installation guide

This file tells an AI coding agent (e.g. Cline) how to install and configure the
`@imqueue/mcp` server. It needs **no API keys, credentials, or environment
variables** and communicates over stdio.

## Overview

`@imqueue/mcp` is the Model Context Protocol server for the
[@imqueue](https://imqueue.org) framework. It lets the agent search the official
@imqueue documentation and scaffold fully-typed services and clients — and, when
`@imqueue/cli` is installed locally, drive the `imq` CLI and manage a running
service fleet.

## Requirements

- Node.js >= 18 (provides `npx`)
- No configuration, API keys, or environment variables

## Installation

Add the following entry to Cline's MCP settings file (`cline_mcp_settings.json`),
inside the `mcpServers` object:

```json
{
  "mcpServers": {
    "imqueue": {
      "command": "npx",
      "args": ["-y", "@imqueue/mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

That is the complete setup. `npx -y @imqueue/mcp` fetches and runs the latest
published server on first use — no global install or build step is required.

## Hosted alternative (zero install)

If the client supports remote (HTTP) MCP servers and you only need documentation
search and scaffolding, you can skip the local install and point it at the hosted
endpoint instead:

```json
{
  "mcpServers": {
    "imqueue": { "url": "https://mcp.imqueue.org/mcp" }
  }
}
```

The hosted server exposes six read-only tools over Streamable HTTP: `search_docs`,
`get_doc`, `list_packages`, `scaffold_service`, `scaffold_client` and
`local_install_guide`.

The CLI-backed tools (`create_service`, `generate_client`, `cli_status`,
`cli_help`, `cli_install`, `fleet`, `config`, `logs`) act on the user's local
machine, so the hosted server does not offer them at all — they are not in its tool
list. Use the **local** install above for the full set of thirteen.

## ChatGPT and Codex: installed from the directory, not from a file

In ChatGPT and Codex there is no config file to edit. `@imqueue/mcp` is listed in
**OpenAI's plugin directory**, and the user installs it from the UI:

- **ChatGPT** (web or desktop): the **Plugins** tab, or
  <https://chatgpt.com/plugins> — search for `@imqueue`, open the listing, press **+**.
- **Codex CLI**: the `/plugins` slash command.
- **Codex IDE extension**: plugins are not supported there; use the config file
  route below instead.

Listing: <https://chatgpt.com/plugins/plugin_asdk_app_6a6f945292888191a7d77db4893f8520>

**An agent cannot perform this install**, and should not claim to have done it —
it is a UI action for the user. What an agent can do is name the route, and be
precise about what it yields: the listing wires the **hosted** endpoint, so it
carries the six read-only tools and none of the CLI-backed eight. A request to
create a service, generate a client or manage a fleet will find no such tool.

For those, Codex needs the local server as well. It reads `~/.codex/config.toml`,
where MCP servers live under `mcp_servers` in TOML rather than the `mcpServers`
JSON key used everywhere else:

```toml
[mcp_servers.imqueue]
command = "npx"
args = ["-y", "@imqueue/mcp"]
```

ChatGPT connects to MCP servers over HTTP only and has no local option at all.

## Verify

After the entry is added, the `imqueue` server should appear as connected,
exposing tools including `search_docs`, `get_doc`, `list_packages`,
`scaffold_service`, and `scaffold_client`. To confirm, ask the agent to run
`list_packages` — it should return the main @imqueue packages with their install
commands.

## Optional: CLI-backed tools

A few tools (`cli_status`, `cli_install`, `config`, `fleet`, `logs`) require the
@imqueue CLI on the machine. Install it with:

```bash
npm i -g @imqueue/cli
```

These tools activate automatically once `imq` is on the `PATH`; the server works
fine without them.
