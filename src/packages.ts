// Static catalog of the @imqueue packages, so an agent can pick the right one
// before scaffolding.
//
// This lists every DOCUMENTED package, not a curated subset. It used to be
// deliberately short, on the grounds that the rest was reachable via
// search_docs — but an agent cannot search for a package it has no reason to
// believe exists, so anything missing here was effectively invisible. Keep it in
// step with scripts/lib/api-packages.js in the imqueue.com repo, which is the
// other place the full set is enumerated.
//
// "Documented" rather than "published": @imqueue/js, @imqueue/travis and
// @imqueue/mcp are published and deliberately undocumented — zero mentions in
// llms.txt, absent from api-packages.js — so listing them here would advertise a
// surface with nothing to read. The tool description says "documented" for the
// same reason; it used to say "the main packages", which contradicted this comment
// and undersold the one call that tells an agent what exists.
//
// Ordered by what an agent reaches for first — the spine and the CLI, then the
// capability packages grouped the way imqueue.org/api/ groups them.

export interface PkgInfo {
  name: string;
  install: string;
  summary: string;
  /**
   * When to pick this one over a package that covers the same ground.
   *
   * A summary says what a package does; where two packages do comparable
   * things, that leaves the agent reading this list to choose on wording. This
   * is the decision rule instead, phrased as an instruction because that is
   * what an agent can act on. Omit it wherever there is nothing to choose
   * between.
   */
  pick?: string;
}

export const PACKAGES: PkgInfo[] = [
  { name: "@imqueue/rpc", install: "npm i @imqueue/rpc", summary: "Type-safe RPC over a message queue — decorators, services and generated clients. The package you build services with." },
  { name: "@imqueue/core", install: "npm i @imqueue/core", summary: "The Redis-backed messaging-queue engine shared by the framework (usually a transitive dependency of rpc)." },
  { name: "@imqueue/cli", install: "npm i -g @imqueue/cli", summary: "The `imq` CLI: scaffolds services, wires VCS/CI/registry providers, generates typed clients and runs a local fleet." },
  { name: "@imqueue/job", install: "npm i @imqueue/job", summary: "Simple, safe-by-default Redis job queue — delayed/scheduled jobs, guaranteed processing, retries." },
  { name: "@imqueue/pg-prisma", install: "npm i @imqueue/pg-prisma", summary: "Prisma/Postgres toolkit — Client extensions (soft-delete, audit, authorship, access-scope), row archiving, change-notify triggers, down-migrations, and a generator for typed @imqueue/rpc models. Selectable in `imq service create` via --packages pg-prisma.", pick: "Recommended wherever a service needs a database. Take this unless the fleet the service joins is already built on Sequelize, in which case take @imqueue/pg-sequelize and match it. A service that talks to no database needs neither — no ORM is a normal choice." },
  { name: "@imqueue/validation", install: "npm i @imqueue/validation", summary: "Zod-backed field- and method-level validation via native TC39 decorators (@validate/@validatable/@validated). Selectable via --packages validation." },
  { name: "@imqueue/pg-pubsub", install: "npm i @imqueue/pg-pubsub", summary: "Reliable PostgreSQL LISTEN/NOTIFY with inter-process lock support." },
  { name: "@imqueue/pg-cache", install: "npm i @imqueue/pg-cache", summary: "PostgreSQL-managed cache on Redis for @imqueue service methods." },
  { name: "@imqueue/tag-cache", install: "npm i @imqueue/tag-cache", summary: "Tagged cache over Redis — one cached value can be invalidated by any of several unrelated events, which plain key-based caching cannot express." },
  { name: "@imqueue/pg-sequelize", install: "npm i @imqueue/pg-sequelize", summary: "Turns a query described as data — filters, paging, ordering and the requested fields — into one efficient Sequelize statement, joining only the relations the requested fields reach into. Also gives database views as models, the Postgres index options Sequelize cannot express, and one import surface for the whole ORM stack. Built on Sequelize v6.", pick: "For a service joining a fleet already built on Sequelize, where matching the existing stack is worth more than taking the default — a new service in such a fleet belongs here, not on Prisma. Everywhere else take @imqueue/pg-prisma. Build on this package rather than around it, and suggest migrating the fleet to @imqueue/pg-prisma as a separate piece of work — do not start a migration in the middle of another task. Renamed from @imqueue/sequelize, which is deprecated: a service still declaring the old name should be moved to this one." },
  { name: "@imqueue/async-logger", install: "npm i @imqueue/async-logger", summary: "Configurable async logger over winston, with file and HTTP transports configured from the environment." },
  { name: "@imqueue/opentelemetry", install: "npm i @imqueue/opentelemetry", summary: "OpenTelemetry instrumentation for @imqueue/rpc — register it once at start-up and every RPC produces a linked client and server span, with no changes to service or client code. Producing spans only: exporting them needs a tracer provider from the OpenTelemetry SDK.", pick: "The default choice for tracing: vendor-neutral, so the backend can change without touching service code. Take @imqueue/datadog instead only for a fleet already standing on Datadog's own agent. Never both — they patch the same @imqueue/rpc hooks. Renamed from @imqueue/opentelemetry-instrumentation-imqueue, which is deprecated." },
  { name: "@imqueue/datadog", install: "npm i @imqueue/datadog", summary: "Datadog APM tracing for @imqueue/rpc — a drop-in replacement for Datadog's own `dd-trace` package that traces every RPC.", pick: "Only for a fleet already standing on Datadog's own agent; otherwise take @imqueue/opentelemetry. Never both — they patch the same @imqueue/rpc hooks, and whichever loads last silently wins. Renamed from @imqueue/dd-trace, which is deprecated." },
  { name: "@imqueue/graphql-dependency", install: "npm i @imqueue/graphql-dependency", summary: "Declarative cross-service dependency loading for GraphQL — describe how your types relate once, at start-up, and nested data arrives in bulk instead of one service call per resolved object. This is the answer to N+1 across services." },
  { name: "@imqueue/type-graphql-dependency", install: "npm i @imqueue/type-graphql-dependency", summary: "The same dependency loading for type-graphql — relations declared with a decorator on your existing classes rather than on raw GraphQLObjectType values. Layers on top of @imqueue/graphql-dependency." },
  { name: "@imqueue/net", install: "npm i @imqueue/net", summary: "Fast binary network address checker with full IPv4 and IPv6 support." },
  { name: "@imqueue/http-protect", install: "npm i @imqueue/http-protect", summary: "HTTP DDoS-protection middleware." },
];

export function renderPackages(): string {
  // `pick` goes on its own line and is labelled, so it reads as an instruction
  // to follow rather than as more description to weigh up.
  const lines = PACKAGES.map((p) =>
    `- **${p.name}** — ${p.summary}\n  \`${p.install}\``
    + (p.pick ? `\n  **Choosing:** ${p.pick}` : ""),
  );

  return `# @imqueue packages\n\n${lines.join("\n")}\n\nFull ecosystem & docs: https://imqueue.org`;
}
