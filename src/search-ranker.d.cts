// Types for the vendored search ranker (github.com/imqueue/search-ranker).
//
// HAND-WRITTEN, and it has to be: the ranker is plain ES5-compatible JavaScript with
// no build step, because it is served straight to browsers and also runs in a
// Cloudflare Worker where `eval` is forbidden. `allowJs` is off in this repo, so
// there is nothing to infer from — this file is the contract, and it is only as true
// as whoever last edited the ranker made it.
//
// Two things keep it honest rather than aspirational:
//   * scripts/copy-ranker.mjs refuses a ranker that no longer exports itself under
//     Node, which is the failure this declaration cannot express; and
//   * `FEED_V` below is asserted against the live feeds, so a record shape that moved
//     is a loud error rather than a silently mis-scored search.
//
// Only what this server uses is declared. The ranker also owns an entire browser UI —
// dialog, results page, analytics — which it hides behind a `typeof document` check
// and which is unreachable from here.
//
// `export =`, not named exports: the file assigns `module.exports`, and the .cts
// extension is what tells Node it is CommonJS inside this `"type": "module"` package.

/** One index record: a page, an API symbol, or a question-shaped section. */
interface RankerRecord {
  /** Root-relative URL on ITS OWN edition's origin — never absolute. */
  u: string;
  /** Title, as rendered. */
  t: string;
  /** Summary. Empty string on a synthesised section hit. */
  s?: string;
  /** Package, on API symbols: "@imqueue/core". */
  p?: string;
  /**
   * Kind, and it is OVERLOADED by group: the TypeDoc kind on an API symbol
   * ("class", "method"), the page kind on a page, and on an answer record the
   * PARENT PAGE'S TITLE. Read it per group or not at all.
   */
  k?: string;
  /** Group: 0 page, 1 API symbol, 2 question-shaped answer. */
  g: 0 | 1 | 2;
  /** Deprecated symbol. */
  d?: boolean;
  /** Curated keywords. */
  w?: string;
  /** Parent page title — present only on a section hit's synthesised record. */
  _page?: string;
}

/**
 * A prose section, as a positional tuple. Slots 0–4 come from the feed, the rest are
 * precomputed when tier 2 loads.
 *
 * Positional because the whole corpus is downloaded on first search and object keys
 * would repeat 719 times. The consequence is that a slot appended mid-tuple does not
 * throw — it silently reads the wrong field — which is what `FEED_V` exists to catch.
 */
type RankerSection = unknown[];

/** A parsed query. Opaque here: only `search()` consumes it. */
interface RankerQuery {
  raw: string;
  terms: string[];
}

interface RankerHit {
  score: number;
  record: RankerRecord;
  /** Non-null when the hit is a heading-level section rather than a whole record. */
  section: RankerSection | null;
  /** True when the hit came from the OTHER edition's feeds (imqueue.com here). */
  external: boolean;
}

interface RankerIndex {
  v?: number;
  records: RankerRecord[];
}

interface RankerSectionIndex {
  v?: number;
  pages: unknown[];
  sections: RankerSection[];
  lemmas?: Record<string, string>;
  /**
   * Added by `prepareSections`: folded word -> how many sections contain it, over
   * 5,310 terms. Read by `suggest()`, which is the only reason it is declared: it is
   * the corpus's real vocabulary, which is exactly what a caller who matched nothing
   * needs and cannot guess.
   */
  df?: Record<string, number>;
  /** Added by `prepareSections`: the number of sections. */
  docs?: number;
}

/**
 * The ranker's mutable corpus. `t1`/`t2` are this edition's two tiers, `x1`/`x2` the
 * peer edition's. All four are null until assigned; a null peer degrades to
 * framework-only answers rather than failing.
 */
interface RankerState {
  t1: RankerIndex | null;
  t2: RankerSectionIndex | null;
  x1: RankerIndex | null;
  x2: RankerSectionIndex | null;
  [key: string]: unknown;
}

declare const ranker: {
  parseQuery(raw: string): RankerQuery;
  /** Annotates and returns the SAME object — it does not copy. */
  prepare(index: RankerIndex): RankerIndex;
  prepareSections(index: RankerSectionIndex): RankerSectionIndex;
  /** Every hit above the relative and absolute floors, best first. Not limited. */
  search(q: RankerQuery): RankerHit[];
  /** "answers" | "api" | "docs" — the group a hit renders under. */
  groupKey(hit: RankerHit): string;
  state: RankerState;
  /** The feed shape this ranker reads. Asserted against the feeds it is given. */
  FEED_V: number;
};

export = ranker;
