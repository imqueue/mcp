// Docs access for the @imqueue MCP server.
//
// The docs live on imqueue.org as machine-readable feeds:
//   * /search-index.json      every page, API symbol and question-shaped section
//   * /search-text.json       the prose corpus at heading-section granularity
//   * /search-peer-index.json the same two shapes for imqueue.com, copied onto
//   * /search-peer-text.json  imqueue.org's origin at build time
//   * /llms.txt               curated index: `## Section` + `- [Title](url): description`
//   * /<page-url>index.md     a plain-markdown mirror of every page (also <page>.md)
//
// THE RANKING IS NOT IMPLEMENTED HERE ANY MORE. Those first four feeds are exactly
// what the website's own search box reads, and src/ranker.ts is the same code, pinned
// as a submodule to the same commit imqueue.com pins. This server used to carry its
// own ranker over its own feed, and the two answered the same question differently:
// measured over 3,657 agent-shaped queries, the website's ranker returned a correct
// result in the top 6 for 99.5% of them against this server's 83.9%, and there was no
// query the old ranker answered that the new one does not. Nothing had ever compared
// them, which is how a 15-point gap survives.
//
// llms.txt stays, and is now used for one thing: the human-written `section` label a
// caller reads. It is the only place that text exists.
//
// imqueue.com serves the same shapes for the commercial edition — licensing, pricing
// and support, which the framework docs deliberately do not cover. Note the peer feeds
// are fetched from **imqueue.org**, not from imqueue.com: the website copies them
// across at build time so its own search never makes a cross-origin request, and
// reading them from one origin means one host to be reachable instead of two.
//
// We fetch these at runtime (so the server never ships stale copies) and cache them
// in-process. Only those two hosts are ever fetched.

import {
  assertFeedVersion,
  ranker,
  sectionText,
  type Hit,
  type RankerIndex,
  type RankerSectionIndex,
} from "./ranker.js";

const SITE = "https://imqueue.org";
/**
 * The commercial edition. A separate site, a separate llms.txt, and the ONLY
 * place licensing, pricing and support are documented — so `search_docs
 * "pricing"` returned nothing and `get_doc` refused the one URL that answers "is
 * @imqueue free for commercial use". Both feeds are loaded; both hosts are
 * readable; nothing else is.
 */
const COM = "https://imqueue.com";
const HOSTS = ["imqueue.org", "imqueue.com"];
const TTL_MS = 60 * 60 * 1000; // 1h in-process cache

/**
 * Ceiling on a page body, in bytes.
 *
 * /llms-full.txt is a legitimate entry in the index and is 574 kB — the entire
 * documentation set concatenated. Handing that to a model in one tool result is
 * not a read, it is a context flush, and get_doc had no limit of any kind. The cap
 * is generous next to the largest real page (a 17 kB API reference) and the
 * truncation is reported rather than silent.
 */
const MAX_DOC_BYTES = 200_000;

export interface DocEntry {
  title: string;
  url: string;
  description: string;
  section: string;
  /** Set on API symbol pages; narrows how they are matched (see `searchDocs`). */
  symbol?: boolean;
}

let indexCache: { at: number; entries: DocEntry[] } | null = null;

/**
 * How long any single upstream fetch may take.
 *
 * There was no timeout anywhere, so a hung origin hung a tool call for as long as
 * the platform allowed. Measured cost of the work being protected: 0.53 s for
 * llms.txt and 1.13 s for the symbol index on a fully cold isolate, so five
 * seconds is far above anything legitimate and far below any client's patience.
 */
const FETCH_TIMEOUT_MS = 5000;

/**
 * Identifies this server to imqueue.org's own analytics.
 *
 * The site classifies traffic by user agent (that is the whole point of its
 * agent-analytics edge), and an unset UA from a Worker is indistinguishable from
 * anything else calling the feeds. Set by `createServer` so the version is the one
 * actually running.
 */
let userAgent = "imqueue-mcp";

export function setUserAgent(ua: string): void {
  userAgent = ua;
}

/** Every upstream fetch goes through here: one timeout, one UA, one place. */
async function get(url: string): Promise<Response> {
  return fetch(url, {
    headers: { "user-agent": userAgent },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

function assertImqueueUrl(u: string): URL {
  const url = new URL(u, SITE);

  if (!HOSTS.includes(url.hostname)) {
    throw new Error(
      `Refusing to fetch ${url.href} — only imqueue.org and imqueue.com are read. `
        + "Use search_docs to find a valid page URL.",
    );
  }

  return url;
}

/**
 * Parse one llms.txt body into doc entries.
 *
 * Exported for test/docs.test.ts: this function is where the llms.txt contract
 * lives, and both feeds are written by a different repository.
 */
export function parseLlmsTxt(text: string, sectionSuffix = ""): DocEntry[] {
  const entries: DocEntry[] = [];
  let section = "General";

  for (const line of text.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);

    if (h) {
      section = h[1].trim();
      continue;
    }

    const m = line.match(/^-\s+\[([^\]]+)\]\(([^)]+)\)(?::\s*(.*))?$/);

    if (m) {
      entries.push({
        title: m[1].trim(),
        url: m[2].trim(),
        // Every entry carries a `— [markdown](…)` pointer since A25; it is the
        // mirror mirrorUrl() computes anyway, and left in the description it is
        // 60 characters of URL in every single search result.
        description: (m[3] || "").replace(/\s*—\s*\[markdown\]\([^)]*\)\s*$/, "").trim(),
        section: section + sectionSuffix,
      });
    }
  }

  return entries;
}

/**
 * Fetch + parse the curated index (cached).
 *
 * BOTH editions: imqueue.org documents the framework, imqueue.com documents
 * licensing, pricing and support and is the only place those exist. Without the
 * second feed `search_docs "pricing"` had nothing to return, and the commercial
 * question — the one with revenue attached — was the single thing this server could
 * not answer.
 *
 * imqueue.org is required; imqueue.com is best-effort, because a docs search that
 * dies when the commercial site is unreachable is a worse outcome than one that
 * answers about the framework only. Its entries are appended and deduped by URL, so
 * the three imqueue.com pages the org feed already lists keep their org
 * descriptions and nothing appears twice.
 */
export async function loadIndex(): Promise<DocEntry[]> {
  if (indexCache && Date.now() - indexCache.at < TTL_MS) return indexCache.entries;

  let body: string;

  try {
    const res = await get(`${SITE}/llms.txt`);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    body = await res.text();
  } catch (e) {
    // A usable copy may be sitting in the cache past its TTL. Telling the caller
    // "cannot search the docs" while holding one is the worst of both outcomes —
    // this used to throw. `loadCorpus` degrades the same way, for the same reason.
    if (indexCache) return indexCache.entries;

    throw new Error(
      `Failed to fetch llms.txt (${e instanceof Error ? e.message : String(e)})`,
    );
  }

  const entries = parseLlmsTxt(body);
  const seen = new Set(entries.map((e) => e.url));

  try {
    const comRes = await get(`${COM}/llms.txt`);

    if (comRes.ok) {
      // The section is suffixed because both feeds have a "Commercial" heading
      // meaning different things, and a result's section is what a caller reads to
      // decide whether it is looking at the framework or the licence.
      for (const e of parseLlmsTxt(await comRes.text(), " · imqueue.com")) {
        if (!seen.has(e.url)) {
          entries.push(e);
          seen.add(e.url);
        }
      }
    }
  } catch {
    // Offline or unreachable — the framework docs still answer.
  }

  indexCache = { at: Date.now(), entries };

  return entries;
}

/**
 * The four search feeds, prepared for the ranker.
 *
 * `prepare()` and `prepareSections()` annotate their argument IN PLACE and return it,
 * so what is cached here is the prepared object itself. That is also what makes the
 * caching worth doing: preparing tier 2 folds and counts ~640 kB of prose, measured at
 * 46.6 ms, which is most of a cold isolate's budget.
 */
export interface Corpus {
  at: number;
  index: RankerIndex;
  text: RankerSectionIndex;
  /** imqueue.com's two tiers. Null when the peer feeds are absent — see loadCorpus. */
  peerIndex: RankerIndex | null;
  peerText: RankerSectionIndex | null;
}

let corpusCache: Corpus | null = null;
/**
 * De-duplicates concurrent loads. Nearly a megabyte of JSON, so two tool calls
 * arriving together on a cold isolate would otherwise both fetch and both prepare it.
 */
let corpusInFlight: Promise<Corpus> | null = null;

async function feed(path: string, optional: boolean): Promise<unknown> {
  const res = await get(`${SITE}${path}`);

  if (!res.ok) {
    if (optional) return null;

    throw new Error(`${path}: HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Fetch, version-check and prepare the four feeds (cached, deduped).
 *
 * imqueue.org's own two tiers are REQUIRED — without them there is nothing to rank
 * and no fallback that would not be a second, unmeasured ranker. The peer tiers are
 * best-effort, and their absence is the one degradation worth naming: it is the
 * commercial half of the corpus, so `pricing commercial license` stops answering from
 * imqueue.com and answers from imqueue.org's own /license/ instead — a plausible
 * answer, from the wrong edition, with no error anywhere. That is the failure this
 * server's whole peer-feed story exists to prevent, so it degrades loudly in the log
 * rather than silently in the results.
 */
export async function loadCorpus(): Promise<Corpus> {
  if (corpusCache && Date.now() - corpusCache.at < TTL_MS) return corpusCache;
  if (corpusInFlight) return corpusInFlight;

  corpusInFlight = (async () => {
    try {
      const [index, text, peerIndex, peerText] = await Promise.all([
        feed("/search-index.json", false) as Promise<RankerIndex>,
        feed("/search-text.json", false) as Promise<RankerSectionIndex>,
        feed("/search-peer-index.json", true) as Promise<RankerIndex | null>,
        feed("/search-peer-text.json", true) as Promise<RankerSectionIndex | null>,
      ]);

      // Before preparing, not after: a shape this ranker cannot read must not be
      // scored at all, and prepare() would happily annotate the wrong fields.
      assertFeedVersion("/search-index.json", index);
      assertFeedVersion("/search-text.json", text);

      if (peerIndex) assertFeedVersion("/search-peer-index.json", peerIndex);
      if (peerText) assertFeedVersion("/search-peer-text.json", peerText);

      if (!peerIndex || !peerText) {
        console.error(
          "imqueue.com's search feeds are unavailable — licensing, pricing and support "
            + "questions will answer from the framework docs instead of the commercial site.",
        );
      }

      corpusCache = {
        at: Date.now(),
        index: ranker.prepare(index),
        text: ranker.prepareSections(text),
        peerIndex: peerIndex ? ranker.prepare(peerIndex) : null,
        peerText: peerText ? ranker.prepareSections(peerText) : null,
      };

      return corpusCache;
    } catch (e) {
      // A usable copy may be sitting in the cache past its TTL, and it is a far better
      // answer than "cannot search the docs" — same reasoning as loadIndex.
      if (corpusCache) return corpusCache;

      throw new Error(
        `Failed to load the search corpus from ${SITE} `
          + `(${e instanceof Error ? e.message : String(e)})`,
      );
    } finally {
      corpusInFlight = null;
    }
  })();

  return corpusInFlight;
}

/**
 * True when `e` belongs to `pkg` — the `package` filter of `search_docs`.
 *
 * Accepts `http-protect` or `@imqueue/http-protect`. Kept for `suggest()` and for the
 * curated half; the ranker does its own package filtering (see `scopedQuery`).
 */
function inPackage(e: DocEntry, pkg: string): boolean {
  const short = shortPackage(pkg);

  if (!short) return true;

  return (
    e.section.toLowerCase().includes(`@imqueue/${short}`)
    || e.url.toLowerCase().includes(`/api/${short}/`)
  );
}

function shortPackage(pkg: string): string {
  return pkg.trim().replace(/^@imqueue\//, "").toLowerCase();
}

/**
 * Fold a curated llms.txt URL into the key the feeds use: a root-relative path.
 *
 * The two feeds hold root-relative URLs for their own edition, while llms.txt entries
 * are written however the site writes them, and both editions have a `/license/` and a
 * `/contact/` that are different pages. So the key carries the host.
 */
function urlKey(u: string, base = SITE): string {
  try {
    const url = new URL(u, base);

    return `${url.hostname}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u;
  }
}

/**
 * Section label per result, and the ONE thing llms.txt is still read for.
 *
 * `section` is a frozen output field of search_docs and a caller reads it to decide
 * whether it is looking at the framework or at the licence, so it has to keep meaning
 * what it meant. Four sources, in falling order of how hand-made they are:
 *
 *  * an API symbol keeps today's exact `API · @imqueue/pkg kind` shape. Not cosmetic:
 *    packages.ts detects the mutually-exclusive pairs by looking for a package name in
 *    `section + url`, so a label that stopped naming the package would silently stop
 *    the pg-prisma/pg-sequelize and opentelemetry/datadog advisories from firing;
 *  * otherwise the curated llms.txt section, which is the only hand-written one
 *    ("Guides", "Commercial · imqueue.com");
 *  * otherwise the page's own kind from the feed — Recipe, Tutorial, CLI, Glossary,
 *    Compare, Article — which is better than any label derivable from the URL;
 *  * and an answer names the page it was lifted out of, because a question-shaped
 *    result is only useful if you can see what it is an answer within.
 */
function labelFor(hit: Hit, curated: Map<string, string>): string {
  const { record } = hit;
  const host = hit.external ? "imqueue.com" : "imqueue.org";

  if (record.g === 1) {
    return `API · ${record.p || "@imqueue"}${record.k ? ` ${record.k}` : ""}`;
  }

  const label = curated.get(urlKey(record.u, hit.external ? COM : SITE));

  if (label) return label;

  // On an answer record `k` holds the PARENT PAGE'S TITLE, not a kind — the field is
  // overloaded by group in the feed. Titles are long, so it is trimmed rather than
  // repeated whole into every result.
  if (record.g === 2 && record.k) {
    return `Answer · ${truncate(record.k, 60)}`;
  }

  const kind = record.k && record.k !== "Docs" ? record.k : "Docs";

  return hit.external ? `${kind} · imqueue.com` : kind;
}

/** Cut at a word boundary, so a description does not end mid-identifier. */
function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();

  if (clean.length <= max) return clean;

  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");

  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * How much of a matched section to hand back as the description.
 *
 * The website shows a 190-character snippet highlighted around the query. An agent has
 * no highlighting and a much better use for the text, so this is generous by
 * comparison — but still a description, not a read: `get_doc` is one call away and
 * Phase 3 will return the section itself.
 */
const SECTION_CHARS = 320;

function describe(hit: Hit): string {
  const { record } = hit;

  // A section hit's own record carries no summary (the ranker synthesises it from the
  // page and the heading), so the matched prose IS the description.
  if (hit.section) return truncate(sectionText(hit), SECTION_CHARS);

  const summary = truncate(record.s || "", SECTION_CHARS);

  // The deprecation marker leads, so an agent scanning results sees it before it
  // copies the symbol into code.
  return record.d ? `DEPRECATED — do not use in new code. ${summary}`.trim() : summary;
}

/**
 * Drop the website's site-priority rule, keeping everything else about the order.
 *
 * The ranker sorts `(a.external ? 1 : 0) - (b.external ? 1 : 0)` FIRST, so on
 * imqueue.org every imqueue.org result precedes every imqueue.com one however much
 * better the imqueue.com one is. That is right for a website and its own comment says
 * why — "THE SITE YOU ARE ON WINS" — because a reader on imqueue.org asking about
 * licensing should see imqueue.org's own licence page before the commercial site's.
 *
 * AN MCP CLIENT IS ON NO SITE. It asked about pricing, and pricing exists only on
 * imqueue.com. Measured against the live feeds with the rule in force: `commercial
 * license` and `is imqueue free for commercial use` returned NO imqueue.com result at
 * all inside the default limit of 6, and `pricing commercial license` returned one at
 * #5 — gone at `limit: 3`. That is a regression on precisely the question this server
 * went out of its way to fix, and the kind that reads as a confident answer from the
 * wrong edition rather than as an error.
 *
 * Re-sorting here rather than changing the ranker keeps the website byte-identical, and
 * it is the honest place for it: this is the one ranking rule that encodes *where the
 * reader is standing*, which is a property of the caller and not of the corpus.
 *
 * It cannot change WHICH hits come back, only their order — the ranker's per-group
 * floor keys local and peer groups separately (`"x:" + groupKey(hit)`) and its
 * per-page cap is keyed by URL, so both had already been applied when `search()`
 * returned. The remaining keys are the ranker's own tie-breaks, kept verbatim:
 * shortest title, then shortest URL.
 */
function byScore(hits: Hit[]): Hit[] {
  return [...hits].sort(
    (a, b) =>
      b.score - a.score
      || a.record.t.length - b.record.t.length
      || a.record.u.length - b.record.u.length,
  );
}

/**
 * Turn the ranker's hits into the tool's own result shape.
 *
 * The URL is the part that must not be got wrong. Feed records hold root-relative
 * paths for THEIR OWN edition, and `external` is the only thing that says which
 * edition that is — so prefixing every record with imqueue.org would hand back
 * imqueue.org URLs for imqueue.com's pricing pages. They would 404 through `get_doc`,
 * and returning URLs a caller cannot use is the one change here that would force a
 * major version bump rather than a minor one.
 */
function toEntries(hits: Hit[], curated: Map<string, string>, limit: number): DocEntry[] {
  const out: DocEntry[] = [];

  for (const hit of byScore(hits)) {
    if (out.length >= limit) break;

    out.push({
      title: hit.record.t,
      url: `${hit.external ? COM : SITE}${hit.record.u}`,
      description: describe(hit),
      section: labelFor(hit, curated),
      ...(hit.record.g === 1 ? { symbol: true } : {}),
    });
  }

  return out;
}

/** URL key -> curated section label, for both editions. */
function curatedSections(entries: DocEntry[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const e of entries) {
    // imqueue.com's entries are the ones whose section carries the suffix loadIndex
    // appends, and their URLs are relative to imqueue.com.
    const base = e.section.endsWith(" · imqueue.com") ? COM : SITE;

    map.set(urlKey(e.url, base), e.section);
  }

  return map;
}

/**
 * Express the `package` filter as the ranker's own `pkg:` syntax.
 *
 * Reusing the ranker's filter rather than post-filtering its output is the whole point:
 * a filter applied afterwards would take the top N and then discard from them, so a
 * scoped search would return fewer results than it found, or none at all.
 *
 * Two consequences of the ranker's implementation, both accepted deliberately:
 * a scoped query matches on the record's own `package` field, so it reaches API
 * symbols and package index pages but not a guide that merely discusses the package;
 * and the ranker skips the prose tier entirely while a filter is set, so a scoped
 * search returns reference rather than articles. Both are what the website does, and
 * "what the website does" is the property this whole change is for.
 */
function scopedQuery(query: string, pkg?: string): string {
  const short = pkg ? shortPackage(pkg) : "";

  return short ? `pkg:${short} ${query}` : query;
}

/**
 * Search the docs: the four feeds, the shared ranker, and nothing of our own.
 *
 * `limit` is applied here rather than inside the ranker because the ranker does not
 * take one — it returns everything above its relative and absolute floors, which is
 * how the website can show groups. See the note on eviction in the plan: the hits this
 * drops are a measured question, not a settled one.
 */
export async function searchDocs(query: string, limit = 6, pkg?: string): Promise<DocEntry[]> {
  const [corpus, curated] = await Promise.all([loadCorpus(), loadIndex()]);

  return rankCorpus(corpus, curated, query, limit, pkg);
}

/**
 * The search, separated from the fetching so it can be tested on a fixed corpus.
 *
 * The same split the old ranker had, and for the same reason it gave: every defect this
 * has ever had was a defect of *what comes back*, and none of them are assertable while
 * the only way to run it is against the live site — the corpus moves, so a test written
 * against it encodes today's content rather than the rule. What is testable here is now
 * the mapping rather than the ranking: the ranking belongs to the submodule and is
 * measured by imqueue.com's KPI harness.
 */
export function rankCorpus(
  corpus: Corpus,
  curated: DocEntry[],
  query: string,
  limit = 6,
  pkg?: string,
): DocEntry[] {
  // Assigned per search rather than once at load: the corpus can be refetched behind
  // us, and `search()` is synchronous, so setting it immediately before the call is
  // what makes an interleaved refresh unable to score half of one corpus and half of
  // another.
  ranker.state.t1 = corpus.index;
  ranker.state.t2 = corpus.text;
  ranker.state.x1 = corpus.peerIndex;
  ranker.state.x2 = corpus.peerText;

  const parsed = ranker.parseQuery(scopedQuery(query, pkg));

  // A query with no terms in it matches EVERYTHING, not nothing — verified against the
  // ranker: with `terms` empty every record clears the score floor, so `"   "` came back
  // as the whole corpus truncated to `limit`, in ranked order, presented as relevant.
  //
  // On the website that is unreachable, which is why it is not a bug there: the dialog
  // does not search an empty input. Here it is reachable, because `search_docs` bounds
  // `query` at min(1) and whitespace satisfies that. The old ranker had the same hole and
  // answered it with the first N curated pages, so this is not a regression — it is an
  // edge that was never closed.
  //
  // Zero results is both the honest answer and the more useful one: server.ts turns an
  // empty result into what the corpus covers plus the indexed terms nearest the query,
  // which is information the model cannot have.
  if (!parsed.terms.length) return [];

  return toEntries(ranker.search(parsed), curatedSections(curated), limit);
}

/**
 * What to tell a caller whose query matched nothing.
 *
 * "Try broader terms or call list_packages" is advice the model already had. What
 * it cannot know is what this corpus is ABOUT and which real vocabulary sits near
 * the words it chose — and a model that gets nothing twice stops asking and
 * answers from its priors, which is the failure this whole server exists to
 * prevent. So: the section names, and the indexed terms nearest to the query.
 */
export async function suggest(query: string): Promise<{ sections: string[]; nearest: string[] }> {
  const curated = await loadIndex();
  const sections: string[] = [];

  for (const e of curated) {
    if (!sections.includes(e.section)) sections.push(e.section);
  }

  // The vocabulary now comes from the PROSE corpus's own document frequencies — 5,310
  // terms over 719 sections, built by prepareSections. That is a straight upgrade on
  // what this used to read: the old df map was built from titles, sections and
  // summaries only, so "the indexed terms nearest your query" could not offer a word
  // that appears in the documentation but in no title.
  //
  // It is also the only part of this function that can fail, so it fails alone: naming
  // what the corpus covers is still worth returning when the feeds are unreachable.
  let df: Record<string, number> = {};
  let asked: string[] = [];

  try {
    const corpus = await loadCorpus();

    df = corpus.text.df ?? {};
    // The ranker's own tokenizer, not a second one. It folds and splits exactly as the
    // search did, which is what makes "nearest to your query" mean nearest to the
    // query that actually ran.
    asked = ranker.parseQuery(query).terms;
  } catch {
    return { sections, nearest: [] };
  }

  const scoredTerms: { term: string; n: number }[] = [];
  // Five, not four: a four-character prefix offered `characters` and `charges` for
  // "helm chart", and a suggestion list full of coincidences is worse than none —
  // it invites another query that also returns nothing.
  const NEAR_PREFIX = 5;
  const NEAR_CONTAINS = 4;

  for (const term of Object.keys(df)) {
    // "Nearest" means shares a real prefix with, or contains, something asked for
    // — enough to surface `authenticated` for "authentication" without pretending
    // to be a spell-checker.
    const near = asked.some(
      (t) =>
        (t.length >= NEAR_PREFIX && term.startsWith(t.slice(0, NEAR_PREFIX)))
        || (t.length >= NEAR_CONTAINS && term.includes(t))
        || (term.length >= NEAR_CONTAINS && t.includes(term)),
    );

    if (near && !asked.includes(term)) scoredTerms.push({ term, n: df[term] ?? 0 });
  }

  // Commonest first: a term one page uses once is a worse suggestion than one the
  // corpus is organised around.
  const nearest = scoredTerms.sort((a, b) => b.n - a.n).slice(0, 8).map((x) => x.term);

  return { sections, nearest };
}

/**
 * Resolve a page URL/path to its markdown-mirror URL (`<page-url>index.md`).
 *
 * A path that already names a FILE is left alone. `index.md` was appended to
 * anything not ending in `.md`, which turned two URLs the index itself publishes —
 * `/llms-full.txt` and `/blog/feed.xml` — into guaranteed 404s. The site also
 * serves every mirror at `<page>.md` as well as `<page>/index.md`, so both shapes
 * have to pass through untouched.
 */
export function mirrorUrl(pageUrl: string): string {
  const url = assertImqueueUrl(pageUrl);
  const p = url.pathname;
  const last = p.slice(p.lastIndexOf("/") + 1);

  // A trailing slash means a page, however many dots the segment contains —
  // /api/core/latest/core.redisqueue.send/ is a page, not a file.
  if (!p.endsWith("/") && last.includes(".")) return url.href;

  return `${url.origin}${p.endsWith("/") ? p : `${p}/`}index.md`;
}

/** Fetch the full markdown of a doc page by its page URL or path. */
export async function getDoc(
  pageUrl: string,
): Promise<{ url: string; markdown: string; truncated: boolean }> {
  const mUrl = mirrorUrl(pageUrl);
  const res = await get(mUrl);

  if (!res.ok) {
    const url = new URL(mUrl);

    // A page on the commercial site with no markdown mirror is not a caller
    // error, and `isError` is the wrong answer to it: search_docs legitimately
    // returns imqueue.com URLs (they are the only place licensing and pricing are
    // documented), so a refusal there reads as "this server cannot answer" when
    // the answer exists one fetch away.
    if (url.hostname === "imqueue.com") {
      const page = mUrl.replace(/index\.md$/, "");

      return {
        url: page,
        markdown: [
          `# ${page}`,
          "",
          `This page is on imqueue.com, the commercial edition, and has no markdown`,
          `mirror to read (HTTP ${res.status}). Read it at ${page}.`,
          "",
          "imqueue.com covers licensing, pricing and support only; the framework",
          `documentation is on ${SITE}.`,
        ].join("\n"),
        truncated: false,
      };
    }

    throw new Error(
      `Failed to fetch ${mUrl} (HTTP ${res.status}). Use search_docs to find a valid page URL.`,
    );
  }

  const body = await res.text();

  if (body.length > MAX_DOC_BYTES) {
    return {
      url: mUrl,
      markdown: `${body.slice(0, MAX_DOC_BYTES)}\n\n[truncated: ${body.length} bytes total, `
        + `${MAX_DOC_BYTES} returned. Read a specific page instead of the whole set.]`,
      truncated: true,
    };
  }

  return { url: mUrl, markdown: body, truncated: false };
}
