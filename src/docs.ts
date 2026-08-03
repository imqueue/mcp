// Docs access for the @imqueue MCP server.
//
// The docs live on imqueue.org as machine-readable feeds:
//   * /llms.txt              — curated index: `## Section` + `- [Title](url): description`
//   * /api/search-index.json — every exported symbol of the current majors:
//                              [{ name, kind, package, url, summary, deprecated? }]
//   * /<page-url>index.md    — a plain-markdown mirror of every page
//   * /blog/search-index.json — [{ title, url, summary, topics, ... }]
//
// We fetch these at runtime (so the server never ships stale copies) and cache
// them in-process. Only imqueue.org is ever fetched.

const SITE = "https://imqueue.org";
const TTL_MS = 60 * 60 * 1000; // 1h in-process cache

export interface DocEntry {
  title: string;
  url: string;
  description: string;
  section: string;
  /** Set on API symbol pages; narrows how they are matched (see `searchDocs`). */
  symbol?: boolean;
}

/** One record of /api/search-index.json. */
interface ApiSymbol {
  name: string;
  url: string;
  kind?: string;
  package?: string;
  summary?: string;
  deprecated?: boolean;
}

let indexCache: { at: number; entries: DocEntry[] } | null = null;
let apiCache: { at: number; entries: DocEntry[] } | null = null;

function assertImqueueUrl(u: string): URL {
  const url = new URL(u, SITE);
  if (url.hostname !== "imqueue.org") {
    throw new Error(`Refusing to fetch non-imqueue.org URL: ${url.href}`);
  }
  return url;
}

/** Fetch + parse /llms.txt into a flat list of doc entries (cached). */
export async function loadIndex(): Promise<DocEntry[]> {
  if (indexCache && Date.now() - indexCache.at < TTL_MS) return indexCache.entries;

  const res = await fetch(`${SITE}/llms.txt`);
  if (!res.ok) throw new Error(`Failed to fetch llms.txt (HTTP ${res.status})`);
  const text = await res.text();

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
        description: (m[3] || "").trim(),
        section,
      });
    }
  }
  indexCache = { at: Date.now(), entries };
  return entries;
}

/**
 * Fetch + parse /api/search-index.json into doc entries (cached).
 *
 * llms.txt lists only the two package indexes, so without this feed a query for
 * a symbol name — the most natural thing to search for — matches nothing at all.
 * A missing or unreachable feed is not fatal: the curated index on its own still
 * answers how-to questions, so this degrades to the previous behaviour.
 */
export async function loadApiIndex(): Promise<DocEntry[]> {
  if (apiCache && Date.now() - apiCache.at < TTL_MS) return apiCache.entries;

  let entries: DocEntry[] = [];

  try {
    const res = await fetch(`${SITE}/api/search-index.json`);

    if (res.ok) {
      const raw: unknown = await res.json();

      entries = (Array.isArray(raw) ? (raw as ApiSymbol[]) : [])
        .filter((s) => s && typeof s.name === "string" && typeof s.url === "string")
        .map((s) => ({
          title: s.name,
          url: `${SITE}${s.url}`,
          // The deprecation marker leads, so an agent scanning results sees it
          // before it copies the symbol into code.
          description: s.deprecated
            ? `DEPRECATED — do not use in new code. ${s.summary || ""}`.trim()
            : s.summary || "",
          section: `API · ${s.package || "@imqueue"}${s.kind ? ` ${s.kind}` : ""}`,
          symbol: true,
        }));
    }
  } catch {
    // Offline, or the feed is not deployed yet — searchDocs carries on without it.
  }

  apiCache = { at: Date.now(), entries };
  return entries;
}

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with",
  "is", "are", "how", "do", "does", "i", "my", "me", "it", "that", "this",
  // Empty verbs and fillers that a spoken question carries and a title does not
  // mean: "how do I GET a typed client" must not match `ICache.get`, and "how do
  // I USE x" must not match every `useX`.
  "get", "use", "using", "need", "want", "real", "from", "by",
  "you", "your", "we", "as", "at", "if", "than", "then", "there",
]);

function tokenize(s: string): string[] {
  const out = new Set<string>();

  for (const token of s.toLowerCase().split(/[^a-z0-9@/+.-]+/)) {
    if (token.length > 1 && !STOP.has(token)) {
      out.add(token);
    }

    // A dotted or slashed reference is one token above, which on its own can
    // never match anything: `RedisQueue.send` has to also yield `redisqueue`
    // and `send`, and `@imqueue/core` has to also yield `core`.
    if (/[./]/.test(token)) {
      for (const part of token.split(/[./]+/)) {
        if (part.length > 1 && !STOP.has(part)) {
          out.add(part);
        }
      }
    }
  }

  return [...out];
}

const formsMemo = new Map<string, string[]>();

/**
 * A token plus its plausible other inflections.
 *
 * Case-folding alone meant "authentication" returned NOTHING while "auth" put the
 * tutorial's auth service at #1, and "caching" found two package indexes while
 * "cache" found six real pages. Zero results is not a neutral outcome: it is
 * positive evidence to the model that the corpus does not cover the topic, so it
 * stops asking and answers from its priors.
 *
 * Deliberately NOT a stemmer that reduces to one canonical root — getting that
 * right per word is exactly the part that goes wrong. Both the corpus and the
 * query are expanded to a SET of candidate forms and matched form-to-form, so a
 * wrong guess costs a missed match rather than a wrong one. `-ing`/`-ed`/`-tion`
 * emit the bare stem and an `e`-restored variant precisely because we cannot tell
 * which of `cach`/`cache` is real.
 *
 * There is no synonym map, and there should not be: "login" and "pricing" return
 * nothing because no page on imqueue.org covers them, which is a corpus problem
 * (and, for pricing, an edition problem — see the imqueue.com entries loaded
 * below). Faking recall with synonyms would hide that.
 */
function formsOf(token: string): string[] {
  const memo = formsMemo.get(token);

  if (memo) return memo;

  const forms = new Set<string>([token]);
  const add = (s: string) => {
    if (s.length > 2 && !STOP.has(s)) forms.add(s);
  };

  if (/ies$/.test(token)) {
    add(`${token.slice(0, -3)}y`); // retries -> retry
  } else if (/(?:ses|xes|zes|ches|shes)$/.test(token)) {
    add(token.slice(0, -2)); // caches -> cache, matches -> match
  } else if (/es$/.test(token)) {
    add(token.slice(0, -1));
    add(token.slice(0, -2));
  } else if (/[^s]s$/.test(token)) {
    add(token.slice(0, -1)); // jobs -> job
  }

  if (/ing$/.test(token)) {
    const base = token.slice(0, -3);

    add(base);
    add(`${base}e`); // caching -> cach, cache
  }

  if (/ed$/.test(token)) {
    const base = token.slice(0, -2);

    add(base);
    add(`${base}e`); // traced -> trac, trace
  }

  if (/(?:tion|sion)$/.test(token)) {
    const base = token.slice(0, -4);

    add(base);
    add(`${base}e`); // validation -> valida, validate
    add(`${base}t`); // -> validat, so it meets validated's own stem
  }

  const list = [...forms];

  formsMemo.set(token, list);

  return list;
}

/** Literal tokens plus every inflection of each — the set matching runs on. */
function matchTerms(s: string): string[] {
  const out = new Set<string>();

  for (const t of tokenize(s)) {
    for (const f of formsOf(t)) out.add(f);
  }

  return [...out];
}

/**
 * The title split at identifier boundaries: `MigrateDownOptions.generateOnly` ->
 * `migrate down options generate only`.
 *
 * Partial title matching used `title.includes(t)` with no boundary check, which
 * put six `@imqueue/pg-prisma` migration symbols in all six slots for "rate
 * limiting" — 'rate' is inside 'migrate' and 'generate' — while
 * `@imqueue/http-protect`, whose own one-liner is "Per-IP rate limiting and
 * banning", returned nothing. "rate limit per IP" was worse: 'ip' inside
 * 'descrIPtion'.
 *
 * A prefix match on a segment keeps the case the original code was written for
 * ('options' still starts with 'option') and kills both false positives. The
 * four-character floor is what stops two- and three-letter fragments matching
 * across the whole corpus.
 */
function titleSegments(title: string): string[] {
  return title
    .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 1);
}

const MIN_PARTIAL = 4;

/**
 * What a blog post's score is multiplied by (see the comment at the demotion).
 * 0.75 loses a near-tie to a doc page and wins a decisive one.
 */
const BLOG_WEIGHT = 0.75;

/**
 * What a match earns when one side of it is an inflection rather than the word
 * actually written, applied once per derived side.
 *
 * Expanding both the corpus and the query buys recall, and it costs precision if
 * a guessed form counts for as much as a real one: "redis cluster setup" lost
 * `ClusteredRedisQueue` from first place to three unrelated `redis` options,
 * because every page saying "clustered" now also votes for `cluster` and diluted
 * its weight. Discounting derived matches keeps the recall and gives the term
 * someone actually typed the louder vote.
 */
const INFLECTION_WEIGHT = 0.6;

function segmentPrefixHit(segments: string[], term: string): boolean {
  return term.length >= MIN_PARTIAL && segments.some((s) => s.startsWith(term));
}

/** 1 for a blog post, 0 for documentation. */
function isBlog(e: DocEntry): 0 | 1 {
  return e.section === "Articles" || e.url.includes("/blog/") ? 1 : 0;
}

/**
 * True when `e` belongs to `pkg` — the `package` filter of `search_docs`.
 *
 * Accepts `http-protect` or `@imqueue/http-protect`. Symbol sections carry the
 * package name; curated package indexes carry it in the URL, and they are the one
 * kind of prose page that belongs in a package-scoped answer.
 */
function inPackage(e: DocEntry, pkg: string): boolean {
  const short = pkg.trim().replace(/^@imqueue\//, "").toLowerCase();

  if (!short) return true;

  return (
    e.section.toLowerCase().includes(`@imqueue/${short}`)
    || e.url.toLowerCase().includes(`/api/${short}/`)
  );
}

type Weigh = (term: string) => number;

/**
 * One entry with everything the scorer needs precomputed.
 *
 * Cached against the identity of the two feed arrays (same as `weighCache`), so a
 * warm isolate serving many searches tokenizes the corpus once rather than once
 * per query.
 */
interface Prepared {
  e: DocEntry;
  /** Literal title tokens — used for the "query names the whole title" bonus. */
  titleLiteral: string[];
  /**
   * Whole-strength title vocabulary: the title's own tokens AND its identifier
   * segments, each with inflections.
   *
   * A segment is a word boundary, so a term equal to one is as strong a hit as a
   * whole token — `ClusteredRedisQueue` is a single token, and treating `redis`
   * inside it as a mere fragment is what let `PgCacheOptions.redis` (where the dot
   * makes `redis` a token) outrank the class the query was about.
   */
  strong: Set<string>;
  /** The literal half of `strong`, for telling a real match from a guessed one. */
  strongLiteral: Set<string>;
  segments: string[];
  sectionTerms: Set<string>;
  summaryTerms: Set<string>;
  /** section + description + url, lowercased: the loose haystack for prose. */
  hay: string;
  blog: 0 | 1;
}

let weighCache: {
  curated: DocEntry[];
  symbols: DocEntry[];
  weigh: Weigh;
  df: Map<string, number>;
  prepared: Prepared[];
} | null = null;

/**
 * Weight a term by how rare it is across the corpus (normalised IDF, 0..1).
 *
 * Every page here is about @imqueue services, so `imqueue`, `service` and
 * `queue` occur in a large share of titles while saying nothing about which page
 * answers the question. Paying them the same as the one term that discriminates
 * is what broke natural-language queries: "how do I expose a method on an
 * @imqueue service?" scored three "X vs @imqueue" comparison articles above the
 * `expose` reference, because each matched `imqueue` AND `service` in its title
 * for +5 apiece while `expose` earned +5 once. Long conversational questions —
 * i.e. everything a chat user types — hit that every time, and a client that
 * gets three off-topic essays concludes this server cannot answer and falls back
 * to a web search.
 *
 * The df map is derived from the two cached feeds and cached against their
 * identity, so it is rebuilt only when a feed is refetched.
 */
function corpus(curated: DocEntry[], symbols: DocEntry[]) {
  if (weighCache && weighCache.curated === curated && weighCache.symbols === symbols) {
    return weighCache;
  }

  const df = new Map<string, number>();
  const all = [...curated, ...symbols];
  const prepared: Prepared[] = all.map((e) => {
    const titleLiteral = tokenize(e.title);
    const segments = titleSegments(e.title);
    const strongLiteral = new Set([...titleLiteral, ...segments]);
    const strong = new Set<string>();

    for (const t of strongLiteral) {
      for (const f of formsOf(t)) strong.add(f);
    }

    return {
      e,
      titleLiteral,
      strong,
      strongLiteral,
      segments,
      sectionTerms: new Set(matchTerms(e.section)),
      summaryTerms: new Set(matchTerms(e.description)),
      hay: `${e.section} ${e.description} ${e.url}`.toLowerCase(),
      blog: isBlog(e),
    };
  });

  // Document frequency over the SAME expanded forms the scorer matches on, so an
  // inflection gets its real rarity. Counting only literals would leave every
  // stem absent from the map and therefore weighted as the rarest thing in the
  // corpus — the inverse of what it is.
  for (const p of prepared) {
    const seen = new Set<string>([...p.strong, ...p.sectionTerms, ...p.summaryTerms]);

    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }

  const n = all.length || 1;
  const norm = Math.log(n + 1);
  const memo = new Map<string, number>();

  const weigh: Weigh = (term) => {
    let w = memo.get(term);

    if (w === undefined) {
      // Floored rather than zeroed: a query made only of ubiquitous words must
      // still rank something instead of returning nothing at all.
      w = Math.max(0.05, Math.log((n + 1) / ((df.get(term) || 0) + 1)) / norm);
      memo.set(term, w);
    }

    return w;
  };

  weighCache = { curated, symbols, weigh, df, prepared };

  return weighCache;
}

/**
 * Rank doc entries by overlap of query terms with title (weighted), section,
 * description and url. Every term's contribution is scaled by `weigher()`, so a
 * rare, specific term outweighs one the whole corpus shares.
 *
 * Curated pages match on all of those. API symbol pages match on the symbol name
 * only: 350 symbols share so much vocabulary with each other and with the guides
 * ("method", "options", "queue", "message") that scoring their sections and
 * summaries freely would bury every conceptual answer under near-identical
 * symbol hits. A summary term only refines a symbol that already matched by name.
 */
export async function searchDocs(query: string, limit = 6, pkg?: string): Promise<DocEntry[]> {
  const [curated, symbols] = await Promise.all([loadIndex(), loadApiIndex()]);

  return rankEntries(curated, symbols, query, limit, pkg);
}

/**
 * The ranker, separated from the fetching so it can be tested on a fixed corpus.
 *
 * Every defect this function has had was a ranking defect, and none of them were
 * catchable while the only way to run it was against the live site: the corpus
 * moves, so an assertion about what comes back either encodes today's content or
 * nothing at all. See test/ranking.test.ts.
 */
export function rankEntries(
  curated: DocEntry[],
  symbols: DocEntry[],
  query: string,
  limit = 6,
  pkg?: string,
): DocEntry[] {
  const terms = matchTerms(query);

  if (!terms.length) return curated.slice(0, limit);

  // A question wants a page that explains; an identifier wants the symbol. Both
  // shapes match the same words, so without this distinction "how do I handle
  // errors in a service?" ranks `IMQOptions.handleSignals` — a property page
  // that answers nothing — above the guides, which is what makes a client give
  // up on this server and go and search the web instead.
  const asksHow = /\b(how|what|which|why|when|where|can|should|do|does|is|are)\b/i.test(query);

  // Curated entries come first so that a tie between a guide and a symbol page
  // for the same URL keeps the guide's hand-written description (stable sort).
  const asked = new Set(terms);
  // The words actually typed, as opposed to the inflections derived from them.
  const literal = new Set(tokenize(query));
  const { weigh, prepared } = corpus(curated, symbols);
  const pool = pkg ? prepared.filter((p) => inPackage(p.e, pkg)) : prepared;
  const scored = pool.map((p) => {
    const { e } = p;

    let score = 0;
    let titleHit = false;
    let namedHit = false;
    let contextHit = false;
    let summaryOnly = false;

    // A match is discounted once for each side of it that is a guessed form
    // rather than a written word, so literal-to-literal always wins.
    const asWritten = (t: string) => (literal.has(t) ? 1 : INFLECTION_WEIGHT);

    for (const t of terms) {
      if (p.strong.has(t)) {
        // Whole-token or whole-segment hit: `send` in `RedisQueue.send`, `redis`
        // in `ClusteredRedisQueue`.
        score += 5 * weigh(t) * asWritten(t) * (p.strongLiteral.has(t) ? 1 : INFLECTION_WEIGHT);
        titleHit = true;
        namedHit = true;
      } else if (segmentPrefixHit(p.segments, t)) {
        score += 3 * weigh(t) * asWritten(t); // partial hit: `option` in `IMQOptions`
        titleHit = true;
      }
    }

    // The package a symbol belongs to lives in its section and was never scored,
    // so "opentelemetry" matched exactly one entry — the package index — while 26
    // opentelemetry symbols sat unmatched in the same feed, and "tracing" returned
    // six @imqueue/datadog results and no @imqueue/opentelemetry. That inverts the
    // project's own advice: datadog is only for a fleet already standing on
    // Datadog's agent, and installing both patches the same rpc hooks.
    for (const t of terms) {
      if (!p.strong.has(t) && p.sectionTerms.has(t)) {
        score += 2 * weigh(t) * asWritten(t);
        contextHit = true;
      }
    }

    if (e.symbol) {
      // Symbol summaries used to be scored ONLY as a tie-breaker on a name that
      // had already matched — `if (e.symbol && !titleHit) return 0` — which made
      // all 1,152 hand-written summaries unreachable on their own. "how do I stop
      // a service cleanly on SIGTERM" scored `IMQOptions.handleSignals`, whose
      // summary is literally "Enable process signal handling (SIGTERM, SIGINT,
      // SIGABRT)", at exactly zero.
      //
      // So a summary now scores by itself, at low weight and capped at one term:
      // enough to be findable, never enough to outrank the prose page written to
      // answer the question. Capped rather than accumulated because symbol
      // summaries repeat the same handful of words across a whole class.
      const hits = terms.filter((t) => p.summaryTerms.has(t));

      if (hits.length) {
        const best = Math.max(...hits.map((t) => weigh(t) * asWritten(t)));

        if (titleHit || contextHit) {
          score += best;
        } else {
          score += 0.8 * best;
          summaryOnly = true;
        }
      }

      if (!titleHit && !contextHit && !summaryOnly) {
        return { p, score: 0, summaryOnly };
      }
    } else {
      for (const t of terms) {
        if (p.hay.includes(t)) {
          score += weigh(t) * asWritten(t);
        }
      }
    }

    // A query naming a whole title — "ClusteredRedisQueue" — wants that page, not
    // its twenty members, every one of which also contains the class name.
    // Scaled by the most distinctive word in the title, so covering all of
    // `expose` earns far more than covering all of a title made of common words.
    //
    // Tested against the LITERAL title tokens, matched through their inflections:
    // testing the expanded set instead would lose the bonus for every title whose
    // words the query spelled differently.
    if (p.titleLiteral.length && p.titleLiteral.every((t) => formsOf(t).some((f) => asked.has(f)))) {
      score += 4 * Math.max(...p.titleLiteral.map(weigh));
    }

    // Two kinds of symbol page that cannot answer a "how do I …" question however
    // well the name matches: a single field or constructor of one class, and a
    // page matched only on a fragment of its name — `run` inside `runWithRequest`,
    // `handle` inside `handleSignals`. A symbol whose name a term hits whole,
    // like `expose`, is exactly the right answer and stays where it scored.
    if (asksHow && e.symbol && (!namedHit || /\b(property|variable|constructor)\b/.test(e.section))) {
      score *= 0.5;
    }

    // Documentation should lead whenever the docs cover the question: articles are
    // long-form and mention every term in the vocabulary, so on raw relevance they
    // beat the pages written to answer it — "how do I expose a method?" used to
    // come back as three "X vs @imqueue" comparison essays.
    //
    // This was a PRIMARY SORT KEY, which overcorrected: two pg-pubsub constants
    // that merely contain the words outranked the 2,000-word article about
    // graceful shutdown, and for "how do I stop a service cleanly on SIGTERM" the
    // article did not appear at all. A multiplier keeps the preference while
    // letting a decisively better article still lead — which is the page an answer
    // engine would actually cite.
    if (p.blog) score *= BLOG_WEIGHT;

    return { p, score, summaryOnly };
  });

  const hits = scored.filter((x) => x.score > 0);

  // Equal scores break toward prose: a symbol reached only through its summary is
  // by definition a weaker answer than a page that matched outright.
  const ranked = hits.sort(
    (a, b) => b.score - a.score || Number(a.summaryOnly) - Number(b.summaryOnly),
  );

  // A package index is listed both in llms.txt and in the symbol feed.
  const seen = new Set<string>();
  const out: DocEntry[] = [];

  // A class's members all carry its name, so they all score alike: without a cap,
  // "redis cluster setup" fills every slot with ClusteredRedisQueue methods and
  // pushes out the guide that actually answers it.
  const perParent = new Map<string, number>();
  // The same member name across DIFFERENT classes is the other way six
  // near-identical pages fill the answer, and the per-parent cap cannot see it:
  // "how do I stop a service cleanly on SIGTERM" returned IMQService.stop,
  // ClusteredRedisQueue.stop, IMessageQueue.stop, RedisQueue.stop,
  // AnyJobQueue.stop and BaseJobQueue.stop — six different parents, one answer
  // repeated, and no room left for the option that actually handles signals or the
  // article written about it.
  const perLeaf = new Map<string, number>();
  const maxPerName = Math.max(2, Math.ceil(limit / 3));

  for (const { p: { e } } of ranked) {
    if (seen.has(e.url)) continue;

    const dot = e.symbol ? e.title.lastIndexOf(".") : -1;
    const parent = dot > 0 ? e.title.slice(0, dot) : null;
    // A class's own page is never capped, by either rule — that is usually the
    // page worth reading first.
    const leaf = dot > 0 ? e.title.slice(dot + 1).toLowerCase() : null;

    if (parent && (perParent.get(parent) || 0) >= maxPerName) continue;
    if (leaf && (perLeaf.get(leaf) || 0) >= maxPerName) continue;

    if (parent) perParent.set(parent, (perParent.get(parent) || 0) + 1);
    if (leaf) perLeaf.set(leaf, (perLeaf.get(leaf) || 0) + 1);

    seen.add(e.url);
    out.push(e);

    if (out.length >= limit) break;
  }

  return out;
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
  const [curated, symbols] = await Promise.all([loadIndex(), loadApiIndex()]);
  const { df } = corpus(curated, symbols);

  const sections: string[] = [];

  for (const e of curated) {
    if (!sections.includes(e.section)) sections.push(e.section);
  }

  const asked = tokenize(query);
  const scoredTerms: { term: string; n: number }[] = [];
  // Five, not four: a four-character prefix offered `characters` and `charges` for
  // "helm chart", and a suggestion list full of coincidences is worse than none —
  // it invites another query that also returns nothing.
  const NEAR_PREFIX = 5;

  for (const [term, n] of df) {
    // "Nearest" means shares a real prefix with, or contains, something asked for
    // — enough to surface `authenticated` for "authentication" without pretending
    // to be a spell-checker.
    const near = asked.some(
      (t) =>
        (t.length >= NEAR_PREFIX && term.startsWith(t.slice(0, NEAR_PREFIX)))
        || (t.length >= MIN_PARTIAL && term.includes(t))
        || (term.length >= MIN_PARTIAL && t.includes(term)),
    );

    if (near && !asked.includes(term)) scoredTerms.push({ term, n });
  }

  // Commonest first: a term one page uses once is a worse suggestion than one the
  // corpus is organised around.
  const nearest = scoredTerms.sort((a, b) => b.n - a.n).slice(0, 8).map((x) => x.term);

  return { sections, nearest };
}

/** Resolve a page URL/path to its markdown-mirror URL (`<page-url>index.md`). */
export function mirrorUrl(pageUrl: string): string {
  const url = assertImqueueUrl(pageUrl);
  let p = url.pathname;
  if (p.endsWith("index.md")) return url.href;
  if (p.endsWith(".md")) return url.href;
  if (!p.endsWith("/")) p += "/";
  return `${SITE}${p}index.md`;
}

/** Fetch the full markdown of a doc page by its page URL or path. */
export async function getDoc(pageUrl: string): Promise<{ url: string; markdown: string }> {
  const mUrl = mirrorUrl(pageUrl);
  const res = await fetch(mUrl);
  if (!res.ok) throw new Error(`Failed to fetch ${mUrl} (HTTP ${res.status}). Use search_docs to find a valid page URL.`);
  return { url: mUrl, markdown: await res.text() };
}
