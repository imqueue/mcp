// What search_docs returns, on a fixed corpus.
//
// THIS FILE CHANGED SHAPE. It used to hold sixteen cases against `rankEntries`, this
// server's own ranker — one per ranking defect that had actually been reported. That
// ranker is gone: the ranking is now github.com/imqueue/search-ranker, pinned as a
// submodule and shared with the website's own search box, and its rules are measured
// there by scripts/search-kpi/ across ~12,000 queries rather than pinned here by
// example. The switch was made on that measurement — recall@6 83.9% -> 99.5% over 3,657
// agent-shaped queries, with no query the old ranker answered that the new one does not.
// Re-asserting those sixteen rules here would be asserting a submodule's behaviour from
// outside it.
//
// What IS this repo's code, and what these cases cover, is the MAPPING: turning the
// ranker's hits into the frozen `{title, section, description, url, symbol?}` contract.
// Its failure modes are worse than a misranking because they look like success. An
// imqueue.org URL for an imqueue.com page 404s through get_doc; a section label that
// stops naming the package silently stops the mutually-exclusive-package advisories
// from firing, and a model that gets six @imqueue/datadog results with no warning
// installs the wrong one of the pair.
//
// The corpus below is feed-shaped, because that is what the ranker reads: records with
// `g` for the group (0 page, 1 API symbol, 2 answer), positional section tuples, and
// root-relative URLs that belong to THEIR OWN EDITION.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { rankCorpus, type Corpus, type DocEntry } from "../src/docs.js";
import { FEED_V, ranker } from "../src/ranker.js";

/** A page record. */
const page = (t: string, u: string, s = "", k = "Docs") => ({ g: 0 as const, t, u, s, k });

/** An API symbol record. */
const sym = (t: string, pkg: string, k: string, s = "", d = false) => ({
  g: 1 as const,
  t,
  u: `/api/${pkg}/latest/${pkg}.${t.toLowerCase().replace(/[^a-z0-9]+/g, "")}/`,
  s,
  k,
  p: `@imqueue/${pkg}`,
  ...(d ? { d: true } : {}),
});

/** A question-shaped answer record. On these `k` is the PARENT PAGE'S TITLE. */
const answer = (t: string, u: string, s: string, parent: string) =>
  ({ g: 2 as const, t, u, s, k: parent });

/**
 * Build a corpus the way loadCorpus does, minus the network.
 *
 * The prose tier is empty in most cases — it needs five-slot section tuples and a page
 * table, and a case about the mapping does not need prose to exercise it. The one case
 * that does builds it properly.
 */
function corpusOf(
  records: object[],
  peer: object[] = [],
  text?: { pages: unknown[]; sections: unknown[][] },
): Corpus {
  const prose = text
    ? { v: FEED_V, lemmas: {}, pages: text.pages, sections: text.sections }
    : { v: FEED_V, lemmas: {}, pages: [], sections: [] };

  return {
    at: Date.now(),
    index: ranker.prepare({ v: FEED_V, records: records as never }),
    text: ranker.prepareSections(prose as never),
    peerIndex: peer.length ? ranker.prepare({ v: FEED_V, records: peer as never }) : null,
    peerText: null,
  };
}

const urls = (r: DocEntry[]) => r.map((e) => e.url);

// ---------------------------------------------------------------------------
// The URL is the field that must never be wrong.
// ---------------------------------------------------------------------------

test("a peer record gets imqueue.com, a local record gets imqueue.org", () => {
  // Both editions publish a /license/, and the feeds hold root-relative paths — so the
  // only thing that says which host a record belongs to is which feed it came from.
  // Prefixing everything with imqueue.org returns URLs that 404 through get_doc, which
  // is the one change here that would force a major version bump rather than a minor.
  const got = rankCorpus(
    corpusOf(
      [page("GPL-3.0 open-source license terms", "/license/", "The framework is GPL-3.0.")],
      [page("Pricing & commercial license", "/pricing/", "Commercial licence pricing.")],
    ),
    [],
    "license pricing",
    6,
  );

  const org = got.find((e) => e.title.startsWith("GPL"));
  const com = got.find((e) => e.title.startsWith("Pricing"));

  assert.equal(org?.url, "https://imqueue.org/license/", urls(got).join(" | "));
  assert.equal(com?.url, "https://imqueue.com/pricing/", urls(got).join(" | "));
});

test("the commercial edition can take #1 — this server is on no site", () => {
  // The ranker sorts peer results after local ones unconditionally, because on a
  // website the site you are on wins. Measured against the live feeds with that rule
  // still in force: `commercial license` and `is imqueue free for commercial use`
  // returned NO imqueue.com result inside the default limit of 6, and `pricing
  // commercial license` returned one at #5 — gone at limit 3. A confident answer from
  // the wrong edition, about the one question with revenue attached.
  const got = rankCorpus(
    corpusOf(
      [
        page("Contributing & contribution terms", "/contributing/", "How to contribute."),
        page("GPL-3.0 open-source license terms", "/license/", "Open-source licence terms."),
      ],
      [page("Pricing & commercial license for @imqueue", "/pricing/", "Commercial license pricing and plans.")],
    ),
    [],
    "commercial license pricing",
    6,
  );

  assert.ok(
    got[0].url.startsWith("https://imqueue.com/"),
    `expected the commercial page first, got: ${urls(got).join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// The section label — read by a caller, and read by the advisory detector.
// ---------------------------------------------------------------------------

test("an API symbol's section keeps naming its package, so advisories still fire", () => {
  const got = rankCorpus(
    corpusOf([sym("ImqSpan.finish", "opentelemetry", "method", "End the span.")]),
    [],
    "ImqSpan.finish",
    6,
  );

  assert.equal(got[0].section, "API · @imqueue/opentelemetry method");
  assert.equal(got[0].symbol, true);
});

test("a curated llms.txt section wins over the feed's own page kind", () => {
  // llms.txt is the only place the hand-written label exists, and it is the one thing
  // that feed is still read for.
  const curated: DocEntry[] = [{
    title: "Delayed & scheduled work",
    url: "https://imqueue.org/agents/delayed-scheduled-work/",
    description: "Recipe.",
    section: "Agent Recipes",
  }];

  const got = rankCorpus(
    corpusOf([page(
      "Agent recipe: delayed & scheduled work",
      "/agents/delayed-scheduled-work/",
      "Delayed jobs.",
      "Recipe",
    )]),
    curated,
    "delayed scheduled work",
    6,
  );

  assert.equal(got[0].section, "Agent Recipes");
});

test("without a curated entry the label falls back to the page's own kind", () => {
  const got = rankCorpus(
    corpusOf([page("What is a message queue?", "/glossary/message-queue/", "Definition.", "Glossary")]),
    [],
    "message queue glossary",
    6,
  );

  assert.equal(got[0].section, "Glossary");
});

test("an answer names the page it was lifted out of", () => {
  // `k` is overloaded by group in the feed: a kind on a page, the parent page's TITLE
  // on an answer. Read as a kind it would label every answer with a whole headline.
  const got = rankCorpus(
    corpusOf([answer(
      "Does @imqueue retry a failed RPC call?",
      "/blog/rpc-over-redis-nodejs/#does-imqueue-retry-a-failed-rpc-call",
      "No, and this is deliberate. There is no automatic retry at the RPC layer.",
      "RPC over Redis in Node.js: patterns and pitfalls",
    )]),
    [],
    "does imqueue retry a failed rpc call",
    6,
  );

  assert.ok(got[0].section.startsWith("Answer · RPC over Redis"), got[0].section);
  assert.ok(got[0].url.includes("#does-imqueue-retry"), got[0].url);
});

// ---------------------------------------------------------------------------
// The description.
// ---------------------------------------------------------------------------

test("a deprecated symbol says so before anything else", () => {
  // The marker leads because an agent scans descriptions and then copies the symbol
  // into code.
  const got = rankCorpus(
    corpusOf([sym("IMQOptions.useGzip", "core", "property", "Compress payloads.", true)]),
    [],
    "IMQOptions.useGzip",
    6,
  );

  assert.ok(
    got[0].description.startsWith("DEPRECATED — do not use in new code."),
    got[0].description,
  );
});

test("a section hit's description is the matched prose, and its URL carries the anchor", () => {
  // The one case that needs a real prose tier. Slots 0-4 of a section tuple come from
  // the feed: page index, anchor, heading, text, emphasis — which is why moving one is
  // a FEED_V change.
  const text = {
    pages: [["/get-started/", "Get started", "Docs"]],
    sections: [[
      0,
      "4-1-create-a-service",
      "Create a service",
      "Run imq service create to scaffold a typed service with a health check.",
      "",
    ]],
  };

  const got = rankCorpus(
    corpusOf([page("Get started", "/get-started/", "Install and run.")], [], text),
    [],
    "scaffold a typed service",
    6,
  );

  const hit = got.find((e) => e.url.includes("#4-1-create-a-service"));

  assert.ok(hit, `no section hit: ${urls(got).join(" | ")}`);
  assert.ok(hit.description.includes("scaffold a typed service"), hit.description);
  // Returning the anchor rather than the whole page is a large part of the point of the
  // switch: the page is 9 kB, the section that answers is a paragraph.
  assert.equal(hit.url, "https://imqueue.org/get-started/#4-1-create-a-service");
});

// ---------------------------------------------------------------------------
// limit and package.
// ---------------------------------------------------------------------------

test("limit is honoured", () => {
  const records = Array.from({ length: 12 }, (_, i) =>
    sym(`RedisQueue.send${i}`, "core", "method", "Send a message."));

  assert.equal(rankCorpus(corpusOf(records), [], "RedisQueue send", 3).length, 3);
});

test("the package filter is the ranker's own, applied before the limit", () => {
  // Post-filtering the top N would take six results and then discard from them, so a
  // scoped search would come back short — or empty — having found plenty.
  const records = [
    ...Array.from({ length: 8 }, (_, i) =>
      sym(`PgPubSub.on${i}`, "pg-pubsub", "method", "Listen for a channel.")),
    sym("HttpProtect.isLimited", "http-protect", "method", "Per-IP rate limiting and banning."),
  ];

  const got = rankCorpus(corpusOf(records), [], "limiting", 6, "http-protect");

  assert.ok(got.length >= 1, "the scoped search returned nothing");
  assert.ok(got.every((e) => e.url.includes("/api/http-protect/")), urls(got).join(" | "));
});

test("the package filter accepts a scoped name", () => {
  const records = [sym("HttpProtect.isLimited", "http-protect", "method", "Per-IP rate limiting.")];
  const bare = rankCorpus(corpusOf(records), [], "limiting", 6, "http-protect");
  const scoped = rankCorpus(corpusOf(records), [], "limiting", 6, "@imqueue/http-protect");

  assert.deepEqual(urls(scoped), urls(bare));
});

// ---------------------------------------------------------------------------
// Deliberate behaviour changes, pinned so they stay deliberate.
// ---------------------------------------------------------------------------

test("a query of only whitespace returns nothing, not the whole corpus", () => {
  // CHANGED ON PURPOSE, and the reason is sharper than it looks. A query with no terms
  // matches EVERYTHING rather than nothing — with `terms` empty every record clears the
  // ranker's score floor — so this used to come back as the corpus truncated to `limit`,
  // in ranked order, presented as relevant. The old ranker had the same hole and filled
  // it with the first N curated pages.
  //
  // Unreachable on the website (the dialog does not search an empty input), reachable
  // here (`query` is bounded at min(1) and whitespace satisfies it).
  const corpus = corpusOf([
    page("Get started", "/get-started/", "Install and run."),
    page("Glossary", "/glossary/", "Definitions.", "Glossary"),
    sym("RedisQueue.send", "core", "method", "Send a message."),
  ]);

  assert.deepEqual(urls(rankCorpus(corpus, [], "   ", 6)), []);
  assert.deepEqual(urls(rankCorpus(corpus, [], "", 6)), []);
  // A real query against the same corpus still works, so the guard is not a blanket off.
  assert.equal(rankCorpus(corpus, [], "RedisQueue.send", 6).length, 1);
});

test("the ranker declares the feed version it reads", () => {
  // Not a tautology — it asserts the export exists at all. loadCorpus compares every
  // fetched feed against it, and the feeds come from the LIVE site while this ranker is
  // pinned to a commit, so the two can drift with nobody deploying anything. Records are
  // positional arrays, so a field inserted mid-tuple returns the wrong text at full
  // confidence rather than throwing.
  assert.equal(typeof FEED_V, "number");
  assert.ok(FEED_V >= 1);
});
