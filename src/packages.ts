// Static catalog of the main @imqueue packages, so an agent can pick the right
// one before scaffolding. Kept deliberately short — the full ecosystem lives on
// imqueue.org and is reachable via search_docs.

export interface PkgInfo {
  name: string;
  install: string;
  summary: string;
}

export const PACKAGES: PkgInfo[] = [
  { name: "@imqueue/rpc", install: "npm i @imqueue/rpc", summary: "Type-safe RPC over a message queue — decorators, services and generated clients. The package you build services with." },
  { name: "@imqueue/core", install: "npm i @imqueue/core", summary: "The Redis-backed messaging-queue engine shared by the framework (usually a transitive dependency of rpc)." },
  { name: "@imqueue/cli", install: "npm i -g @imqueue/cli", summary: "The `imq` CLI: scaffolds services, wires VCS/CI/registry providers, generates typed clients and runs a local fleet." },
  { name: "@imqueue/job", install: "npm i @imqueue/job", summary: "Simple, safe-by-default Redis job queue — delayed/scheduled jobs, guaranteed processing, retries." },
  { name: "@imqueue/pg-pubsub", install: "npm i @imqueue/pg-pubsub", summary: "Reliable PostgreSQL LISTEN/NOTIFY with inter-process lock support." },
  { name: "@imqueue/pg-cache", install: "npm i @imqueue/pg-cache", summary: "PostgreSQL-managed cache on Redis for @imqueue service methods." },
  { name: "@imqueue/async-logger", install: "npm i @imqueue/async-logger", summary: "Configurable async logger over winston for @imqueue services." },
  { name: "@imqueue/http-protect", install: "npm i @imqueue/http-protect", summary: "HTTP DDoS-protection middleware." },
];

export function renderPackages(): string {
  const lines = PACKAGES.map((p) => `- **${p.name}** — ${p.summary}\n  \`${p.install}\``);
  return `# @imqueue packages\n\n${lines.join("\n")}\n\nFull ecosystem & docs: https://imqueue.org`;
}
