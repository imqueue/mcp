// URL resolution and feed parsing — the two places get_doc silently 404'd.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mirrorUrl, parseLlmsTxt } from "../src/docs.js";

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

test("the section suffix distinguishes the two editions", () => {
  // Both feeds have a "Commercial" heading meaning different things, and a
  // result's section is what a caller reads to tell the framework from the licence.
  const entries = parseLlmsTxt(
    ["## Commercial", "- [Pricing](https://imqueue.com/pricing/): What a licence includes."].join("\n"),
    " · imqueue.com",
  );

  assert.equal(entries[0].section, "Commercial · imqueue.com");
});
