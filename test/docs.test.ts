// URL resolution and feed parsing — the two places get_doc silently 404'd.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { getDoc, mirrorUrl, parseLlmsTxt, setUserAgent } from "../src/docs.js";

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

test("the section suffix distinguishes the two editions", () => {
  // Both feeds have a "Commercial" heading meaning different things, and a
  // result's section is what a caller reads to tell the framework from the licence.
  const entries = parseLlmsTxt(
    ["## Commercial", "- [Pricing](https://imqueue.com/pricing/): What a licence includes."].join("\n"),
    " · imqueue.com",
  );

  assert.equal(entries[0].section, "Commercial · imqueue.com");
});
