#!/usr/bin/env node
// @imqueue MCP server — exposes @imqueue docs search and service/client
// scaffolding to AI coding agents (Claude Code, Cursor, …) over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createRequire } from "node:module";

import { searchDocs, getDoc } from "./docs.js";
import { renderPackages } from "./packages.js";
import { scaffoldService, scaffoldClient, type MethodSpec } from "./scaffold.js";

// Read the version from package.json at runtime so it always matches the
// published package (no hardcoded string to keep in sync).
const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  isError: true,
});

const methodSchema = z
  .object({
    name: z.string().describe("Method name"),
    description: z.string().optional().describe("What the method does"),
    params: z
      .array(
        z.object({
          name: z.string(),
          type: z.string().describe("TypeScript type, e.g. 'string' or 'number[]'"),
          description: z.string().optional(),
        }),
      )
      .optional(),
    returns: z.string().optional().describe("TypeScript return type WITHOUT Promise<> — e.g. 'User' or 'string'"),
  })
  .strict();

const server = new McpServer({ name: "imqueue", version });

server.registerTool(
  "search_docs",
  {
    title: "Search @imqueue documentation",
    description:
      "Search the official @imqueue docs (guides, tutorial, CLI manual, API reference, articles) and return the most relevant pages with their URLs. Use this first when asked how to do something in @imqueue, then get_doc to read a page in full.",
    inputSchema: {
      query: z.string().describe("What you want to find, e.g. 'expose a service method' or 'delayed jobs'"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 6)"),
    },
  },
  async ({ query, limit }) => {
    try {
      const hits = await searchDocs(query, limit ?? 6);
      if (!hits.length) return text(`No matches for "${query}". Try broader terms or call list_packages.`);
      const body = hits
        .map((h) => `### ${h.title}  _(${h.section})_\n${h.description}\n${h.url}`)
        .join("\n\n");
      return text(`${hits.length} result(s) for "${query}":\n\n${body}\n\nRead any page in full with get_doc(url).`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "get_doc",
  {
    title: "Read an @imqueue doc page",
    description:
      "Fetch the full markdown of an @imqueue documentation page by its URL (as returned by search_docs). Returns plain markdown suitable for reading and quoting.",
    inputSchema: {
      url: z.string().describe("An imqueue.org page URL, e.g. https://imqueue.org/get-started/"),
    },
  },
  async ({ url }) => {
    try {
      const doc = await getDoc(url);
      return text(`Source: ${doc.url}\n\n${doc.markdown}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "list_packages",
  {
    title: "List @imqueue packages",
    description: "Return the main @imqueue packages with a one-line summary and install command, so you can pick the right one.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(renderPackages());
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "scaffold_service",
  {
    title: "Scaffold an @imqueue service",
    description:
      "Generate an idiomatic @imqueue/rpc service (an IMQService subclass with @expose()d, JSDoc-typed methods) plus a bootstrap that starts it. Provide the methods you want, or omit them for a starter template.",
    inputSchema: {
      name: z.string().describe("Service name, e.g. 'user' or 'UserService'"),
      methods: z.array(methodSchema).optional().describe("Methods to expose"),
    },
  },
  async ({ name, methods }) => {
    try {
      return text(scaffoldService(name, methods as MethodSpec[] | undefined));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "scaffold_client",
  {
    title: "Scaffold an @imqueue typed client",
    description:
      "Show how to generate and use the fully-typed client for an @imqueue service. @imqueue generates the real client from a running service (via `imq client generate`), so this returns that command plus an illustrative usage snippet.",
    inputSchema: {
      service: z.string().describe("The service to call, e.g. 'user' or 'UserService'"),
      methods: z.array(methodSchema).optional().describe("Known methods (used to shape the example call)"),
    },
  },
  async ({ service, methods }) => {
    try {
      return text(scaffoldClient(service, methods as MethodSpec[] | undefined));
    } catch (e) {
      return fail(e);
    }
  },
);

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
