// The search ranker, and the one place this server touches it.
//
// It is not implemented here. It is github.com/imqueue/search-ranker, pinned as a
// submodule and pinned by the imqueue.com repo too, so that this server and the
// website's own search box answer a query with the same code. Before the split they
// did not: on 3,657 agent-shaped queries the website's ranker put a correct result in
// the top 6 for 99.5% of them against this server's 83.9%, and no query at all was
// answered by the old ranker and not the new one. The gap was invisible because
// nothing compared them.
//
// NOTHING COMPARES THE PINS EITHER. This said "pinned to the same commit" as though
// it were checked; it is not, and the two drifted for a fortnight in August 2026
// without a single check going red. The consequence was nil that time — the extra
// commit was in search.js, which this server never copies — but the same silence
// would cover a scoring change, which is precisely the failure the split was
// supposed to end.
//
// THE IMPORT IS STATIC ON PURPOSE. A dynamic import would let a missing or
// unbundleable ranker turn into a runtime failure inside a tool call — and
// scripts/smoke.mjs tolerates network failures, so it would be reported as "the docs
// were unreachable" rather than "this build has no ranker". Static means the module
// graph is wrong at load: the smoke handshake fails, and so does the Worker bundle.
//
// It resolves in all three places from this one specifier because
// scripts/copy-ranker.mjs writes the file into both src/ and dist/ — see that script
// for why the extension is .cjs and why the copy is not avoidable.

import ranker from "./search-ranker.cjs";

/**
 * Slot 3 of a section tuple: the section's plain text.
 *
 * TAKEN FROM THE RANKER, not restated. This was a hand-written `3` with a comment saying
 * the ranker did not export its tuple offsets; the TypeScript rewrite exports them, so the
 * comment stopped being true and the number stopped being necessary in the same commit.
 *
 * The old note said the `3` was safe because slots 0–4 come from the FEED, so
 * `assertFeedVersion` below would shout if the offset moved. That is still true and it is
 * still the second line of defence — but a second copy of a constant is exactly the kind of
 * thing that agrees with its source right up until it does not, and this repo already has
 * one story about a value drifting between here and imqueue.com.
 */
const S_TEXT = ranker.S_TEXT;

// Derived from the ranker's own signatures rather than restated, so a declaration
// that changes cannot leave a second, stale copy of the same shape behind here.
export type Hit = Parameters<typeof ranker.groupKey>[0];
export type RankerRecord = Hit["record"];
export type RankerIndex = Parameters<typeof ranker.prepare>[0];
export type RankerSectionIndex = Parameters<typeof ranker.prepareSections>[0];

export { ranker };

/**
 * The feed shape this ranker reads. Compared against every feed it is handed.
 *
 * Records are positional arrays, so a field inserted mid-tuple throws nothing and
 * returns nothing empty — it scores the wrong text, at full confidence. This server
 * makes that worse than it is on the website: the ranker here is PINNED to a commit
 * while the feeds are fetched from the LIVE site, so the two can drift apart without
 * anybody deploying anything.
 */
export const FEED_V: number = ranker.FEED_V;

/**
 * What this engine ANSWERS, as opposed to what it reads.
 *
 * FEED_V has been 1 through every ranking change ever made to the ranker, which is
 * correct — no tuple moved — and is exactly why it cannot see the failure that
 * actually happens here. This server pins the engine by commit and fetches the feeds
 * live, so it can answer a query differently from imqueue.org's own search box with
 * FEED_V agreeing throughout. The two pins sat a fortnight apart in August 2026 and
 * nothing in either repo noticed.
 */
export const ENGINE_V: number | undefined = ranker.ENGINE_V;

/** Set when a feed was built by an engine other than this one. Read by the worker's telemetry. */
let stale = false;

/** Has any feed reported an engine other than ours since this process started? */
export function rankerIsStale(): boolean {
  return stale;
}

/**
 * Fail a feed whose shape this ranker does not read.
 *
 * Throwing beats scoring: a wrong answer that looks right is the failure mode this
 * whole file exists to avoid, and `searchDocs` already has a path for "the feeds are
 * unusable" that degrades to the curated index.
 *
 * A missing `v` is now a failure too. It used to be tolerated "once", for a site that
 * had not deployed the versioned feeds yet — both editions deployed them in 2026 and
 * the comment saying to remove the tolerance when FEED_V next moved was, predictably,
 * enforced by nobody. An unversioned feed today means something served us a file that
 * is not the feed we asked for.
 */
export function assertFeedVersion(name: string, feed: { v?: number; e?: number }): void {
  if (feed.v === undefined) {
    throw new Error(
      `${name} carries no feed version. Every feed imqueue.org publishes has declared \`v\` `
        + "since 2026; a file without one is not the feed this expects.",
    );
  }
  if (feed.v !== FEED_V) {
    throw new Error(
      `${name} is feed v${feed.v} but this ranker reads v${FEED_V}. `
        + "The pinned ranker (vendor/search-ranker) is out of step with the live site — "
        + "update the submodule.",
    );
  }

  // The engine check WARNS. It must never throw, and the asymmetry is the point:
  // a shape mismatch means the scores would be computed off the wrong field, while
  // an engine mismatch means they are computed correctly by an engine that ranks
  // slightly differently. Worse still, the site necessarily deploys before this
  // server does — it is one `git push`, whereas this takes an npm publish and a
  // Worker deploy — so throwing would turn every ranker release into an outage
  // window on the hosted endpoint.
  //
  // `e` absent means the site has not deployed the stamp yet, which is a real state
  // during exactly one deploy and is not worth a warning.
  if (feed.e !== undefined && ENGINE_V !== undefined && feed.e !== ENGINE_V) {
    if (!stale) {
      console.error(
        `[ranker] ${name} was built by engine v${feed.e}; this server runs v${ENGINE_V}. `
          + "Results can differ from imqueue.org's own search for the same query. "
          + "Repin vendor/search-ranker, publish, and redeploy the Worker.",
      );
    }
    stale = true;
  }
}

/** The plain text of a section hit, for a result's description. */
export function sectionText(hit: Hit): string {
  const text = hit.section?.[S_TEXT];

  return typeof text === "string" ? text : "";
}
