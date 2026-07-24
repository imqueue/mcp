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
