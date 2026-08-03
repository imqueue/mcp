// GA4 telemetry for the hosted MCP server.
//
// WHY: there is no measurement of this server at all. The only numbers that exist
// are 26 lifetime Smithery calls and Cloudflare's request count, neither of which
// says which tool was called, by which client, or whether the answer was any good.
// The one question the whole GEO programme is scored on — is an agent reaching for
// these docs instead of its priors — is unanswerable without it.
//
// WHERE IT GOES: the imqueue.org GA4 property, the same one the site's edge reports
// into, which by design carries every audience separated by `kind` rather than
// split across properties. So these events reuse the dimensions already registered
// there (`kind`, `surface`, `crawler`, `operator`, `status`, `visit_id`) and add
// four of their own — `tool`, `client_name`, `query`, `results` — which must be
// registered as event-scoped custom dimensions in GA4 before they are reportable.
// Until then the data is collected and invisible, which is worth knowing but is not
// a reason to delay collecting it.
//
// PRIVACY: `query` is text a person typed. It is sent ONLY when the search returned
// nothing, truncated to 100 characters — that is the corpus-gap signal, the one
// thing no other source can provide, and the smallest collection that delivers it.
// A query that found what it wanted needs no recording. imqueue.com/privacy should
// name this before the server is deployed with the secret set.
//
// FAILURE MODE: none. With no secret configured this is a no-op, so the code ships
// dormant and turning it on is `wrangler secret put`. A measurement failure must
// never become a tool failure, so everything runs inside ctx.waitUntil and every
// error is swallowed.

/** The half-hour wall-clock bucket both sides use as a session. */
const HALF_HOUR_MS = 1_800_000;

/** GA4 rejects nothing and reports nothing for an over-long parameter value. */
const MAX_QUERY_CHARS = 100;

export interface AnalyticsEnv {
  /** e.g. G-XXXXXXXX. Absent = telemetry off. */
  GA4_MP_MEASUREMENT_ID?: string;
  /** Measurement Protocol API secret. Absent = telemetry off. */
  GA4_MP_API_SECRET?: string;
  /** Set to any value to POST to GA4's debug endpoint and log its verdict. */
  GA4_MP_DEBUG?: string;
}

/** The subset of Cloudflare's ExecutionContext this module needs. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** What one JSON-RPC request/response pair is worth recording. */
export interface CallFacts {
  /** JSON-RPC method, e.g. "tools/call" or "initialize". */
  method: string;
  /** Tool name, for tools/call. */
  tool?: string;
  /** Client's self-reported name, which only `initialize` carries. */
  clientName?: string;
  /** search_docs' own query, kept only when it matched nothing. */
  query?: string;
  /** Result count where the tool reports one. */
  results?: number;
  /** "ok" or "error" — a tool result with isError counts as error. */
  status: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-|-$/g, "") || "unknown";

/**
 * Read the facts out of a request/response pair without disturbing either.
 *
 * Both bodies are already strings by the time this is called: the worker buffers
 * the request so the transport can be handed an identical copy, and the response
 * because `enableJsonResponse` makes it one complete JSON document anyway.
 */
export function readCall(requestBody: string, responseBody: string): CallFacts | null {
  let req: {
    method?: string;
    params?: { name?: string; arguments?: { query?: unknown }; clientInfo?: { name?: unknown } };
  };

  try {
    req = JSON.parse(requestBody);
  } catch {
    // A malformed body is the transport's problem to report, not an event.
    return null;
  }

  if (!req || typeof req.method !== "string") return null;

  const facts: CallFacts = { method: req.method, status: "ok" };

  if (typeof req.params?.clientInfo?.name === "string") {
    facts.clientName = req.params.clientInfo.name;
  }

  if (req.method === "tools/call" && typeof req.params?.name === "string") {
    facts.tool = req.params.name;
  }

  let res: {
    error?: unknown;
    result?: { isError?: boolean; structuredContent?: { count?: unknown; results?: unknown[] } };
  };

  try {
    // Tolerate an SSE-framed reply, in case enableJsonResponse is ever turned off.
    const framed = responseBody.match(/^data:\s*(.*)$/m);

    res = JSON.parse(framed ? framed[1] : responseBody);
  } catch {
    facts.status = "unparseable";

    return facts;
  }

  if (res?.error || res?.result?.isError) facts.status = "error";

  const structured = res?.result?.structuredContent;

  if (typeof structured?.count === "number") {
    facts.results = structured.count;
  } else if (Array.isArray(structured?.results)) {
    facts.results = structured.results.length;
  }

  // Only a query that found nothing. See the PRIVACY note at the top.
  if (facts.tool === "search_docs" && facts.results === 0 && typeof req.params?.arguments?.query === "string") {
    facts.query = req.params.arguments.query.slice(0, MAX_QUERY_CHARS);
  }

  return facts;
}

/** Build the Measurement Protocol payload for one call. */
export function buildEvent(facts: CallFacts, userAgent: string, now: number, version: string) {
  // Stateless server, no cookies, nothing to correlate on but the client's own
  // name — so the id is a stable label for a CLIENT FAMILY, not a person. Two
  // Claude Code users are one client_id here, and that is the honest reading of
  // what this server can actually see.
  const client = slug(facts.clientName || userAgent.split("/")[0] || "unnamed-client");

  return {
    client_id: `mcp.${client}`,
    // Server-side hit for a request nobody consented to be measured for in a
    // browser; GA4 needs this to be explicit.
    non_personalized_ads: true,
    events: [
      {
        // NOT page_view, and not the site's srv_page_view either: three distinct
        // names so no report can add up two populations by accident.
        name: facts.method === "initialize" ? "mcp_connect" : "mcp_tool_call",
        params: {
          // GA4 needs both of these or the event lands with no session and every
          // engagement metric reads zero.
          session_id: `${client}-${Math.floor(now / HALF_HOUR_MS)}`,
          engagement_time_msec: 1,
          // Registered dimensions, reused so this is reportable alongside the site.
          kind: "assistant.mcp",
          surface: "mcp",
          crawler: client,
          operator: "MCP client",
          status: facts.status,
          visit_id: `${client}-${Math.floor(now / HALF_HOUR_MS)}`,
          // New dimensions — register these four in GA4 or they are collected and
          // unreportable.
          tool: facts.tool ?? facts.method,
          client_name: facts.clientName ?? "unnamed",
          ...(facts.query === undefined ? {} : { query: facts.query }),
          ...(facts.results === undefined ? {} : { results: String(facts.results) }),
          server_version: version,
        },
      },
    ],
  };
}

/**
 * Send one event, fire-and-forget. Silent no-op when unconfigured.
 *
 * The api_secret travels in the query string because that is the only form the
 * Measurement Protocol accepts — no header auth, no body field. Server-to-server
 * over TLS, write-only to one property, revocable in GA4. The one way it can leak
 * is our own logs, so this URL is never logged and a fetch error is never
 * interpolated verbatim: the message can echo the URL.
 */
export function report(
  env: AnalyticsEnv,
  ctx: WaitUntil | undefined,
  facts: CallFacts | null,
  userAgent: string,
  now: number,
  version: string,
): void {
  const id = env?.GA4_MP_MEASUREMENT_ID;
  const secret = env?.GA4_MP_API_SECRET;

  if (!facts || !id || !secret || !ctx) return;

  const debug = Boolean(env.GA4_MP_DEBUG);
  const endpoint = debug
    ? "https://www.google-analytics.com/debug/mp/collect"
    : "https://www.google-analytics.com/mp/collect";

  const sent = fetch(
    `${endpoint}?measurement_id=${encodeURIComponent(id)}&api_secret=${encodeURIComponent(secret)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEvent(facts, userAgent, now, version)),
    },
  );

  ctx.waitUntil(
    debug
      // The normal endpoint answers 2xx for a malformed hit and drops it, so the
      // only way to know the payload is right is to ask. An empty
      // validationMessages array means the hit is good.
      ? sent
        .then((res) => res.text())
        .then((text) => console.log(`[mcp-analytics] ${facts.tool ?? facts.method} → ${text}`))
        .catch(() => undefined)
      : sent.then(() => undefined).catch(() => undefined),
  );
}
