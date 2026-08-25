// contract.mjs — the properties BOTH smoke scripts assert, defined once.
//
// scripts/smoke.mjs drives the local build over stdio; scripts/remote-smoke.mjs
// drives the deployed Worker over HTTPS. Testing both is right — a local pass does
// not prove the deployment agrees — but the handful of properties that are the SAME
// property against two targets used to be copied into both files, and "keep them in
// step" was a convention enforced by memory.
//
// It failed exactly as you would expect, twice, before this module existed:
//
//   * `no blog post outranks a doc page` was removed from smoke.mjs and left in
//     remote-smoke.mjs. The local gate went green, npm publish proceeded, and the
//     HOSTED gate failed after the package was already on the registry.
//   * `get_doc schema carries the page body, not just metadata` silently drifted
//     into two different assertions under one label — smoke.mjs required `markdown`
//     AND `url`, remote-smoke.mjs required only `markdown`. Unified here on the
//     stricter form, which is the one the label claims.
//
// Each function takes the ALREADY-UNWRAPPED payload plus the caller's own `check`.
// That is deliberate: the two transports genuinely differ (one has a JSON-RPC
// envelope, the other is pre-unwrapped, and one has an id argument the other does
// not), and abstracting them would buy nothing while hiding a real difference. What
// must not differ is the assertion, and that is what lives here.
//
// A property that belongs to only one target — CORS, 405s and the challenge route
// on the hosted side, the CLI tools and offline scaffolding on the local side —
// stays in its own script. This module is for what both must agree on.

/** The query both scripts use to check question ranking. */
export const QUESTION = "How do I expose a method on an @imqueue service?";

// /api/faq/ accepted since 2026-08-06, when imqueue.org grew a page whose headings
// ARE these questions — this one is answered by
// /api/faq/#how-do-i-expose-a-service-method-so-it-can-be-called-remotely, verbatim.
// It took first place from rpc.expose/ and that is the page doing its job, not a
// regression.
const ANSWERS_IT = /\/api\/rpc\/latest\/rpc\.expose\/|\/tutorial\/|\/api\/faq\//;

/**
 * The handshake: who the server says it is, and the text that reaches the host
 * model's system prompt.
 *
 * `init` is the unwrapped initialize result — `init.result` on a raw JSON-RPC
 * reply, the reply itself where the caller already unwrapped it.
 */
export function assertHandshake(init, check) {
  check("initialize", init?.serverInfo?.name === "imqueue", init?.serverInfo?.name);

  // Instructions reach the host model's SYSTEM PROMPT, and a server without them
  // still works — which is why their absence went unnoticed for three releases. It
  // just loses the argument with the model's @imqueue priors.
  const instructions = init?.instructions ?? "";

  check("initialize returns instructions", instructions.length > 0, `${instructions.length} chars`);
  check(
    "serverInfo carries a display title",
    init?.serverInfo?.title === "@imqueue",
    init?.serverInfo?.title ?? "absent",
  );

  return instructions;
}

/**
 * get_doc's schema MUST carry the page body. Without it a client that renders
 * structuredContent when present — which the spec entitles it to do, `content`
 * being framed as the backwards-compatible mirror — gets a URL and a byte count and
 * no page, and cannot tell that it read nothing.
 *
 * Both halves are required. remote-smoke.mjs asserted only `markdown` under this
 * same label until 2026-08-25; a schema carrying the body with no way to say which
 * page it came from is not what the label promises.
 */
export function assertGetDocSchema(tools, check) {
  const props = Object.keys(
    tools.find((t) => t.name === "get_doc")?.outputSchema?.properties ?? {},
  );

  check(
    "get_doc schema carries the page body, not just metadata",
    props.includes("markdown") && props.includes("url"),
    props.join(", "),
  );
}

/**
 * Ranking for a natural-language question — the shape a chat user actually types.
 * Catches term weighting that pays `imqueue` and `service` (in nearly every title,
 * so worth nothing) the same as `expose`.
 *
 * `results` is structuredContent.results from a search_docs call for QUESTION.
 */
export function assertQuestionRanking(results, check) {
  check(
    "a question ranks the page that answers it first",
    ANSWERS_IT.test(results?.[0]?.url ?? ""),
    results?.[0]?.url ?? "no results",
  );
}
