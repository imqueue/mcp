// Shared @imqueue MCP server factory. Every tool is registered here once and the
// server runs in one of two modes:
//
//   * "local"  — runs on the developer's machine (stdio entry: index.ts). Serves
//                the shared docs/scaffold tools PLUS the CLI-backed tools, which
//                drive the real `imq` binary. Their handlers are INJECTED via
//                `cli` so this module never imports node:child_process (keeps the
//                remote/edge bundle clean).
//   * "remote" — hosted over HTTP (worker/worker.ts, e.g. mcp.imqueue.org). Serves
//                the shared tools plus a setup guide. The CLI-backed tools are NOT
//                REGISTERED here: a hosted server cannot reach the caller's machine,
//                so offering them would advertise a capability it does not have.
//
// Registration is gated by mode rather than the handlers branching on it, which is
// what keeps the hosted surface honest: every tool it lists it can actually run,
// and all of them are read-only. Both directories (OpenAI's app directory and the
// Anthropic Connectors Directory) check that a tool's name, description and
// annotations match its real behaviour, and Anthropic rejects outright any single
// tool that spans safe and unsafe operations. See worker/README.md.
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

/**
 * What a tool does to the world it runs in:
 *
 *   read        — computes or fetches; changes nothing.
 *   write       — creates or modifies something, but does not damage what is there.
 *   destructive — at least ONE of the operations it accepts overwrites, deletes or
 *                 stops something. The hint describes the tool's worst case, not
 *                 its typical one, so a mixed-action tool is `destructive`.
 */
type ToolKind = "read" | "write" | "destructive";

/**
 * Tool metadata: a human-facing title plus the behaviour hints.
 *
 * `title` is emitted BOTH at the top level (current spec) and inside `annotations`
 * (where older clients look), so every client shows a real name.
 *
 * The hints are not decoration — clients use `readOnlyHint` to decide what may run
 * without asking the user, and both public directories require all three to be
 * present AND to match observable behaviour. Understating is the dangerous
 * direction: it reads as mislabelling.
 *
 * `openWorld` means the tool touches something outside this process whose state is
 * not ours — a public website, the npm registry, a running service. Reading a
 * catalogue compiled into the build is NOT open-world; fetching a page from
 * imqueue.org is, because the page can change between two identical calls.
 */
function meta(title: string, kind: ToolKind, openWorld: boolean) {
  const hints = {
    readOnlyHint: kind === "read",
    destructiveHint: kind === "destructive",
    openWorldHint: openWorld,
  };
  return { title, annotations: { title, ...hints } };
}

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

/** How to install the full local server — the payload of local_install_guide. */
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

/**
 * Docs search, package catalogue and offline scaffolding. Identical in both modes,
 * and read-only throughout — nothing here writes a file or runs a process.
 */
function registerSharedTools(server: McpServer): void {
  server.registerTool(
    "search_docs",
    {
      ...meta("Search @imqueue documentation", "read", true), // reads live pages from imqueue.org
      description:
        // Do NOT name the covered packages here. The symbol index is fetched from
        // /api/search-index.json at runtime, so it grows whenever another package's
        // reference is published — this description said "@imqueue/core and
        // @imqueue/rpc" while the index already carried pg-pubsub, pg-cache and
        // tag-cache, which is worse than saying nothing: an agent reading it has no
        // reason to search for a symbol that is in fact indexed.
        "Search the official @imqueue docs (guides, tutorial, CLI manual, articles) and every exported symbol of every @imqueue package that publishes a generated API reference, returning the most relevant pages with their URLs. Each result names the package it belongs to. Takes a plain question or an exact symbol name such as 'RedisQueue.send', 'PgPubSub.listen' or 'watcherCheckDelay'. Answers 'how do I do X in @imqueue' and confirms a signature before code is written against it. Every result carries the page URL, which get_doc reads in full.",
      inputSchema: {
        query: z.string().describe("A question or a symbol name, e.g. 'expose a service method', 'delayed jobs' or 'IMQOptions.safeDelivery'"),
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
      ...meta("Read an @imqueue doc page", "read", true), // fetches a live page from imqueue.org (host-locked)
      description:
        "Fetch the full markdown of an @imqueue documentation page by its URL (as returned by search_docs). Returns plain markdown suitable for reading and quoting. Only imqueue.org URLs are fetched; anything else is refused.",
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
      ...meta("List @imqueue packages", "read", false), // renders a catalogue compiled into the build
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
      ...meta("Scaffold an @imqueue service", "read", false), // returns generated source text; writes nothing
      description:
        "Generate an idiomatic @imqueue/rpc service (an IMQService subclass with @expose()d, JSDoc-typed methods) plus a bootstrap that starts it. Provide the methods you want, or omit them for a starter template. Returns source text only — it writes no files.",
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
      ...meta("Scaffold an @imqueue typed client", "read", false), // returns generated source text; writes nothing
      description:
        "Show how to generate and use the fully-typed client for an @imqueue service. @imqueue generates the real client from a running service (via `imq client generate`), so this returns that command plus an illustrative usage snippet. Returns text only — it writes no files.",
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
}

/**
 * The CLI-backed tools — LOCAL MODE ONLY. Every one of these acts on the machine
 * the server runs on: its `imq` binary, its project files, its service processes,
 * its logs. That is exactly why they are not registered on the hosted server.
 */
function registerCliTools(server: McpServer, cli: CliHandlers): void {
  server.registerTool(
    "cli_status",
    {
      ...meta("Check the @imqueue CLI", "read", false), // inspects a local binary
      description:
        "Detect whether the `imq` CLI (@imqueue/cli) is installed on this machine and report its version. create_service and generate_client need it; the scaffold_service and scaffold_client tools do not.",
      inputSchema: {},
    },
    async () => {
      try {
        return text(await cli.cliStatus());
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cli_help",
    {
      ...meta("Show @imqueue CLI help", "read", false), // shells out to a local binary, read-only
      description:
        "Run `imq [command] --help` and return the exact, version-accurate flags for a command (e.g. 'service create', 'client generate'). The flags it lists are the ones create_service accepts. Read-only: it prints help and exits.",
      inputSchema: {
        command: z.string().optional().describe("A subcommand, e.g. 'service create' (omit for top-level help)"),
      },
    },
    async ({ command }) => {
      try {
        return text(await cli.cliHelp(command));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_service",
    {
      // Not "destructive" — it creates a new project rather than damaging an
      // existing one — but it is open-world, because apply=true can configure a
      // VCS remote and push to it.
      ...meta("Create an @imqueue service with the CLI", "write", true),
      description:
        "Scaffold a real, provider-wired @imqueue service via `imq service create`. Runs as a DRY-RUN by default: it shows the plan and writes nothing. With apply=true it writes files into the target directory and may initialise git, configure CI and push to a remote. Accepts `imq` flags (cli_help lists them) to avoid interactive prompts. Requires the `imq` CLI.",
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
      try {
        return text(await cli.createService({ name, path, flags, cwd, apply }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "generate_client",
    {
      ...meta("Generate a typed client with the CLI", "write", true), // introspects a live service over its queue
      description:
        "Run `imq client generate <Service>` to emit the real, fully-typed client, writing it into the output directory. The target service must be RUNNING — the CLI introspects the live service over its message queue. Requires the `imq` CLI.",
      inputSchema: {
        service: z.string().describe("Service name to generate a client for, e.g. 'User' / 'UserService'"),
        path: z.string().optional().describe("Output directory (optional)"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ service, path, cwd }) => {
      try {
        return text(await cli.generateClient(service, path, cwd));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "cli_install",
    {
      // Destructive: a global install replaces whatever `imq` is already there.
      // Open-world: it downloads from the npm registry.
      ...meta("Install the @imqueue CLI", "destructive", true),
      description:
        "Install @imqueue/cli globally via `npm install -g @imqueue/cli`, replacing any `imq` already installed. cli_status reports whether it is already present. A global install may require a user-writable npm prefix or elevated permissions.",
      inputSchema: {
        version: z.string().optional().describe("npm version/tag to install (default 'latest')"),
      },
    },
    async ({ version: v }) => {
      try {
        return text(await cli.installCli(v));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "fleet",
    {
      // `status` is read-only but `stop`/`restart` kill running processes, and the
      // hint describes the worst case the tool accepts.
      ...meta("Control the local @imqueue services fleet", "destructive", false),
      description:
        "Run `imq ctl <action>` over a directory of service repositories. `status` reports what is running and changes nothing; `start`, `stop` and `restart` change which processes are running on this machine. Requires the `imq` CLI.",
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
      try {
        return text(await cli.fleet({ action, path, services, update, calm, verbose, cwd }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "config",
    {
      // `set` overwrites an existing value; `init` rewrites the file.
      ...meta("Manage @imqueue CLI configuration", "destructive", false),
      description:
        "Run `imq config <action>`. `check` = is config initialized; `get [option]` = read a value (or list all); `set option value` = overwrite a value (nested keys use a dot-path, e.g. 'ci.provider'); `init` = interactive setup, which will time out when run non-interactively, so `set` is the automatable one. Requires the `imq` CLI.",
      inputSchema: {
        action: z.enum(["check", "get", "set", "init"]).describe("Config operation"),
        option: z.string().optional().describe("Config key (dot-path for nested), for get/set"),
        value: z.string().optional().describe("Value to set (required for `set`)"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ action, option, value, cwd }) => {
      try {
        return text(await cli.config({ action, option, value, cwd }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "logs",
    {
      // `clean` deletes the collected logs.
      ...meta("Read or clean @imqueue fleet logs", "destructive", false),
      description:
        "Work with logs of services started by `imq ctl`. action='dump' (default) returns the current combined logs and exits — it never follows/streams, and output is capped. action='clean' deletes the collected log files. Requires the `imq` CLI.",
      inputSchema: {
        action: z.enum(["dump", "clean"]).optional().describe("dump = read current logs (default); clean = delete collected logs"),
        services: z.string().optional().describe("Comma-separated service names; omit to combine all"),
        prefix: z.boolean().optional().describe("Prefix each line with the service name (default true)"),
        cwd: z.string().optional().describe("Working directory to run in"),
      },
    },
    async ({ action, services, prefix, cwd }) => {
      try {
        return text(await cli.logs({ action, services, prefix, cwd }));
      } catch (e) {
        return fail(e);
      }
    },
  );
}

/**
 * Remote-only. The hosted server does not offer the CLI-backed tools, so it needs
 * a discoverable answer to "how do I get the ones that act on my machine?".
 * Returns instructions — it installs nothing, which is why it is not called
 * `install_locally`.
 */
function registerInstallGuide(server: McpServer): void {
  server.registerTool(
    "local_install_guide",
    {
      ...meta("How to install the @imqueue MCP server locally", "read", false), // returns static text
      description:
        "Return the setup instructions for running the full @imqueue MCP server on your own machine. The local server adds the CLI-backed tools, which act on your project files and running services and so cannot be offered by a hosted server. Returns instructions only — it installs nothing.",
      inputSchema: {},
    },
    async () => text(LOCAL_INSTALL),
  );
}

/**
 * Create a fully-configured @imqueue MCP server.
 * @param version  Version string to report (kept in sync with package.json by the caller).
 * @param mode     "local" (docs + scaffold + CLI tools) or "remote" (docs + scaffold + install guide).
 * @param cli      CLI-backed handlers; required for the CLI tools to be registered at all.
 */
export function createServer(opts: { version: string; mode: Mode; cli?: CliHandlers }): McpServer {
  const { version, mode, cli } = opts;
  const server = new McpServer({ name: "imqueue", version });

  registerSharedTools(server);

  // `cli` is what actually makes the CLI tools work, so it — not the mode string
  // alone — decides whether they are advertised. A "local" server built without
  // handlers falls back to the hosted surface instead of listing tools that would
  // throw.
  if (mode === "local" && cli) {
    registerCliTools(server, cli);
  } else {
    registerInstallGuide(server);
  }

  return server;
}
