// Types for the vendored search ranker (github.com/imqueue/search-ranker).
//
// STILL HAND-WRITTEN, and that is now a choice rather than a necessity. The ranker was
// rewritten in TypeScript and ships real declarations at dist/types/ranker/, generated from
// the same source that produces the bundle this file describes — strictly better types than
// these, and richer.
//
// They are not used, for two reasons that are about THIS package rather than about them.
// dist/ is build output and is gitignored in the submodule, so a checkout has no declarations
// until it has been built — and `tsc` here maps only src/ into dist/, so adopting them would
// mean copying a fourteen-file generated tree into a published package's source and keeping
// the published `files: ["dist"]` story straight. That is a build change, not a typing one.
//
// What the rewrite DID buy is upstream enforcement: the site's UI half now imports its types
// from the engine's own source, so a name that stops being exported fails to compile in that
// repo. This file is a second, coarser copy of a contract that is now checked at its origin.
//
// `allowJs` is off in this repo, so there is nothing to infer from the copied .cjs — this
// file is the contract, and it is only as true as whoever last edited the ranker made it.
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
  /**
   * Slot 3 of a section tuple: the section's plain text.
   *
   * Declared since the rewrite exported it — src/ranker.ts used to hard-code the 3. Required,
   * not optional: a pin old enough to lack it is old enough to predate the rewrite, and
   * scripts/copy-ranker.mjs refuses that pin by name before this declaration is ever consulted.
   */
  S_TEXT: number;
  /** The feed shape this ranker reads. Asserted against the feeds it is given. */
  FEED_V: number;
  /**
   * The ranking BEHAVIOUR of this engine, moved only when its answers move.
   *
   * Optional because a pin predating its introduction has no such export, and the
   * comparison degrades to "cannot tell" rather than to a crash. Everything else in
   * this file is required, and imqueue.com's check-search-ranker.ts asserts the
   * required list against the engine's real exports — TypeScript cannot catch a lie
   * in a hand-written .d.cts.
   */
  ENGINE_V?: number;
};

export = ranker;
