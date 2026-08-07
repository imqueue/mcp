# Changelog

Hand-written notes for releases where the change is worth describing. The release
workflow prefers a section here for the exact version being tagged and falls back to
GitHub's PR-derived notes when there is none, so older versions are absent by choice
rather than omission — their notes are auto-generated on their release pages.

Keep each version's heading at `##` and use **bold** rather than `###` inside a
section: the workflow's extractor stops at the next heading of three hashes or fewer,
so a subheading would truncate the notes at that point.

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
