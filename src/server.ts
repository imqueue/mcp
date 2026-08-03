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

import { searchDocs, getDoc, suggest, setUserAgent } from "./docs.js";
import { renderPackages, PACKAGES } from "./packages.js";
import {
  scaffoldService,
  scaffoldClient,
  renderService,
  renderClient,
  type MethodSpec,
} from "./scaffold.js";

export type Mode = "local" | "remote";

/**
 * Display identity, MIRRORED FROM server.json.
 *
 * server.json is the registry record and stays the single source of truth for
 * these values, but it is not in the published tarball (`files` ships `dist` and
 * SPEC.md only), so importing it from here would resolve at runtime in the repo
 * and throw for everyone who installed from npm. Hence a copy, with
 * `test/identity.test.ts` asserting the two agree — the drift this guards against
 * is a title changed in one place and read from the other.
 *
 * `icons` is deliberately NOT mirrored: whether any client renders
 * `serverInfo.icons` today is unverified, and server.json already carries them for
 * the registries that document using them.
 */
export const IDENTITY = {
  /** Human-readable display name; what a client shows instead of the bare id. */
  title: "@imqueue",
  websiteUrl: "https://imqueue.org/mcp/",
} as const;

/**
 * The one piece of server-controlled text that reaches the host model's SYSTEM
 * PROMPT rather than a tool description. Claude Code, Claude Desktop, Cursor and
 * VS Code all splice it in at connect time.
 *
 * So it is operating RULES, not a description of the server: the model already
 * knows what a docs server is, and what it does not know is that its @imqueue
 * priors are wrong in specific, silent ways. Every line below is a failure this
 * server exists to prevent and that compiles cleanly when it happens — a missing
 * `@expose()`, an undocumented parameter published as `any`, a hand-written
 * client, two mutually exclusive packages installed side by side.
 *
 * Kept short on purpose: this is charged to every request on every connection, so
 * `test/identity.test.ts` caps it at 150 words. Anything that is merely useful
 * belongs in a tool description, which is only charged when the tool is listed.
 */
export const INSTRUCTIONS = [
  "Do not recall @imqueue from memory — it is decorator-driven, and the mistakes below compile cleanly.",
  "",
  "1. Call search_docs before writing or changing @imqueue code, and get_doc to read a page in full. Never infer an API name or signature; the docs win over recall.",
  "2. Call list_packages before adding an @imqueue dependency: some pairs are mutually exclusive (pg-prisma/pg-sequelize, opentelemetry/datadog) and installing both breaks silently.",
  "3. Every remotely callable method needs @expose() and a complete typed JSDoc block: JSDoc is the only runtime type source, so an undocumented parameter is published as `any`.",
  "4. A class crossing the RPC boundary needs @classType() on the class and @property() on every field, or the generated client types it `any`.",
  "5. Clients are generated from a running service with `imq client generate` — never hand-written.",
  "6. Cite the page URL for any fact from these tools.",
].join("\n");

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

/**
 * A result with both faces: the markdown a human reads, and the same answer as
 * data for a client that would rather not parse prose.
 *
 * Every tool that declares an `outputSchema` must return `structuredContent`
 * matching it, and both are sent — dropping the text would regress any client
 * that only renders `content`.
 */
const both = <T>(t: string, data: T) => ({
  content: [{ type: "text" as const, text: t }],
  structuredContent: data as Record<string, unknown>,
});

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

/**
 * How to install the full local server, as data — the structuredContent of
 * local_install_guide. A client can write `clientConfig` straight into an MCP
 * config file rather than lifting it out of a code fence.
 */
export const LOCAL_INSTALL_CONFIG = {
  claudeCodeCommand: "claude mcp add imqueue -- npx -y @imqueue/mcp",
  clientConfig: {
    mcpServers: {
      imqueue: { command: "npx", args: ["-y", "@imqueue/mcp"] },
    },
  },
};

/**
 * The human-facing version of the same thing. RENDERED from the config above so
 * the instructions and the machine-readable config cannot drift apart — the last
 * thing this tool should do is print one command and return another.
 */
export const LOCAL_INSTALL = [
  "Install the full @imqueue MCP server locally — it runs via `npx`, no build step:",
  "",
  "• Claude Code:",
  `    \`${LOCAL_INSTALL_CONFIG.claudeCodeCommand}\``,
  "",
  "• Cursor / Cline / Windsurf / other clients — add to your MCP config:",
  "```json",
  JSON.stringify(LOCAL_INSTALL_CONFIG.clientConfig),
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
        "Search the official @imqueue docs (guides, tutorial, CLI manual, articles) and every exported symbol of every @imqueue package that publishes a generated API reference, returning the most relevant pages with their URLs. Each result names the package it belongs to. Takes a plain question or an exact symbol name such as 'RedisQueue.send', 'PgPubSub.listen' or 'watcherCheckDelay'. Answers 'how do I do X in @imqueue' and confirms a signature before code is written against it. Every result carries the page URL, which get_doc reads in full. Some capabilities are covered by two mutually exclusive packages — @imqueue/pg-prisma vs @imqueue/pg-sequelize, @imqueue/opentelemetry vs @imqueue/datadog — so for a query like 'tracing' or 'database', call list_packages for the choosing rule rather than taking whichever package ranks first, and pass `package` here to search within the one you settled on.",
      inputSchema: {
        // Bounded because it was not: 200 kB in — a pasted stack trace is a
        // realistic way to get there — produced 400,190 B out, the query reflected
        // once in the prose and once in structuredContent.
        query: z
          .string()
          .min(1)
          .max(200)
          .describe("A question or a symbol name, e.g. 'expose a service method', 'delayed jobs' or 'IMQOptions.safeDelivery'"),
        limit: z.number().int().min(1).max(20).optional().describe("Max results (default 6)"),
        package: z
          .string()
          .optional()
          .describe(
            "Restrict results to one package, e.g. 'http-protect' or '@imqueue/opentelemetry'. Use it once you know which package you want — the same words appear in several packages' symbols.",
          ),
      },
      // Structured results are the point of this tool: a client should be able to
      // take `results[0].url` and hand it to get_doc without regexing the prose.
      outputSchema: {
        query: z.string().describe("The query that was searched"),
        count: z.number().int().describe("Number of results returned (0 means no matches)"),
        results: z
          .array(
            z.object({
              title: z.string(),
              section: z.string().describe("Where it sits in the docs, e.g. 'Guides' or 'API · @imqueue/core property'"),
              description: z.string(),
              url: z.string().describe("Pass this to get_doc to read the page in full"),
              symbol: z.boolean().optional().describe("True for a generated API-reference page rather than prose"),
            }),
          )
          .describe("Most relevant first"),
      },
    },
    async ({ query, limit, package: pkg }) => {
      try {
        const hits = await searchDocs(query, limit ?? 6, pkg);
        const results = hits.map((h) => ({
          title: h.title,
          section: h.section,
          description: h.description,
          url: h.url,
          ...(h.symbol ? { symbol: true } : {}),
        }));

        // A miss is still a successful call with an empty result set — the text
        // says so in words, the structure says so with count: 0.
        //
        // What it says MATTERS: "try broader terms" is advice the model already
        // had, and a model that gets nothing twice stops asking and answers from
        // its priors. So name what the corpus contains and the real vocabulary
        // nearest the query, which is information it cannot have.
        if (!hits.length) {
          const { sections, nearest } = await suggest(query);
          const lines = [
            `No matches for "${query}"${pkg ? ` in ${pkg}` : ""}.`,
            "",
            `This index covers: ${sections.join(", ")}.`,
          ];

          if (nearest.length) {
            lines.push("", `Indexed terms nearest your query: ${nearest.join(", ")}.`);
          }

          if (pkg) {
            lines.push("", "Drop the `package` filter to search the whole corpus.");
          }

          lines.push("", "call list_packages for the full catalogue of what exists.");

          return both(lines.join("\n"), { query, count: 0, results });
        }

        const body = hits.map((h) => `### ${h.title}  _(${h.section})_\n${h.description}\n${h.url}`).join("\n\n");

        return both(`${hits.length} result(s) for "${query}":\n\n${body}\n\nRead any page in full with get_doc(url).`, {
          query,
          count: results.length,
          results,
        });
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
        "Fetch the full markdown of an @imqueue documentation page by its URL (as returned by search_docs). Returns plain markdown suitable for reading and quoting. Only imqueue.org (framework docs) and imqueue.com (licensing, pricing, support) URLs are fetched; anything else is refused. Very large pages are truncated, which the result reports.",
      inputSchema: {
        url: z.string().describe("An imqueue.org or imqueue.com page URL, e.g. https://imqueue.org/get-started/"),
      },
      // METADATA ONLY — the page body is deliberately NOT in here.
      //
      // A schema obliges the server to send `structuredContent` (the SDK throws
      // without it), but nothing says structuredContent must repeat what is in
      // `content`. It describes the structured PART of the answer. So the page
      // travels once, in `content`, and this box carries only the facts a caller
      // would otherwise have to parse back out of the text or guess at.
      //
      // Putting `markdown` in here as well would have doubled the largest
      // response the server can produce: measured on /api/rpc/latest/, 16.6 kB of
      // text plus 16.6 kB of structure, 33 kB to read one page. There is no field
      // below that costs more than a few dozen bytes, and no client has to read
      // the body twice to get it.
      //
      // Note the absence of a body field is self-describing: a caller reading this
      // schema sees url/mimeType/bytes and no content field, so it knows the page
      // itself is in `content`. Which is where every client already looks.
      outputSchema: {
        url: z.string().describe("The markdown mirror actually fetched — not always the URL passed in, which is why it is worth returning"),
        mimeType: z.string().describe("Media type of the page body carried in content"),
        bytes: z.number().int().describe("Size of the page body, so a caller can decide before reading it"),
        truncated: z
          .boolean()
          .describe("True when the page was too large to return whole — content holds the leading part only"),
      },
    },
    async ({ url }) => {
      try {
        const doc = await getDoc(url);

        return {
          content: [{ type: "text" as const, text: `Source: ${doc.url}\n\n${doc.markdown}` }],
          structuredContent: {
            url: doc.url,
            mimeType: "text/markdown",
            bytes: doc.markdown.length,
            truncated: doc.truncated,
          },
        };
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
        "The complete, authoritative catalogue of documented @imqueue packages, each with a one-line summary and its exact install command. Call this BEFORE adding any @imqueue dependency: search_docs can only find a package you already suspect exists, and this is the list. Covers typed RPC over a message queue, the Redis queue engine, the `imq` CLI, jobs and scheduling, Prisma and Sequelize database toolkits, method caching, tag-invalidated caching, PostgreSQL LISTEN/NOTIFY, Zod validation, OpenTelemetry or Datadog tracing, async logging, GraphQL N+1 batching across services, CIDR/IP checks and HTTP rate limiting. Some pairs are mutually exclusive — pg-prisma vs pg-sequelize, opentelemetry vs datadog — and installing both of a pair breaks silently, so read the `pick` rule on those entries before choosing.",
      inputSchema: {},
      outputSchema: {
        packages: z
          .array(
            z.object({
              name: z.string(),
              install: z.string().describe("The exact install command, including -g where the package is a CLI"),
              summary: z.string(),
              pick: z
                .string()
                .optional()
                .describe("Present only where two packages cover similar ground: the rule for choosing between them"),
            }),
          )
          .describe("Ordered by what to reach for first"),
      },
    },
    async () => {
      try {
        return both(renderPackages(), { packages: PACKAGES });
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
        "Generate an idiomatic @imqueue/rpc service (an IMQService subclass with @expose()d, JSDoc-typed methods) plus a bootstrap that starts it. Provide the methods you want, or omit them for a starter template. Any non-primitive parameter or return type also gets a types.ts with the required @classType()/@property() declarations — without those the generated client types it `any`, which compiles. Returns source text only — it writes no files.",
      inputSchema: {
        name: z.string().describe("Service name, e.g. 'user' or 'UserService'"),
        methods: z.array(methodSchema).optional().describe("Methods to expose"),
      },
      // Files come out as a list with paths, so a client can write them directly
      // instead of splitting code fences out of the markdown and guessing names.
      outputSchema: {
        service: z.string().describe("Class name used, after normalisation ('user' -> 'UserService')"),
        install: z.string(),
        files: z.array(
          z.object({
            path: z.string(),
            language: z.string(),
            content: z.string(),
          }),
        ),
        types: z
          .array(z.string())
          .describe(
            "Complex types the signatures refer to. Each needs @classType() on the class and @property() on every field — types.ts declares them; complete the fields. Empty when every type is a primitive.",
          ),
        cliAlternative: z.string().describe("The CLI command that creates a full provider-wired project instead"),
      },
    },
    async ({ name, methods }) => {
      try {
        const scaffold = scaffoldService(name, methods as MethodSpec[] | undefined);
        return both(renderService(scaffold), scaffold);
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
        "Show how to generate and use the fully-typed client for an @imqueue service. @imqueue generates the real client from a running service (via `imq client generate`), so this returns that command plus an illustrative usage snippet. The generated file exports a single namespace holding the client class, so the import shape is not the obvious one — take it from `namespace` rather than guessing. Returns text only — it writes no files.",
      inputSchema: {
        service: z.string().describe("The service to call, e.g. 'user' or 'UserService'"),
        methods: z.array(methodSchema).optional().describe("Known methods (used to shape the example call)"),
      },
      // `example` rather than `files`: the real client comes from
      // generateCommand, and calling this `files` would invite a client to save a
      // snippet whose types can drift away from the service.
      outputSchema: {
        service: z.string(),
        client: z.string().describe("Generated client class name"),
        namespace: z
          .string()
          .describe(
            "The ONLY export of the generated file: a namespace holding the client class. Import this, then `new <namespace>.<client>()` — importing the class directly does not resolve.",
          ),
        generateCommand: z.string().describe("Run against the RUNNING service to emit the real typed client"),
        output: z.string().describe("The file that command writes (a compiled .js lands beside it)"),
        example: z
          .object({ language: z.string(), content: z.string() })
          .describe("An illustrative call — not a file to write"),
      },
    },
    async ({ service, methods }) => {
      try {
        const scaffold = scaffoldClient(service, methods as MethodSpec[] | undefined);
        return both(renderClient(scaffold), scaffold);
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
      outputSchema: {
        claudeCodeCommand: z.string().describe("One-liner for Claude Code"),
        clientConfig: z
          .object({
            mcpServers: z.object({
              imqueue: z.object({ command: z.string(), args: z.array(z.string()) }),
            }),
          })
          .describe("Drop into an MCP config file as-is. VS Code and Visual Studio use `servers` with type:'stdio' instead of `mcpServers`."),
      },
    },
    async () => both(LOCAL_INSTALL, LOCAL_INSTALL_CONFIG),
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

  // imqueue.org classifies its traffic by user agent — that is what its whole
  // agent-analytics edge is for — and these feed requests arrived with nothing to
  // identify them, so the server's own reads were indistinguishable from any other
  // caller's. Set here because this is the only place the running version is known.
  setUserAgent(`imqueue-mcp/${version} (+https://imqueue.org/mcp/)`);

  const server = new McpServer(
    { name: "imqueue", version, ...IDENTITY },
    // `instructions` is stored by the SDK and returned from `initialize`; without
    // ServerOptions here it was simply absent, and whether the host reached for
    // search_docs instead of answering from its priors was left to tool-description
    // matching — which loses to the model's prior.
    { instructions: INSTRUCTIONS },
  );

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
