// URL resolution and feed parsing — the two places get_doc silently 404'd.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getDoc, mirrorUrl, parseLlmsTxt, setUserAgent, sliceSection } from "../src/docs.js";

test("a page URL resolves to its markdown mirror", () => {
  assert.equal(mirrorUrl("https://imqueue.org/get-started/"), "https://imqueue.org/get-started/index.md");
  assert.equal(mirrorUrl("/get-started"), "https://imqueue.org/get-started/index.md");
  // A trailing slash means a page however many dots the last segment holds.
  assert.equal(
    mirrorUrl("https://imqueue.org/api/core/latest/core.redisqueue.send/"),
    "https://imqueue.org/api/core/latest/core.redisqueue.send/index.md",
  );
});

test("a URL that already names a file is left alone", () => {
  // `index.md` was appended to anything not ending in `.md`, which turned two
  // URLs the index itself publishes into guaranteed 404s.
  assert.equal(mirrorUrl("https://imqueue.org/llms-full.txt"), "https://imqueue.org/llms-full.txt");
  assert.equal(mirrorUrl("https://imqueue.org/blog/feed.xml"), "https://imqueue.org/blog/feed.xml");
  // Both mirror shapes the site serves.
  assert.equal(mirrorUrl("https://imqueue.org/get-started.md"), "https://imqueue.org/get-started.md");
  assert.equal(mirrorUrl("https://imqueue.org/get-started/index.md"), "https://imqueue.org/get-started/index.md");
});

test("the mirror stays on the host it was asked about", () => {
  // It used to be built from the imqueue.org constant, so an imqueue.com URL that
  // got past the host check would have been rewritten to the wrong site.
  assert.equal(mirrorUrl("https://imqueue.com/pricing/"), "https://imqueue.com/pricing/index.md");
});

test("only the two @imqueue hosts are readable", () => {
  for (const bad of ["https://example.com/", "https://imqueue.org.evil.test/x/", "https://docs.imqueue.org/"]) {
    assert.throws(() => mirrorUrl(bad), /Refusing to fetch/, bad);
  }
});

test("llms.txt entries keep their section and drop the mirror pointer", () => {
  const feed = [
    "# @imqueue",
    "",
    "> Some prose that is not a link list.",
    "",
    "## Getting Started",
    "- [Get started](https://imqueue.org/get-started/): Your first service in minutes. — [markdown](https://imqueue.org/get-started/index.md)",
    "",
    "## Articles",
    "- [Graceful shutdown](https://imqueue.org/blog/graceful/): Drain in-flight work.",
    "not a list item",
  ].join("\n");

  const entries = parseLlmsTxt(feed);

  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    title: "Get started",
    url: "https://imqueue.org/get-started/",
    // The `— [markdown](…)` pointer is the mirror mirrorUrl() computes anyway, and
    // left in place it is 60 characters of URL in every single search result.
    description: "Your first service in minutes.",
    section: "Getting Started",
  });
  assert.equal(entries[1].section, "Articles");
});

// getDoc caches nothing, so stubbing fetch here cannot leak into another test.
// node:test runs each file in its own process in any case.
test("every upstream request carries a timeout and identifies itself", async (t) => {
  const seen: RequestInit[] = [];
  const real = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = real;
  });

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen.push(init);

    return new Response("# page", { status: 200 });
  }) as typeof fetch;

  setUserAgent("imqueue-mcp/9.9.9");
  await getDoc("https://imqueue.org/get-started/");

  assert.equal(seen.length, 1);
  // There was no timeout anywhere, so a hung origin hung the tool call for as long
  // as the platform allowed.
  assert.ok(seen[0].signal instanceof AbortSignal, "no abort signal on the request");
  assert.equal(
    (seen[0].headers as Record<string, string>)["user-agent"],
    "imqueue-mcp/9.9.9",
    "the server's own reads were indistinguishable from any other caller's",
  );
});

test("an oversized page is truncated and says so", async (t) => {
  const real = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = real;
  });

  // /llms-full.txt is a real entry in the index and is 574 kB — the whole
  // documentation set. Returning it whole is a context flush, not a read.
  globalThis.fetch = (async () => new Response("x".repeat(600_000), { status: 200 })) as typeof fetch;

  const doc = await getDoc("https://imqueue.org/llms-full.txt");

  assert.equal(doc.truncated, true);
  assert.ok(doc.markdown.length < 600_000, `${doc.markdown.length} bytes returned`);
  assert.match(doc.markdown, /truncated: 600000 bytes total/);
});

test("a commercial page with no mirror returns a pointer, not an error", async (t) => {
  const real = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = real;
  });

  globalThis.fetch = (async () => new Response("Not found", { status: 404 })) as typeof fetch;

  // isError here reads as "this server cannot answer" when the answer is one fetch
  // away, and search_docs legitimately returns imqueue.com URLs.
  const doc = await getDoc("https://imqueue.com/terms/");

  assert.equal(doc.url, "https://imqueue.com/terms/");
  assert.match(doc.markdown, /imqueue\.com, the commercial edition/);

  // imqueue.org is different: a 404 there means a wrong URL, and an actionable
  // error is the right answer.
  await assert.rejects(() => getDoc("https://imqueue.org/nope/"), /Use search_docs/);
});

// ---- fragment slicing ------------------------------------------------------
//
// The ranges come from imqueue.com's /search-sections.json and are 0-indexed, absolute in
// the mirror FILE, with `start` on the heading's own line. That contract is asserted at the
// source by check-search-index.js; these fixtures encode the same shape so a change to it
// breaks here rather than in a returned half-section.

const PAGE = [
  "# Agent recipe: delayed work", //         0
  "", //                                     1
  "Source: https://imqueue.org/agents/x/", // 2
  "", //                                     3
  "Intro prose.", //                         4
  "", //                                     5
  "## Choose the mechanism", //               6
  "", //                                     7
  "Pick one.", //                            8
  "", //                                     9
  "### Delayed call", //                    10
  "", //                                    11
  "Use the trailing argument.", //           12
  "", //                                    13
  "## Verify", //                           14
  "", //                                    15
  "Run the checks.", //                     16
].join("\n");

const RANGES: Record<string, [number, number]> = {
  "choose-the-mechanism": [6, 10],
  "delayed-call": [10, 14],
  verify: [14, 17],
};

test("a fragment returns its own section, not the page", () => {
  const cut = sliceSection(PAGE, RANGES, "verify");

  assert.ok(cut);
  assert.equal(cut.markdown, "## Verify\n\nRun the checks.");
  assert.equal(cut.section.heading, "Verify");
  assert.equal(cut.section.index, 3);
  assert.equal(cut.section.total, 3);
});

test("the heading path names every enclosing section, outermost first", () => {
  const cut = sliceSection(PAGE, RANGES, "delayed-call");

  assert.ok(cut);
  // Without this an agent cannot tell WHICH page's "Verify" or "Delayed call" it holds:
  // the section arrives with no surrounding page.
  assert.deepEqual(cut.section.ancestors, ["Agent recipe: delayed work", "Choose the mechanism"]);
  assert.equal(cut.markdown, "### Delayed call\n\nUse the trailing argument.");

  // A top-level section's only ancestor is the page title — `## Verify` must NOT collect
  // the `### Delayed call` that precedes it, which is a sibling's child, not a parent.
  assert.deepEqual(sliceSection(PAGE, RANGES, "verify")?.section.ancestors, [
    "Agent recipe: delayed work",
  ]);
});

test("an unindexed or stale range slices nothing rather than half a section", () => {
  assert.equal(sliceSection(PAGE, RANGES, "no-such-anchor"), null);

  // The feed and the mirror disagree — a cached range against a rewritten page. Returning
  // lines that do not start at a heading would look like a real section.
  assert.equal(sliceSection(PAGE, { drifted: [4, 6] }, "drifted"), null);
  assert.equal(sliceSection(PAGE, { past: [999, 1000] }, "past"), null);
});

test("end to end: a fragment slices, a mistyped one says so, and a dead feed still slices", async (t) => {
  const real = globalThis.fetch;
  let sections = 0;

  t.after(() => {
    globalThis.fetch = real;
  });

  // All three phases live in ONE test because the ranges cache is keyed by origin with an
  // hour TTL, so only the first call to a host can ever be a cold load — split across
  // tests, the later ones would silently depend on declaration order.
  globalThis.fetch = (async (url: string) => {
    if (!String(url).endsWith("/search-sections.json")) return new Response(PAGE, { status: 200 });

    sections++;

    return sections === 1
      ? new Response(JSON.stringify({ v: 1, pages: { "/agents/x/": RANGES } }), { status: 200 })
      : new Response("gone", { status: 500 });
  }) as typeof fetch;

  const hit = await getDoc("https://imqueue.org/agents/x/#verify");

  assert.equal(hit.section?.heading, "Verify");
  assert.equal(hit.markdown, "## Verify\n\nRun the checks.");

  // Silently widening a mistyped fragment to the whole page tells an agent its fragment
  // worked, and it will keep citing an anchor that does not exist.
  const miss = await getDoc("https://imqueue.org/agents/x/#verfiy");

  assert.equal(miss.section, undefined);
  assert.equal(miss.fragmentMiss?.anchor, "verfiy");
  assert.deepEqual(miss.fragmentMiss?.available, Object.keys(RANGES));
  assert.equal(miss.markdown, PAGE);

  // The feed would 500 now. Inside the TTL it is not re-fetched at all, so slicing carries
  // on — and a range that HAS drifted fails the heading check rather than returning half a
  // section, which is what makes serving a cached copy safe.
  const cached = await getDoc("https://imqueue.org/agents/x/#delayed-call");

  assert.equal(cached.section?.heading, "Delayed call");
  assert.equal(sections, 1, "the cached range list should not be re-fetched inside its TTL");
});

test("with no cached ranges, an unreadable feed returns the whole page and never errors", async (t) => {
  const real = globalThis.fetch;

  t.after(() => {
    globalThis.fetch = real;
  });

  // Slicing is an improvement on returning 9 kB, not a precondition for reading a doc.
  // Uses imqueue.com because the ranges cache is keyed by ORIGIN and nothing else in this
  // file loads com's — so this is a genuinely cold load, not an artefact of test order.
  globalThis.fetch = (async (url: string) =>
    (String(url).endsWith("/search-sections.json")
      ? new Response("nope", { status: 500 })
      : new Response(PAGE, { status: 200 }))) as typeof fetch;

  const doc = await getDoc("https://imqueue.com/agents/x/#verify");

  assert.equal(doc.markdown, PAGE);
  assert.equal(doc.section, undefined);
  assert.equal(doc.fragmentMiss?.available.length, 0);
});


test("the section suffix distinguishes the two editions", () => {
  // Both feeds have a "Commercial" heading meaning different things, and a
  // result's section is what a caller reads to tell the framework from the licence.
  const entries = parseLlmsTxt(
    ["## Commercial", "- [Pricing](https://imqueue.com/pricing/): What a licence includes."].join("\n"),
    " · imqueue.com",
  );

  assert.equal(entries[0].section, "Commercial · imqueue.com");
});
