// The search ranker, and the one place this server touches it.
//
// It is not implemented here. It is github.com/imqueue/search-ranker, pinned as a
// submodule and pinned to the same commit by the imqueue.com repo, so this server and
// the website's own search box answer a query with the same code. Before the split
// they did not: on 3,657 agent-shaped queries the website's ranker put a correct
// result in the top 6 for 99.5% of them against this server's 83.9%, and no query at
// all was answered by the old ranker and not the new one. The gap was invisible
// because nothing compared them.
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
 * A magic number, and it stays one deliberately rather than being imported: the
 * ranker does not export its tuple offsets (they are internals of a file whose other
 * consumer is a browser). What makes it safe is that slots 0–4 come from the FEED, so
 * this offset is part of the shape `FEED_V` versions — move it and
 * `assertFeedVersion` below is what shouts, in the same change.
 */
const S_TEXT = 3;

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
 * Fail a feed whose shape this ranker does not read.
 *
 * Throwing beats scoring: a wrong answer that looks right is the failure mode this
 * whole file exists to avoid, and `searchDocs` already has a path for "the feeds are
 * unusable" that degrades to the curated index.
 *
 * A feed with NO version is accepted, once: `v` was added to the feeds in the same
 * change that added it here, and refusing an unversioned feed would mean this server
 * could not read a site that had not deployed yet. That tolerance should be removed
 * when FEED_V next moves.
 */
export function assertFeedVersion(name: string, feed: { v?: number }): void {
  if (feed.v !== undefined && feed.v !== FEED_V) {
    throw new Error(
      `${name} is feed v${feed.v} but this ranker reads v${FEED_V}. `
        + "The pinned ranker (vendor/search-ranker) is out of step with the live site — "
        + "update the submodule.",
    );
  }
}

/** The plain text of a section hit, for a result's description. */
export function sectionText(hit: Hit): string {
  const text = hit.section?.[S_TEXT];

  return typeof text === "string" ? text : "";
}
