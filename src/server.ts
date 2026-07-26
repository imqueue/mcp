// Shared @imqueue MCP server factory. Every tool is registered here once and the
// server runs in one of two modes:
//
//   * "local"  — runs on the developer's machine (stdio entry: index.ts). The
//                CLI-backed tools drive the real `imq` binary. Their handlers are
//                INJECTED via `cli` so this module never imports node:child_process
//                (keeps the remote/edge bundle clean).
//   * "remote" — hosted over HTTP (worker/worker.ts, e.g. mcp.imqueue.org). Docs
//                search + scaffolding work fully; the CLI/fleet tools can't touch
//                the user's machine, so they return a "run me locally" hand-off —
//                and, where it makes sense, the equivalent offline scaffold inline.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { searchDocs, getDoc } from "./docs.js";
import { renderPackages } from "./packages.js";
import { scaffoldService, scaffoldClient, type MethodSpec } from "./scaffold.js";

export type Mode = "local" | "remote";

/**
 * The CLI-backed handlers, injected only in local mode. Declared explicitly (not
 * `typeof import("./cli.js")`) so this shared module has NO type dependency on the
 * node-only cli.ts — that keeps the edge/remote bundle and its type-check free of
 * node:child_process. The local entry (index.ts) supplies the real functions and
 * the compiler verifies they still match this shape.
 */
export interface CliHandlers {
  cliStatus(): Promise<string>;
  cliHelp(command?: string): Promise<string>;
  createService(opts: {
    name: string;
    path?: string;
    flags?: string[];
    cwd?: string;
    apply?: boolean;
  }): Promise<string>;
  generateClient(service: string, path?: string, cwd?: string): Promise<string>;
  installCli(version?: string): Promise<string>;
  fleet(opts: {
    action: "start" | "stop" | "restart" | "status";
    path?: string;
    services?: string;
    update?: boolean;
    calm?: boolean;
    verbose?: boolean;
    cwd?: string;
  }): Promise<string>;
  config(opts: {
    action: "check" | "get" | "set" | "init";
    option?: string;
    value?: string;
    cwd?: string;
  }): Promise<string>;
  logs(opts: { action?: "dump" | "clean"; services?: string; prefix?: boolean; cwd?: string }): Promise<string>;
}

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
          optional: z
            .boolean()
            .optional()
            .describe(
              "Mark the parameter optional. @expose() publishes required " +
                "parameters as mandatory, so callers of the generated client " +
                "must pass a value for every non-optional one — set this for " +
                "any parameter a caller may legitimately skip.",
            ),
        }),
      )
      .optional(),
    returns: z.string().optional().describe("TypeScript return type WITHOUT Promise<> — e.g. 'User' or 'string'"),
  })
  .strict();

/** How to install the full local server — surfaced by the remote hand-off + install_locally. */
export const LOCAL_INSTALL = [
  "Install the full @imqueue MCP server locally — it runs via `npx`, no build step:",
  "",
  "• Claude Code:",
  "    `claude mcp add imqueue -- npx -y @imqueue/mcp`",
  "",
  "• Cursor / Cline / Windsurf / other clients — add to your MCP config:",
  "```json",
  '{ "mcpServers": { "imqueue": { "command": "npx", "args": ["-y", "@imqueue/mcp"] } } }',
  "```",
].join("\n");

/** Build a "this tool is local-only on the hosted server" response, optionally with an inline offline equivalent. */
const handoff = (tool: string, why: string, offlineEquivalent?: string) =>
  text(
    `\`${tool}\` runs on **your machine** ${why}, so it isn't available on the hosted (\`mcp.imqueue.org\`) server.\n\n` +
      LOCAL_INSTALL +
      (offlineEquivalent
        ? `\n\n---\n\nMeanwhile, here's an offline equivalent you can use right now:\n\n${offlineEquivalent}`
        : ""),
  );

/**
 * Create a fully-configured @imqueue MCP server.
 * @param version  Version string to report (kept in sync with package.json by the caller).
 * @param mode     "local" (full) or "remote" (docs+scaffold, CLI tools hand off to local).
 * @param cli      CLI-backed handlers; required for the real tools in local mode.
 */
export function createServer(opts: { version: string; mode: Mode; cli?: CliHandlers }): McpServer {
  const { version, mode, cli } = opts;
  const server = new McpServer({ name: "imqueue", version });
  const local = mode === "local" && !!cli;

  // --- Stateless tools: identical in both modes ----------------------------

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
        const body = hits.map((h) => `### ${h.title}  _(${h.section})_\n${h.description}\n${h.url}`).join("\n\n");
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
      description:
        "Return the main @imqueue packages with a one-line summary and install command, so you can pick the right one.",
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

  // --- CLI-backed tools ------------------------------------------------------
  // In local mode they drive the real `imq`. In remote mode each returns a
  // hand-off to the local install (with an inline scaffold where one exists).

  server.registerTool(
    "cli_status",
    {
      title: "Check the @imqueue CLI",
      description:
        "Detect whether the `imq` CLI (@imqueue/cli) is installed locally and report its version. Call this before create_service/generate_client; if it's missing, fall back to scaffold_service/scaffold_client.",
      inputSchema: {},
    },
    async () => {
      if (local) {
        try {
          return text(await cli!.cliStatus());
        } catch (e) {
          return fail(e);
        }
      }
      return handoff("cli_status", "(it inspects the `imq` binary installed on your machine)");
    },
  );

  server.registerTool(
    "cli_help",
    {
      title: "Show @imqueue CLI help",
      description:
        "Run `imq [command] --help` and return the exact, version-accurate flags for a command (e.g. 'service create', 'client generate'). Use this to discover the flags to pass to create_service. No side effects.",
      inputSchema: {
        command: z.string().optional().describe("A subcommand, e.g. 'service create' (omit for top-level help)"),
      },
    },
    async ({ command }) => {
      if (local) {
        try {
          return text(await cli!.cliHelp(command));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff("cli_help", "(it shells out to your local `imq` for version-accurate flags)");
    },
  );

  server.registerTool(
    "create_service",
    {
      title: "Create an @imqueue service with the CLI",
      description:
        "Scaffold a real, provider-wired @imqueue service via `imq service create`. Runs as a DRY-RUN by default (shows the plan, writes nothing). Set apply=true to actually create it — that writes files and may init git / configure CI / push to a remote, so only apply with the user's intent. Pass CLI flags (see cli_help) to avoid interactive prompts. Requires `imq` (see cli_status). On the hosted server this returns an offline scaffold instead.",
      inputSchema: {
        name: z.string().describe("Service name, e.g. 'user'"),
        path: z.string().optional().describe("Target directory (optional)"),
        flags: z
          .array(z.string())
          .optional()
          .describe(
            "Extra `imq` flags, e.g. ['--vcs','github','--ci','github-actions'] or feature selection ['--packages','pg-prisma,validation,opentelemetry,gcp','-D']. Get exact flags from cli_help.",
          ),
        cwd: z.string().optional().describe("Working directory to run in (defaults to the server's cwd)"),
        apply: z.boolean().optional().describe("false/omitted = dry-run preview; true = actually create (writes files)"),
      },
    },
    async ({ name, path, flags, cwd, apply }) => {
      if (local) {
        try {
          return text(await cli!.createService({ name, path, flags, cwd, apply }));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff(
        "create_service",
        "(it writes files into your project and can init git / configure CI / push to a remote)",
        scaffoldService(name),
      );
    },
  );

  server.registerTool(
    "generate_client",
    {
      title: "Generate a typed client with the CLI",
      description:
        "Run `imq client generate <Service>` to emit the real, fully-typed client. The target service must be RUNNING (the CLI introspects the live service). Requires `imq` (see cli_status). On the hosted server this returns an offline client snippet instead.",
      inputSchema: {
        service: z.string().describe("Service name to generate a client for, e.g. 'User' / 'UserService'"),
        path: z.string().optional().describe("Output directory (optional)"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ service, path, cwd }) => {
      if (local) {
        try {
          return text(await cli!.generateClient(service, path, cwd));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff(
        "generate_client",
        "(it introspects a service running on your machine to emit the real typed client)",
        scaffoldClient(service),
      );
    },
  );

  server.registerTool(
    "cli_install",
    {
      title: "Install the @imqueue CLI",
      description:
        "Install @imqueue/cli globally via `npm install -g @imqueue/cli`. Use when cli_status reports it's missing. A global install may require a user-writable npm prefix or elevated permissions.",
      inputSchema: {
        version: z.string().optional().describe("npm version/tag to install (default 'latest')"),
      },
    },
    async ({ version: v }) => {
      if (local) {
        try {
          return text(await cli!.installCli(v));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff("cli_install", "(it installs the `imq` binary onto your machine with npm)");
    },
  );

  server.registerTool(
    "fleet",
    {
      title: "Control the local @imqueue services fleet",
      description:
        "Run `imq ctl <action>` over a directory of service repositories. `status` is read-only; `start`/`stop`/`restart` change running processes. Requires `imq` (see cli_status).",
      inputSchema: {
        action: z.enum(["start", "stop", "restart", "status"]).describe("What to do to the fleet"),
        path: z.string().optional().describe("Directory containing the service repositories (default '.')"),
        services: z.string().optional().describe("Comma-separated service names; omit to scan the path"),
        update: z.boolean().optional().describe("git pull each service before starting (start/restart)"),
        calm: z.boolean().optional().describe("Start services one at a time, waiting for each to be ready"),
        verbose: z.boolean().optional().describe("Verbose output"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ action, path, services, update, calm, verbose, cwd }) => {
      if (local) {
        try {
          return text(await cli!.fleet({ action, path, services, update, calm, verbose, cwd }));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff("fleet", "(it starts/stops and inspects @imqueue service processes running on your machine)");
    },
  );

  server.registerTool(
    "config",
    {
      title: "Manage @imqueue CLI configuration",
      description:
        "Run `imq config <action>`. `check` = is config initialized; `get [option]` = read a value (or list all); `set option value` = write a value (nested keys use a dot-path, e.g. 'ci.provider'); `init` = interactive setup (prefer `set` for automation — `init` will time out non-interactively). Requires `imq` (see cli_status).",
      inputSchema: {
        action: z.enum(["check", "get", "set", "init"]).describe("Config operation"),
        option: z.string().optional().describe("Config key (dot-path for nested), for get/set"),
        value: z.string().optional().describe("Value to set (required for `set`)"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ action, option, value, cwd }) => {
      if (local) {
        try {
          return text(await cli!.config({ action, option, value, cwd }));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff("config", "(it reads/writes the `imq` CLI configuration on your machine)");
    },
  );

  server.registerTool(
    "logs",
    {
      title: "Read or clean @imqueue fleet logs",
      description:
        "Work with logs of services started by `imq ctl`. action='dump' (default) returns the current combined logs and exits — it never follows/streams, and output is capped. action='clean' deletes collected logs. Requires `imq` (see cli_status).",
      inputSchema: {
        action: z.enum(["dump", "clean"]).optional().describe("dump = read current logs (default); clean = delete collected logs"),
        services: z.string().optional().describe("Comma-separated service names; omit to combine all"),
        prefix: z.boolean().optional().describe("Prefix each line with the service name (default true)"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ action, services, prefix, cwd }) => {
      if (local) {
        try {
          return text(await cli!.logs({ action, services, prefix, cwd }));
        } catch (e) {
          return fail(e);
        }
      }
      return handoff("logs", "(it reads logs of @imqueue services running on your machine)");
    },
  );

  // --- Remote-only helper ----------------------------------------------------
  // A discoverable "how do I get the full thing" tool on the hosted server.
  if (!local) {
    server.registerTool(
      "install_locally",
      {
        title: "Install the full @imqueue MCP locally",
        description:
          "Return the exact steps to install the full @imqueue MCP server on your machine (needed for the CLI/fleet tools, which act on your local project and services). The hosted server covers docs search and scaffolding; everything else runs locally.",
        inputSchema: {},
      },
      async () => text(LOCAL_INSTALL),
    );
  }

  return server;
}
