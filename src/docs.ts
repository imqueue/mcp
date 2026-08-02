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

/** 1 for a blog post, 0 for documentation — the primary sort key in `searchDocs`. */
function isBlog(e: DocEntry): 0 | 1 {
  return e.section === "Articles" || e.url.includes("/blog/") ? 1 : 0;
}

type Weigh = (term: string) => number;

let weighCache: { curated: DocEntry[]; symbols: DocEntry[]; weigh: Weigh } | null = null;

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
function weigher(curated: DocEntry[], symbols: DocEntry[]): Weigh {
  if (weighCache && weighCache.curated === curated && weighCache.symbols === symbols) {
    return weighCache.weigh;
  }

  const df = new Map<string, number>();
  const all = [...curated, ...symbols];

  for (const e of all) {
    // tokenize() dedupes, so each entry votes once per term.
    for (const t of tokenize(`${e.title} ${e.section} ${e.description}`)) {
      df.set(t, (df.get(t) || 0) + 1);
    }
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

  weighCache = { curated, symbols, weigh };

  return weigh;
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
export async function searchDocs(query: string, limit = 6): Promise<DocEntry[]> {
  const [curated, symbols] = await Promise.all([loadIndex(), loadApiIndex()]);
  const terms = tokenize(query);

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
  const weigh = weigher(curated, symbols);
  const scored = [...curated, ...symbols].map((e) => {
    const titleTerms = new Set(tokenize(e.title));
    const title = e.title.toLowerCase();
    const hay = `${e.section} ${e.description} ${e.url}`.toLowerCase();
    const summary = e.description.toLowerCase();

    let score = 0;
    let titleHit = false;
    let namedHit = false;

    for (const t of terms) {
      if (titleTerms.has(t)) {
        score += 5 * weigh(t); // whole-token hit: `send` in `RedisQueue.send`
        titleHit = true;
        namedHit = true;
      } else if (title.includes(t)) {
        score += 3 * weigh(t); // partial hit: `option` in `IMQOptions`
        titleHit = true;
      }
    }

    // Scored in a second pass: whether a symbol earns its summary bonus must not
    // depend on the order the query's terms happen to arrive in.
    if (e.symbol && !titleHit) {
      return { e, score: 0 };
    }

    // A query naming a whole title — "ClusteredRedisQueue" — wants that page, not
    // its twenty members, every one of which also contains the class name.
    // Scaled by the most distinctive word in the title, so covering all of
    // `expose` earns far more than covering all of a title made of common words.
    if (titleTerms.size && [...titleTerms].every((t) => asked.has(t))) {
      score += 4 * Math.max(...[...titleTerms].map(weigh));
    }

    if (e.symbol) {
      // Capped, not accumulated: a summary hit confirms a symbol is relevant, but
      // symbol summaries repeat the same handful of words, and letting three of
      // them stack would outrank a guide written to answer the question.
      const hits = terms.filter((t) => summary.includes(t));

      if (hits.length) {
        score += Math.max(...hits.map(weigh));
      }
    } else {
      for (const t of terms) {
        if (hay.includes(t)) {
          score += weigh(t);
        }
      }
    }

    // Two kinds of symbol page that cannot answer a "how do I …" question however
    // well the name matches: a single field or constructor of one class, and a
    // page matched only on a fragment of its name — `run` inside `runWithRequest`,
    // `handle` inside `handleSignals`. A symbol whose name a term hits whole,
    // like `expose`, is exactly the right answer and stays where it scored.
    if (asksHow && e.symbol && (!namedHit || /\b(property|variable|constructor)\b/.test(e.section))) {
      score *= 0.5;
    }

    return { e, score };
  });

  const hits = scored.filter((x) => x.score > 0);

  // Documentation outranks the blog whenever the docs actually cover the question.
  // Relevance alone cannot decide this: the articles are long-form and mention
  // every term in the vocabulary, so they beat the guides and the API reference on
  // score even for questions those pages exist to answer — which is how "how do I
  // expose a method?" came back as three "X vs @imqueue" comparison essays.
  //
  // "Covered" has to be more than "something matched", or one incidental keyword
  // on an unrelated page would bury a post written about exactly this. So the docs
  // take precedence only while their best match is within reach of the best post's
  // score; when every doc page is a far weaker match than a post, the question is
  // not covered and ranking falls back to relevance, letting the post lead.
  const best = (blog: 0 | 1) =>
    hits.reduce((m, x) => (isBlog(x.e) === blog && x.score > m ? x.score : m), 0);
  const COVERED = 0.5;
  const docsCover = best(0) >= COVERED * best(1);

  const ranked = hits.sort((a, b) =>
    (docsCover ? isBlog(a.e) - isBlog(b.e) : 0) || b.score - a.score,
  );

  // A package index is listed both in llms.txt and in the symbol feed.
  const seen = new Set<string>();
  const out: DocEntry[] = [];

  // A class's members all carry its name, so they all score alike: without a cap,
  // "redis cluster setup" fills every slot with ClusteredRedisQueue methods and
  // pushes out the guide that actually answers it. The class's own page is never
  // capped — that is usually the page worth reading first.
  const perParent = new Map<string, number>();
  const maxPerParent = Math.max(2, Math.ceil(limit / 3));

  for (const { e } of ranked) {
    if (seen.has(e.url)) continue;

    const dot = e.symbol ? e.title.lastIndexOf(".") : -1;
    const parent = dot > 0 ? e.title.slice(0, dot) : null;

    if (parent) {
      const taken = perParent.get(parent) || 0;

      if (taken >= maxPerParent) continue;

      perParent.set(parent, taken + 1);
    }

    seen.add(e.url);
    out.push(e);

    if (out.length >= limit) break;
  }

  return out;
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
