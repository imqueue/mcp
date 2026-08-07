# Changelog

Hand-written notes for releases where the change is worth describing. The release
workflow prefers a section here for the exact version being tagged and falls back to
GitHub's PR-derived notes when there is none, so older versions are absent by choice
rather than omission — their notes are auto-generated on their release pages.

Keep each version's heading at `##` and use **bold** rather than `###` inside a
section: the workflow's extractor stops at the next heading of three hashes or fewer,
so a subheading would truncate the notes at that point.

**Write the section before running `npm version`.** The release workflow reads
CHANGELOG.md as it existed at the tag, so a section added afterwards is invisible to
it and the release page silently takes the auto-generated fallback. That happened to
3.4.1, whose notes had to be edited onto the page by hand.

## 3.4.1

**Nothing changed for you, and that is the whole entry.** The published package is
byte-for-byte the 3.4.0 code — same unpacked size to the byte, and the only difference
between the two tags is a test script that `files` does not ship. If you are on 3.4.0
there is nothing here to upgrade for.

It exists because 3.4.0's release ran every step except one: the hosted contract smoke
failed a check, so the deploy step reported failure after npm, the registry and the
Cloudflare Worker had all already updated. The check was wrong, not the server — it
asserted that `get_doc` echoes back the URL you gave it, which had only ever been true
because a page URL is a prefix of the mirror path get_doc names, so it passed for free
without testing anything. 3.4.0's own feature broke the coincidence: a result URL now
carries a `#fragment`, the mirror does not, and the substring stopped matching.

It now asserts what the chain is for. Page identity is checked against the URL without
its fragment, and the slice gets its own assertion — following `search_docs`' top
result must cost the section, not the page, measured live at 2,215 of 39,945
characters. 3.4.1 is the release that proved the corrected pipeline runs end to end
with nothing failing.

## 3.4.0

**`search_docs` now ranks with the same engine imqueue.org's own search uses.** It was
a separate implementation scoring a separate corpus, which meant the documentation
site and this server could disagree about which page answers a question. They no
longer can: one ranker, one corpus, one relevance test suite.

Measured against the previous engine on the same corpus, before and after:

- agent-shaped identifier queries (3,657 of them): recall@6 **83.9% → 99.5%**, with
  no query losing an answer it previously found;
- chat-shaped questions (115 judged cases): **55.7% → 66.1%** (p = 0.0241);
- keyword-shaped queries: unchanged.

Two consequences you can see directly. Results can now be **section anchors** rather
than whole pages, so an answer points at the paragraph that carries it. And
**licensing and pricing questions answer from imqueue.com** — the ranker's "the site
you are on wins" rule is dropped here, because a server is on no site, and with it in
force `commercial license` returned no imqueue.com result at all.

An empty or whitespace-only `query` now returns no results instead of the corpus
truncated to `limit`. A query with no terms matches everything, which was reachable
through this tool in a way it is not on the website.

**`get_doc` accepts a URL fragment and returns just that section.** Following
`search_docs`'s own top result used to mean reading the whole page, because the
fragment was dropped: `https://imqueue.org/api/#service-and-client` returned 42,498
bytes to reach the 4,932 that answered the question. The slice carries its heading
path (`API Reference › RPC API › Service and Client`) and its position (`section 3 of
20`) so a reader knows what was left out and how to ask for the rest.

Every failure falls back to the whole page rather than erroring — a missing or
unreadable section map, or a map that disagrees with the page. A fragment that is not
an indexed section is **reported**, together with the anchors that do exist, because
silently returning the whole page would tell an agent its fragment worked.

**Fixed:** three advisories reachable through the published dependency graph, two of
them high — `fast-uri`, `ip-address` and `hono`, all transitive under
`@modelcontextprotocol/sdk`. Lockfile bumps only.

**Nothing about the tool surface changed.** Same tool names, same parameters, same
`limit` bounds and default, same output fields. `get_doc`'s description is the one
edit, and it had to be: "the full markdown" stopped being true.
