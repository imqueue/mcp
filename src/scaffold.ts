// Code scaffolding for @imqueue — mirrors what `imq service create` /
// `imq client generate` produce, but as inline templates an agent can drop into
// a project. @imqueue is decorator-driven and JSDoc is the source of truth for
// types, so the generated code documents each method with JSDoc.

export interface MethodSpec {
  name: string;
  description?: string;
  params?: {
    name: string;
    type: string;
    description?: string;
    optional?: boolean;
  }[];
  returns?: string; // TypeScript return type (without the Promise<> wrapper)
}

/** One generated source file: what to call it, and what goes in it. */
export interface ScaffoldFile {
  path: string;
  language: string;
  content: string;
}

/**
 * What `scaffoldService` produces, as data.
 *
 * The tools declare an `outputSchema` and return this as `structuredContent`, so
 * a client can write the files straight out instead of parsing code fences from a
 * markdown blob. The markdown a human reads is RENDERED FROM THIS by
 * `renderService` — one source, so the prose and the structure cannot disagree
 * about what the generated code is.
 */
export interface ServiceScaffold {
  /** Class name actually used, after normalisation (`user` -> `UserService`). */
  service: string;
  install: string;
  files: ScaffoldFile[];
  /** The CLI command that does this for real, provider-wired. */
  cliAlternative: string;
}

/** What `scaffoldClient` produces, as data. See {@link ServiceScaffold}. */
export interface ClientScaffold {
  service: string;
  client: string;
  /** Run this against the RUNNING service to emit the real typed client. */
  generateCommand: string;
  /** Where that command writes the generated client. */
  output: string;
  /**
   * An illustrative call, NOT a file to write. Deliberately not called `files`:
   * the real client comes from `generateCommand`, and naming this `files` would
   * invite a client to save a snippet whose types can drift from the service.
   */
  example: { language: string; content: string };
}

function pascal(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

const DEFAULT_METHODS: MethodSpec[] = [
  {
    name: "hello",
    description: "Example method — replace with your own.",
    params: [{ name: "name", type: "string", description: "Who to greet" }],
    returns: "string",
  },
];

function renderMethod(m: MethodSpec): string {
  const params = m.params ?? [];
  const ret = m.returns ?? "void";
  const sig = params
    .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
    .join(", ");
  // JSDoc is the only type source @expose() has, and it reads two things
  // positionally: a `{type}` leading the tag, and `[name]` brackets marking the
  // param optional. Omit the braces and every param is published as `any`;
  // omit the brackets and every param is published as required, which forces
  // callers to pass a value for it explicitly. Always emit both.
  const jsdoc = [
    "    /**",
    `     * ${m.description ?? m.name}`,
    ...params.map((p) => {
      const name = p.optional ? `[${p.name}]` : p.name;
      const desc = p.description ? ` - ${p.description}` : "";

      return `     * @param {${p.type}} ${name}${desc}`;
    }),
    `     * @return {Promise<${ret}>}`,
    "     */",
  ].join("\n");
  const body =
    ret === "void"
      ? "        // TODO: implement"
      : `        // TODO: implement\n        throw new Error('${m.name}() not implemented');`;
  return `${jsdoc}\n    @expose()\n    public async ${m.name}(${sig}): Promise<${ret}> {\n${body}\n    }`;
}

/** Generate an @imqueue/rpc service class + a bootstrap that starts it, as data. */
export function scaffoldService(name: string, methods?: MethodSpec[]): ServiceScaffold {
  const cls = pascal(name).endsWith("Service") ? pascal(name) : `${pascal(name)}Service`;
  const list = methods && methods.length ? methods : DEFAULT_METHODS;
  const body = list.map(renderMethod).join("\n\n");

  const service = `import { IMQService, expose } from '@imqueue/rpc';

export class ${cls} extends IMQService {
${body}
}
`;

  // @imqueue/rpc 3.x is ESM-only, so a relative import needs the explicit
  // .js extension — extensionless is a compile error under NodeNext.
  const bootstrap = `import { ${cls} } from './${cls}.js';

// Start the service so other services can call its @expose()d methods.
// The queue name defaults to the class name; pass a different one as the
// second constructor argument (the first is IMQServiceOptions).
(async () => {
    const service = new ${cls}();
    await service.start();
    console.log('${cls} is up');
})();
`;

  return {
    service: cls,
    install: "npm i @imqueue/rpc",
    files: [
      { path: `${cls}.ts`, language: "typescript", content: service.trimEnd() },
      { path: "index.ts", language: "typescript", content: bootstrap.trimEnd() },
    ],
    cliAlternative: `imq service create ${name}`,
  };
}

/** Render a {@link ServiceScaffold} as the markdown a human reads. */
export function renderService(s: ServiceScaffold): string {
  const label = (f: ScaffoldFile) => (f.path === "index.ts" ? `**${f.path}** (bootstrap)` : `**${f.path}**`);

  return [
    `Install: \`${s.install}\` (needs a running Redis).`,
    ...s.files.flatMap((f) => ["", label(f), "```" + f.language, f.content, "```"]),
    "",
    `Tip: scaffold a full, provider-wired project (VCS/CI/Docker) with the CLI instead: \`${s.cliAlternative}\`.`,
  ].join("\n");
}

/** Generate a typed-client usage snippet for a service, as data. */
export function scaffoldClient(service: string, methods?: MethodSpec[]): ClientScaffold {
  const cls = pascal(service).endsWith("Service") ? pascal(service) : `${pascal(service)}Service`;
  const clientCls = cls.replace(/Service$/, "Client");
  const sample = (methods && methods[0]) || DEFAULT_METHODS[0];
  const args = (sample.params ?? []).map((p) => `/* ${p.name}: ${p.type} */`).join(", ");

  const usage = `import { ${clientCls} } from './clients/${clientCls}.js';

(async () => {
    const client = new ${clientCls}();
    await client.start();

    // Fully-typed remote call — signature comes from ${cls}:
    const result = await client.${sample.name}(${args});
    console.log(result);
})();
`;

  return {
    service: cls,
    client: clientCls,
    generateCommand: `imq client generate ${cls.replace(/Service$/, "")}`,
    output: `./clients/${clientCls}`,
    example: { language: "typescript", content: usage.trimEnd() },
  };
}

/** Render a {@link ClientScaffold} as the markdown a human reads. */
export function renderClient(c: ClientScaffold): string {
  return [
    `@imqueue generates the **real**, fully-typed client from a **running** service, so its types can never drift:`,
    "",
    "```bash",
    `# with ${c.service} running:`,
    c.generateCommand,
    "```",
    "",
    `That emits \`${c.output}\`. Use it like:`,
    "```" + c.example.language,
    c.example.content,
    "```",
    "",
    `The snippet above is illustrative — prefer the generated client so method signatures stay in sync with the service.`,
  ].join("\n");
}
