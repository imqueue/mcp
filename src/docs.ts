// Docs access for the @imqueue MCP server.
//
// The docs live on imqueue.org as machine-readable feeds:
//   * /llms.txt              — curated index: `## Section` + `- [Title](url): description`
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
}

let indexCache: { at: number; entries: DocEntry[] } | null = null;

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

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "for", "on", "with",
  "is", "are", "how", "do", "does", "i", "my", "me", "it", "that", "this",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9@/+.-]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Rank doc entries by overlap of query terms with title (weighted), section, description and url. */
export async function searchDocs(query: string, limit = 6): Promise<DocEntry[]> {
  const entries = await loadIndex();
  const terms = tokenize(query);
  if (!terms.length) return entries.slice(0, limit);

  const scored = entries.map((e) => {
    const title = e.title.toLowerCase();
    const hay = `${e.section} ${e.description} ${e.url}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (title.includes(t)) score += 3;
      if (hay.includes(t)) score += 1;
    }
    return { e, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
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
