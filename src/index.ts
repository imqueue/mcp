#!/usr/bin/env node
// @imqueue MCP server — local (stdio) entry point. Exposes @imqueue docs search,
// scaffolding and CLI/fleet tools to AI coding agents (Claude Code, Cursor, …).
// The hosted (HTTP) entry lives in worker/worker.ts; both share ./server.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";

import { createServer } from "./server.js";
import { cliStatus, cliHelp, createService, generateClient, installCli, fleet, config, logs } from "./cli.js";

// Read the version from package.json at runtime so it always matches the
// published package (no hardcoded string to keep in sync).
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const server = createServer({
  version,
  mode: "local",
  cli: { cliStatus, cliHelp, createService, generateClient, installCli, fleet, config, logs },
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs; stdout is the JSON-RPC channel.
  console.error("@imqueue MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
