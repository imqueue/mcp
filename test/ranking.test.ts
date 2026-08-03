// The ranker, on a fixed corpus.
//
// Every defect search_docs has had was a ranking defect, and none of them could be
// asserted while the only way to run the ranker was against the live site: the
// corpus moves, so a test written against it encodes today's content rather than
// the rule. The entries below are miniature copies of the real ones that produced
// each reported failure — the titles, sections and summaries are the actual
// shapes, trimmed.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { rankEntries, type DocEntry } from "../src/docs.js";

const doc = (title: string, url: string, description = "", section = "Guides"): DocEntry =>
  ({ title, url, description, section });

const sym = (title: string, pkg: string, kind: string, description = ""): DocEntry => ({
  title,
  url: `https://imqueue.org/api/${pkg}/latest/${pkg}.${title.toLowerCase()}/`,
  description,
  section: `API · @imqueue/${pkg} ${kind}`,
  symbol: true,
});

const urls = (r: DocEntry[]) => r.map((e) => e.url);

// ---------------------------------------------------------------------------
// 8e — substring title matching put actively wrong results in all six slots.
// ---------------------------------------------------------------------------

test("a query term does not match the middle of a longer word", () => {
  const symbols = [
    // 'rate' lives inside 'migrate' and 'generate'. These six filled every slot
    // for "rate limiting" while http-protect returned nothing.
    sym("MigrateDownOptions", "pg-prisma", "interface"),
    sym("MigrateDownOptions.generateOnly", "pg-prisma", "property"),
    sym("MigrateDownResult", "pg-prisma", "interface"),
    sym("HttpProtect.isLimited", "http-protect", "method", "Per-IP request counting, rate limiting and banning"),
  ];

  const got = urls(rankEntries([], symbols, "rate limiting"));

  assert.ok(got[0].includes("http-protect"), got.join(" | "));
  assert.ok(
    !got.some((u) => u.includes("migratedown")),
    `a Migrate* page still matched 'rate': ${got.join(" | ")}`,
  );
});

test("'ip' does not match the middle of 'description'", () => {
  const symbols = [
    sym("PropertyDescription", "rpc", "interface"),
    sym("PropertyDescription.type", "rpc", "property"),
    sym("HttpProtect.getClientIp", "http-protect", "method"),
  ];

  const got = urls(rankEntries([], symbols, "rate limit per IP"));

  assert.ok(got[0].includes("getclientip"), got.join(" | "));
  assert.ok(!got.some((u) => u.includes("propertydescription")), got.join(" | "));
});

test("a partial hit on a real word boundary is kept", () => {
  // The behaviour the original substring check existed for: 'option' should still
  // find IMQOptions. Losing this was the risk in fixing the case above.
  const symbols = [sym("IMQOptions", "core", "interface"), sym("RedisQueue.send", "core", "method")];

  assert.ok(urls(rankEntries([], symbols, "option"))[0].includes("imqoptions"));
});

test("a term equal to an identifier segment scores as a whole word", () => {
  // `ClusteredRedisQueue` is ONE token, so treating `redis` inside it as a mere
  // fragment let `PgCacheOptions.redis` — where a dot makes `redis` a token —
  // outrank the class the query was about.
  const symbols = [
    sym("PgCacheOptions.redis", "pg-cache", "property"),
    sym("ClusteredRedisQueue", "core", "class"),
    sym("ClusteredRedisQueue.(constructor)", "core", "constructor"),
  ];

  assert.ok(urls(rankEntries([], symbols, "redis cluster"))[0].includes("clusteredredisqueue"));
});

// ---------------------------------------------------------------------------
// 8d — symbol summaries were unreachable unless the NAME already matched.
// ---------------------------------------------------------------------------

test("a symbol is findable by its summary alone", () => {
  const symbols = [
    sym(
      "IMQOptions.handleSignals",
      "core",
      "property",
      "Enable process signal handling (SIGTERM, SIGINT, SIGABRT) to gracefully stop",
    ),
    sym("IMQService.stop", "rpc", "method", "Stops the service"),
  ];

  // Nothing in the title matches; before, this scored exactly zero.
  const got = urls(rankEntries([], symbols, "SIGABRT"));

  assert.equal(got.length, 1, got.join(" | "));
  assert.ok(got[0].includes("handlesignals"));
});

test("a summary-only symbol stays below a page whose title matched", () => {
  // The summary path is deliberately weak: enough to be findable, never enough to
  // displace a page that matched outright. Note what it does NOT promise — a
  // summary-only symbol can lead a page that matched only in its description,
  // which is why the assertion is about a TITLE match. Fillers so the corpus is
  // large enough for the term to carry real weight.
  const curated = [
    doc("Graceful shutdown on SIGTERM", "https://imqueue.org/blog/graceful-shutdown-zero-drop-deploys/", "Drain in-flight work", "Articles"),
    doc("Get started", "https://imqueue.org/get-started/", "Your first service in minutes"),
    doc("Tutorial", "https://imqueue.org/tutorial/", "A complete example application"),
    doc("CLI guide", "https://imqueue.org/cli/", "Scaffold services and run a fleet"),
  ];
  const symbols = [
    sym("IMQOptions.handleSignals", "core", "property", "Enable process signal handling (SIGTERM, SIGINT)"),
  ];

  const got = urls(rankEntries(curated, symbols, "sigterm"));

  assert.ok(got[0].includes("/blog/"), got.join(" | "));
  assert.equal(got.length, 2, "the symbol should still be reachable, just lower");
});

test("one member name cannot fill the whole answer", () => {
  // Six different parents, one answer repeated — the per-parent cap could not see
  // it, so there was no room left for anything that actually answers the question.
  const symbols = [
    sym("IMQService.stop", "rpc", "method"),
    sym("ClusteredRedisQueue.stop", "core", "method"),
    sym("IMessageQueue.stop", "core", "method"),
    sym("RedisQueue.stop", "core", "method"),
    sym("AnyJobQueue.stop", "job", "method"),
    sym("BaseJobQueue.stop", "job", "method"),
  ];

  const got = urls(rankEntries([], symbols, "stop", 6));

  assert.ok(got.length <= 2, `${got.length} pages named .stop: ${got.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// 8f — the package name was in `section` and never scored.
// ---------------------------------------------------------------------------

test("the package name in a section is searchable", () => {
  const symbols = [
    sym("IMQCallHooks", "opentelemetry", "interface"),
    sym("TraceKind", "opentelemetry", "enum"),
    sym("TracingPlugin", "datadog", "class"),
  ];

  const got = urls(rankEntries([], symbols, "opentelemetry"));

  // Before, only an entry whose TITLE said 'opentelemetry' could match — i.e. the
  // package index alone, while 26 of its symbols sat unmatched in the same feed.
  assert.equal(got.length, 2, got.join(" | "));
  assert.ok(got.every((u) => u.includes("/opentelemetry/")), got.join(" | "));
});

test("the package filter restricts symbols and keeps that package's index", () => {
  const curated = [
    doc("@imqueue/http-protect API reference", "https://imqueue.org/api/http-protect/latest/", "Per-IP rate limiting"),
    doc("Get started", "https://imqueue.org/get-started/", "Your first service in minutes"),
  ];
  const symbols = [
    sym("HttpProtect.banLimit", "http-protect", "property"),
    sym("PaginationInput.limit", "pg-sequelize", "property"),
  ];

  const got = urls(rankEntries(curated, symbols, "limit", 6, "http-protect"));

  assert.ok(got.length > 0);
  assert.ok(got.every((u) => u.includes("http-protect")), got.join(" | "));

  // The long form names the same package.
  assert.deepEqual(got, urls(rankEntries(curated, symbols, "limit", 6, "@imqueue/http-protect")));
});

// ---------------------------------------------------------------------------
// 8g — the blog demotion was a primary sort key, which overcorrected.
// ---------------------------------------------------------------------------

test("a decisively better article can lead", () => {
  const curated = [
    doc(
      "Graceful shutdown and zero-drop deploys",
      "https://imqueue.org/blog/graceful-shutdown-zero-drop-deploys/",
      "How to drain in-flight work on SIGTERM so a deploy drops nothing",
      "Articles",
    ),
  ];
  const symbols = [
    // Merely contains the words. As a primary sort key this outranked the 2,000-word
    // article written about exactly this.
    sym("SHUTDOWN_TIMEOUT", "pg-pubsub", "variable"),
  ];

  assert.ok(urls(rankEntries(curated, symbols, "graceful shutdown deploys"))[0].includes("/blog/"));
});

test("a doc page still wins a near-tie against an article", () => {
  const curated = [
    doc("expose", "https://imqueue.org/api/rpc/latest/rpc.expose/", "Marks a service method as remotely callable"),
    doc(
      "Stop hand-writing microservice clients",
      "https://imqueue.org/blog/stop-hand-writing-microservice-clients/",
      "Marks a service method as remotely callable",
      "Articles",
    ),
  ];

  assert.ok(!urls(rankEntries(curated, [], "expose a service method"))[0].includes("/blog/"));
});

// ---------------------------------------------------------------------------
// 8h — no stemming, so words the corpus covers returned nothing at all.
// ---------------------------------------------------------------------------

test("inflections find each other", () => {
  const curated = [
    doc("Tag cache", "https://imqueue.org/api/tag-cache/latest/", "Tagged cache over Redis"),
    doc("Retry policy", "https://imqueue.org/blog/retry/", "How a job retry is scheduled", "Articles"),
  ];

  for (const [query, expect] of [
    ["caching", "/api/tag-cache/"],
    ["caches", "/api/tag-cache/"],
    ["retries", "/blog/retry/"],
  ] as const) {
    const got = urls(rankEntries(curated, [], query));

    assert.ok(got.length > 0, `"${query}" returned nothing`);
    assert.ok(got[0].includes(expect), `"${query}" -> ${got.join(" | ")}`);
  }
});

test("the word as written beats a guessed inflection", () => {
  const curated = [
    doc("Cache", "https://imqueue.org/cache/", ""),
    doc("Caching guide", "https://imqueue.org/caching/", ""),
  ];

  assert.ok(urls(rankEntries(curated, [], "caching"))[0].endsWith("/caching/"));
  assert.ok(urls(rankEntries(curated, [], "cache"))[0].endsWith("/cache/"));
});

test("an exact symbol name still ranks itself first", () => {
  // The one thing that already worked, and the thing all of the above could break.
  const symbols = [
    sym("IMQOptions", "core", "interface"),
    sym("IMQOptions.safeDelivery", "core", "property"),
    sym("IMQOptions.safeDeliveryTtl", "core", "property"),
  ];

  assert.ok(urls(rankEntries([], symbols, "IMQOptions.safeDelivery"))[0].endsWith("imqoptions.safedelivery/"));
});

test("an empty query returns the curated index rather than nothing", () => {
  const curated = [doc("Get started", "https://imqueue.org/get-started/")];

  assert.deepEqual(urls(rankEntries(curated, [], "   ", 3)), ["https://imqueue.org/get-started/"]);
});
