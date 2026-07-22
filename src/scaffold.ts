// Code scaffolding for @imqueue — mirrors what `imq service create` /
// `imq client generate` produce, but as inline templates an agent can drop into
// a project. @imqueue is decorator-driven and JSDoc is the source of truth for
// types, so the generated code documents each method with JSDoc.

export interface MethodSpec {
  name: string;
  description?: string;
  params?: { name: string; type: string; description?: string }[];
  returns?: string; // TypeScript return type (without the Promise<> wrapper)
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
  const sig = params.map((p) => `${p.name}: ${p.type}`).join(", ");
  const jsdoc = [
    "    /**",
    `     * ${m.description ?? m.name}`,
    ...params.map((p) => `     * @param ${p.name} - ${p.description ?? p.type}`),
    `     * @return {Promise<${ret}>}`,
    "     */",
  ].join("\n");
  const body =
    ret === "void"
      ? "        // TODO: implement"
      : `        // TODO: implement\n        throw new Error('${m.name}() not implemented');`;
  return `${jsdoc}\n    @expose()\n    public async ${m.name}(${sig}): Promise<${ret}> {\n${body}\n    }`;
}

/** Generate an @imqueue/rpc service class + a bootstrap that starts it. */
export function scaffoldService(name: string, methods?: MethodSpec[]): string {
  const cls = pascal(name).endsWith("Service") ? pascal(name) : `${pascal(name)}Service`;
  const list = methods && methods.length ? methods : DEFAULT_METHODS;
  const body = list.map(renderMethod).join("\n\n");

  const service = `import { IMQService, expose } from '@imqueue/rpc';

export class ${cls} extends IMQService {
${body}
}
`;

  const bootstrap = `import { ${cls} } from './${cls}';

// Start the service so other services can call its @expose()d methods.
(async () => {
    const service = new ${cls}({ name: '${cls}' });
    await service.start();
    console.log('${cls} is up');
})();
`;

  return [
    `Install: \`npm i @imqueue/rpc\` (needs a running Redis).`,
    "",
    `**${cls}.ts**`,
    "```typescript",
    service.trimEnd(),
    "```",
    "",
    `**index.ts** (bootstrap)`,
    "```typescript",
    bootstrap.trimEnd(),
    "```",
    "",
    `Tip: scaffold a full, provider-wired project (VCS/CI/Docker) with the CLI instead: \`imq service create ${name}\`.`,
  ].join("\n");
}

/** Generate a typed-client usage snippet for a service. */
export function scaffoldClient(service: string, methods?: MethodSpec[]): string {
  const cls = pascal(service).endsWith("Service") ? pascal(service) : `${pascal(service)}Service`;
  const clientCls = cls.replace(/Service$/, "Client");
  const sample = (methods && methods[0]) || DEFAULT_METHODS[0];
  const args = (sample.params ?? []).map((p) => `/* ${p.name}: ${p.type} */`).join(", ");

  const usage = `import { ${clientCls} } from './clients/${clientCls}';

(async () => {
    const client = new ${clientCls}();
    await client.start();

    // Fully-typed remote call — signature comes from ${cls}:
    const result = await client.${sample.name}(${args});
    console.log(result);
})();
`;

  return [
    `@imqueue generates the **real**, fully-typed client from a **running** service, so its types can never drift:`,
    "",
    "```bash",
    `# with ${cls} running:`,
    `imq client generate ${cls.replace(/Service$/, "")}`,
    "```",
    "",
    `That emits \`./clients/${clientCls}\`. Use it like:`,
    "```typescript",
    usage.trimEnd(),
    "```",
    "",
    `The snippet above is illustrative — prefer the generated client so method signatures stay in sync with the service.`,
  ].join("\n");
}
