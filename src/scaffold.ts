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
  /**
   * Complex types named in the requested signatures — anything that is not a
   * primitive or an array of primitives.
   *
   * Each one needs a `@classType()` class with `@property()` on every field
   * before it can cross the RPC boundary; without that the generated client
   * types it `any`, which COMPILES and silently removes the guarantee the
   * framework exists to provide. Empty for an all-primitive service, in which
   * case no `types.ts` is emitted either.
   */
  types: string[];
  /** The CLI command that does this for real, provider-wired. */
  cliAlternative: string;
}

/** What `scaffoldClient` produces, as data. See {@link ServiceScaffold}. */
export interface ClientScaffold {
  service: string;
  client: string;
  /**
   * The namespace the generated file exports, which is the ONLY way in.
   *
   * `IMQClient` emits `export namespace <lowerFirst(ServiceName)> { export class
   * <Name>Client … }` (rpc/src/IMQClient.ts), so there is no top-level export of
   * the client class and `import { UserClient } from …` cannot resolve. This
   * field exists because that is the single fact a caller most needs and cannot
   * infer from `client` alone.
   */
  namespace: string;
  /** Run this against the RUNNING service to emit the real typed client. */
  generateCommand: string;
  /** The file that command writes (it writes a sibling `.js` too). */
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

/** Where the generated client is written, and where the service imports it from. */
const CLIENT_DIR = "./src/clients";

/**
 * Types that reach a generated client correctly with no declaration of their own.
 *
 * `Date` is here because it survives as a JSON string and there is nothing to
 * decorate; everything else is a TypeScript primitive. Anything NOT in this set
 * needs `@classType()` + `@property()`, and the whole point of
 * {@link complexTypes} is that omitting that produces `any` rather than an error.
 */
const PRIMITIVE_TYPES = new Set([
  "string", "number", "boolean", "bigint", "symbol",
  "void", "any", "unknown", "never", "null", "undefined",
  "Date", "object", "Buffer",
]);

/** Strip `Promise<>`, `Array<>`, `readonly` and `[]` down to the bare type name. */
function bareType(type: string): string {
  let bare = type.trim();

  for (;;) {
    const next = bare
      .replace(/^readonly\s+/, "")
      .replace(/^(?:Promise|Array|ReadonlyArray)<([\s\S]*)>$/, "$1")
      .replace(/(?:\[\])+$/, "")
      .trim();

    if (next === bare) return bare;

    bare = next;
  }
}

/**
 * The complex types a set of signatures refers to but does not declare.
 *
 * `scaffold_service` used to emit `Promise<User>` with no `User` anywhere — no
 * declaration, no import, and no hint that `@classType()` was needed. The code
 * did not compile; once the caller declared `User` themselves it compiled and the
 * generated client typed it `any`, which is the worse of the two outcomes because
 * nothing reports it.
 */
function complexTypes(methods: MethodSpec[]): string[] {
  const found = new Set<string>();

  const consider = (type?: string) => {
    if (!type) return;

    for (const part of type.split(/[|&]/)) {
      const bare = bareType(part);

      // A string/number literal, an inline object or tuple shape, and anything
      // that is not a plain identifier all need no declaration of their own.
      if (!bare || PRIMITIVE_TYPES.has(bare)) continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(bare)) continue;

      found.add(bare);
    }
  };

  for (const m of methods) {
    consider(m.returns);

    for (const p of m.params ?? []) consider(p.type);
  }

  return [...found];
}

/** A `@classType()` stub per complex type, with the `any` trap spelled out. */
function renderTypesFile(types: string[]): string {
  const decls = types.map(
    (t) => `@classType()
export class ${t} {
    // EVERY field that crosses the RPC boundary needs @property(). A field
    // without it reaches the generated client typed \`any\` — that compiles, so
    // nothing will tell you the types stopped being real.
    @property('string')
    public id!: string;

    // TODO: replace the placeholder above with ${t}'s real fields. The argument
    // is the type as a STRING; pass true as a second argument for an optional
    // field, e.g. @property('string', true) or @property('Address[]', true).
}`,
  );

  return `import { classType, property } from '@imqueue/rpc';

${decls.join("\n\n")}
`;
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
  const types = complexTypes(list);

  const service = `import { IMQService, expose } from '@imqueue/rpc';
${types.length ? `import { ${types.join(", ")} } from './types.js';\n` : ""}
// @expose() reads the JSDoc blocks below AT RUNTIME to build this service's
// self-description, which is what the generated clients are typed from. So this
// project — and every project that imports it — must compile with
// \`removeComments: false\`; strip the comments and every parameter is published
// as \`any\`.
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
      // Only when something actually needs declaring — an all-primitive service
      // getting an empty types.ts would be noise a caller has to delete.
      ...(types.length
        ? [{ path: "types.ts", language: "typescript", content: renderTypesFile(types).trimEnd() }]
        : []),
      { path: "index.ts", language: "typescript", content: bootstrap.trimEnd() },
    ],
    types,
    cliAlternative: `imq service create ${name}`,
  };
}

/** Render a {@link ServiceScaffold} as the markdown a human reads. */
export function renderService(s: ServiceScaffold): string {
  const label = (f: ScaffoldFile) => {
    if (f.path === "index.ts") return `**${f.path}** (bootstrap)`;
    if (f.path === "types.ts") return `**${f.path}** (complex types — complete the fields)`;

    return `**${f.path}**`;
  };

  return [
    `Install: \`${s.install}\` (needs a running Redis).`,
    ...s.files.flatMap((f) => ["", label(f), "```" + f.language, f.content, "```"]),
    "",
    // Two requirements that produce no error when ignored, so an agent that is
    // never told about them ships the broken version and nothing complains.
    "Two things @imqueue needs that the compiler will not ask you for:",
    "- Compile with `removeComments: false`. `@expose()` reads the JSDoc at runtime to describe the service, so stripped comments mean every parameter is published as `any`.",
    ...(s.types.length
      ? [
          `- ${s.types.join(", ")} ${s.types.length > 1 ? "cross" : "crosses"} the RPC boundary, so ${s.types.length > 1 ? "each needs" : "it needs"} \`@classType()\` on the class and \`@property()\` on every field — see \`types.ts\` above. A field without \`@property()\` arrives in the generated client typed \`any\`.`,
        ]
      : ["- Any class you later pass or return needs `@classType()` plus `@property()` on every field, or the generated client types it `any`."]),
    "",
    `Tip: scaffold a full, provider-wired project (VCS/CI/Docker) with the CLI instead: \`${s.cliAlternative}\`.`,
  ].join("\n");
}

/**
 * Generate a typed-client usage snippet for a service, as data.
 *
 * Every identifier here is pinned to what `imq client generate` ACTUALLY emits,
 * because this tool previously published an idiom that exists nowhere:
 *
 *   * The file is `<path>/<name>.ts` where `<name>` is the CLI argument, i.e. the
 *     SERVICE name — not the client name (`cli/src/client/generate.ts`, and
 *     `IMQClient.create`'s own remarks say so).
 *   * `<name>` also addresses the QUEUE, which is the service's class name
 *     (`IMQService`), so generating against `User` when the class is `UserService`
 *     asks a queue nobody serves.
 *   * The generated module exports ONE symbol: a namespace named after the
 *     service with a lowercase first letter, holding the client class. So
 *     `import { UserClient }` cannot resolve — it has to be
 *     `import { userService }` then `new userService.UserClient()`
 *     (`rpc/src/IMQClient.ts`, and `example/client/static.ts` shipped alongside).
 *
 * All three were wrong together, which made the emitted example fail loudly — but
 * a wrong idiom published by the project's own tooling propagates into public
 * repositories and back into training data, which is the cost worth avoiding.
 */
export function scaffoldClient(service: string, methods?: MethodSpec[]): ClientScaffold {
  const cls = pascal(service).endsWith("Service") ? pascal(service) : `${pascal(service)}Service`;
  // `serviceName.replace(/Service$|$/, 'Client')` in IMQClient: the trailing
  // `Service` is REPLACED, so `UserService` gives `UserClient`, not
  // `UserServiceClient`.
  const clientCls = cls.replace(/Service$/, "Client");
  const ns = cls.charAt(0).toLowerCase() + cls.slice(1);
  const sample = (methods && methods[0]) || DEFAULT_METHODS[0];
  const args = (sample.params ?? []).map((p) => `/* ${p.name}: ${p.type} */`).join(", ");

  const usage = `import { ${ns} } from '${CLIENT_DIR}/${cls}.js';

(async () => {
    // The generated module's only export is the namespace \`${ns}\` above; the
    // client class is reached through it and is not exported on its own.
    const client = new ${ns}.${clientCls}({ callTimeout: 5000 });

    await client.start();

    try {
        // Fully-typed remote call — the signature comes from ${cls}'s @expose()d
        // method and its JSDoc:
        const result = await client.${sample.name}(${args});

        console.log(result);
    } finally {
        // Closes the client's Redis channels; without it the process will not exit.
        await client.destroy();
    }
})();
`;

  return {
    service: cls,
    client: clientCls,
    namespace: ns,
    generateCommand: `imq client generate ${cls} ${CLIENT_DIR}`,
    output: `${CLIENT_DIR}/${cls}.ts`,
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
    `That writes \`${c.output}\` (and a compiled \`.js\` beside it). Its only export is the namespace \`${c.namespace}\`, which holds \`${c.client}\` — the class is not exported on its own, so importing it by name will not resolve. Use it like:`,
    "```" + c.example.language,
    c.example.content,
    "```",
    "",
    // The CLI argument names the QUEUE, and the queue is the service class name.
    // Getting this wrong is silent: the call just waits for a consumer that will
    // never arrive, and `callTimeout` is unset by default.
    `The name passed to \`imq client generate\` must be the service's **class name** — that is its queue name. The command above assumes the class is \`${c.service}\`, as \`scaffold_service\` creates it; if yours is called something else, generate against that instead.`,
    "",
    `The snippet above is illustrative — prefer the generated client so method signatures stay in sync with the service.`,
  ].join("\n");
}
