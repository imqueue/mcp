// Smoke test for the HOSTED @imqueue MCP server (worker/worker.ts).
//
// Usage:
//   node scripts/remote-smoke.mjs                        # https://mcp.imqueue.org/mcp
//   node scripts/remote-smoke.mjs http://localhost:8787/mcp   # against `npm run dev:worker`
//
// Why this exists separately from scripts/smoke.mjs: the hosted surface is a
// DIFFERENT and much stricter contract than the local one. It is what gets
// submitted to the OpenAI app directory and the Anthropic Connectors Directory,
// and both approve a specific tool list with specific annotations. The failure this
// guards against is a refactor months from now that registers a CLI tool in remote
// mode again — the endpoint would still work, so only an assertion catches it, and
// by then the listing says something false about what the server can do.
const target = process.argv[2] ?? "https://mcp.imqueue.org/mcp";
/**
 * Optional expected server version, passed by deploy-worker.mjs.
 *
 * Cloudflare rolls a new Worker out across colos, so for a short window two versions
 * answer the same hostname. Without this, being answered by a lagging isolate looks
 * like a contract failure: 3.2.1's deploy smoke reported three annotation failures
 * for a defect that was already fixed, because that one request landed on 3.2.0.
 * Naming the mismatch turns a mystery into a one-line diagnosis.
 */
const expectVersion = process.argv[3];
const origin = new URL(target).origin;

const ok = (c) => (c ? "✅" : "❌");
let failures = 0;
function check(label, cond, extra = "") {
  if (!cond) failures++;
  console.log(`${ok(cond)} ${label}${extra ? " — " + extra : ""}`);
}

// A hard ceiling on any single call, and the slowest one is asserted at the end.
// Without this a hung origin hangs the smoke run, i.e. the check meant to catch a
// hang becomes another thing that hangs.
const RPC_TIMEOUT_MS = 15000;
let slowest = { method: "none", ms: 0 };

async function rpc(method, params) {
  const started = Date.now();
  const res = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });

  const elapsed = Date.now() - started;

  if (elapsed > slowest.ms) {
    slowest = { method: params?.name ? `${method} ${params.name}` : method, ms: elapsed };
  }

  const body = await res.text();

  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} — ${body.slice(0, 200)}`);

  // Stateless mode answers with JSON, but tolerate an SSE-framed reply so this
  // keeps working if enableJsonResponse is ever turned off.
  const json = body.startsWith("event:") || body.startsWith("data:")
    ? JSON.parse(body.split("\n").find((l) => l.startsWith("data:")).slice(5))
    : JSON.parse(body);

  if (json.error) throw new Error(`${method}: ${json.error.message}`);

  return json.result;
}

/** Fetch with a hard deadline, so a hang FAILS instead of hanging the smoke run. */
async function timed(url, init = {}, ms = 5000) {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });

  return { res, ms: Date.now() - started };
}

/**
 * Set when any handshake in this run reported a version other than the expected one.
 *
 * This is the difference between "the contract is broken" and "I was answered by an
 * isolate that has not rolled over yet", and the two must not share an exit code:
 * the first should stop a release, the second should be retried. See the exit at the
 * bottom of the file.
 */
let sawStaleVersion = false;

/** The version the endpoint currently reports, or null if it could not be read. */
async function liveVersion() {
  try {
    const { res } = await timed(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "version-probe", version: "0" } },
      }),
    });
    const body = await res.text();
    const framed = body.match(/^data:\s*(.*)$/m);

    return JSON.parse(framed ? framed[1] : body)?.result?.serverInfo?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Wait for the endpoint to report the expected version before asserting anything.
 *
 * Every assertion here is about one version's contract, so starting while the
 * previous one is still answering produces failures that describe code nobody is
 * asking about. Polling from a single client cannot prove global propagation — the
 * requests mostly land on the same colo over a reused connection — so this is a
 * settling wait, not a proof. The retry logic in deploy-worker.mjs is what actually
 * covers being answered by a stale isolate later in the run.
 */
async function waitForExpectedVersion() {
  if (!expectVersion) return;

  const DEADLINE_MS = 60000;
  const started = Date.now();

  for (let attempt = 1; Date.now() - started < DEADLINE_MS; attempt++) {
    const live = await liveVersion();

    if (live === expectVersion) {
      if (attempt > 1) console.log(`ℹ️  settled on ${expectVersion} after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

      return;
    }

    sawStaleVersion = true;
    console.log(`ℹ️  waiting for ${expectVersion}, got ${live ?? "no answer"} (${attempt})`);
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(`ℹ️  gave up waiting for ${expectVersion} after ${DEADLINE_MS / 1000}s — asserting anyway\n`);
}

console.log(`Hosted MCP smoke: ${target}\n`);

try {
  // Before any assertion, make sure we are talking to the build under test.
  await waitForExpectedVersion();

  // METHOD HANDLING, first — because this is the check whose absence let a hang
  // reach production and stay there. remote-smoke asserted the tool list and the
  // annotations, i.e. everything except how the endpoint answers a request that
  // is not a tool call, and `GET /mcp` was returning 200 with an empty SSE stream:
  // a clean EOF to the SDK client, which then reconnects at ~1/s forever with
  // nothing visibly broken.
  for (const method of ["GET", "DELETE"]) {
    try {
      const { res, ms } = await timed(target, { method }, 2000);

      check(`${method} ${new URL(target).pathname} → 405`, res.status === 405, `${res.status} in ${ms}ms`);

      if (res.status === 405) {
        check(`${method} advertises Allow: POST`, (res.headers.get("allow") ?? "").includes("POST"), res.headers.get("allow") ?? "absent");
      }
    } catch (e) {
      // A timeout here IS the defect, so it must fail rather than abort the run.
      check(`${method} ${new URL(target).pathname} → 405`, false, e.name === "TimeoutError" ? "no answer within 2s — the hang is back" : String(e.message));
    }
  }

  // An SSE accept header is the exact request that returned an empty stream.
  try {
    const { res } = await timed(target, { method: "GET", headers: { accept: "text/event-stream" } }, 2000);

    check("GET with an SSE accept header → 405", res.status === 405, String(res.status));
  } catch (e) {
    check("GET with an SSE accept header → 405", false, e.name === "TimeoutError" ? "no answer within 2s" : String(e.message));
  }

  // HEAD on the root was gated out of the landing page and fell through to the MCP
  // handler — an RFC 9110 violation, and HEAD is what registry validators and
  // uptime probes send.
  {
    const { res } = await timed(origin, { method: "HEAD" }, 5000);

    check("HEAD / → 200", res.status === 200, String(res.status));
  }

  // A client that asks for JSON only must still be served: enableJsonResponse is
  // on, so there is no reason to require the SSE accept value, and a client that
  // gets 406 here concludes the server is broken.
  {
    const { res } = await timed(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "remote-smoke", version: "0" } },
      }),
    });

    check("POST with a JSON-only accept header is served", res.status === 200, String(res.status));
  }

  // An unlisted Origin must be refused — a protocol MUST, and a one-line scripted
  // check at directory review.
  {
    const { res } = await timed(target, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });

    check("an unlisted Origin is refused", res.status === 403, String(res.status));
  }

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "remote-smoke", version: "0" },
  });
  check("initialize", init?.serverInfo?.name === "imqueue", `${init?.serverInfo?.name} ${init?.serverInfo?.version ?? ""}`);

  // Before anything else is judged, establish WHICH build answered. Every assertion
  // below is about the contract of a specific version, so if this is the wrong one
  // the rest of the run is describing code nobody is asking about.
  if (expectVersion) {
    const live = init?.serverInfo?.version;

    if (live !== expectVersion) sawStaleVersion = true;

    check(
      `serving the expected version ${expectVersion}`,
      live === expectVersion,
      live === expectVersion
        ? live
        : `got ${live} — a colo is still rolling out, so any failure below may be stale`,
    );
  }

  // The only server-controlled text that reaches the host model's SYSTEM PROMPT.
  // It shipped absent for three releases and nothing noticed, because a server
  // with no instructions works perfectly — it just loses the argument with the
  // model's @imqueue priors. Assert presence AND the rules, so a rewrite that
  // turns it into a description of the server fails here.
  const instructions = init?.instructions ?? "";
  check("initialize returns instructions", instructions.length > 0, `${instructions.length} chars`);
  const missingRules = ["search_docs", "list_packages", "@expose()", "@classType()", "imq client generate"]
    .filter((r) => !instructions.includes(r));
  check("instructions carry the operating rules", missingRules.length === 0, missingRules.join(", "));
  check("serverInfo carries a display title", init?.serverInfo?.title === "@imqueue", init?.serverInfo?.title ?? "absent");

  const tools = (await rpc("tools/list"))?.tools ?? [];
  const names = tools.map((t) => t.name).sort();

  // EXACT list, not a superset. A superset assertion is what lets a local tool
  // leak back onto the hosted surface unnoticed.
  const expected = ["get_doc", "list_packages", "local_install_guide", "scaffold_client", "scaffold_service", "search_docs"];
  check("exactly the six hosted tools", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));

  // The whole point of the hosted surface: nothing on it can change anything.
  const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
  check("every hosted tool is readOnlyHint: true", notReadOnly.length === 0, notReadOnly.join(", "));

  const anyDestructive = tools.filter((t) => t.annotations?.destructiveHint !== false).map((t) => t.name);
  check("no hosted tool is destructive", anyDestructive.length === 0, anyDestructive.join(", "));

  const untitled = tools.filter((t) => !t.title && !t.annotations?.title).map((t) => t.name);
  check("every hosted tool has a title", untitled.length === 0, untitled.join(", "));

  // All FOUR hints the spec defines, each an explicit boolean. This asserted only
  // openWorldHint and was green while `idempotentHint` was absent from every tool —
  // the exact reason the OpenAI directory rejected v3.1.1. A hint a reviewer cannot
  // read makes no claim at all, which is indistinguishable from a wrong one.
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const badHints = tools
    .filter((t) => HINTS.some((h) => typeof t.annotations?.[h] !== "boolean"))
    .map((t) => `${t.name}(${HINTS.filter((h) => typeof t.annotations?.[h] !== "boolean").join(",")})`);
  check("every hosted tool sets all four hints to a boolean", badHints.length === 0, badHints.join(" "));

  // Every hosted tool is read-only, so every one of them is idempotent: no effect on
  // the environment means no ADDITIONAL effect on a second call.
  const notIdempotent = tools.filter((t) => t.annotations?.idempotentHint !== true).map((t) => t.name);
  check("every hosted tool is idempotentHint: true", notIdempotent.length === 0, notIdempotent.join(", "));

  // The names say "scaffold", which in most tooling means writing files. If the
  // description does not correct that immediately, readOnlyHint: true reads as a
  // mislabelling however true it is.
  const misleading = ["scaffold_service", "scaffold_client"]
    .filter((n) => !/^READ-ONLY/.test(tools.find((t) => t.name === n)?.description ?? ""));
  check("the scaffold tools lead with what they do not do", misleading.length === 0, misleading.join(", "));

  // All six promise structured output, which is what lets a client chain
  // search_docs -> get_doc on data rather than on parsed prose, and what clears the
  // "output schema recommended" hint in the directories.
  const noSchema = tools.filter((t) => !t.outputSchema).map((t) => t.name);
  check("every hosted tool declares an outputSchema", noSchema.length === 0, noSchema.join(", "));

  // get_doc's schema is metadata only. A body field here means the page is being
  // shipped twice — the one duplication that actually costs the caller context.
  const docProps = Object.keys(tools.find((t) => t.name === "get_doc")?.outputSchema?.properties ?? {});
  check(
    "get_doc schema carries metadata, never the page body",
    !docProps.some((k) => ["markdown", "content", "text", "body"].includes(k)),
    docProps.join(", "),
  );

  // A tool that cannot run has no business being listed — call each one and
  // require a usable answer, which is also what both directories test.
  const calls = [
    ["list_packages", {}, (t) => t.includes("@imqueue/rpc")],
    ["scaffold_service", { name: "user" }, (t) => t.includes("extends IMQService")],
    ["scaffold_client", { service: "user" }, (t) => t.includes("imq client generate")],
    ["local_install_guide", {}, (t) => t.includes("npx") && t.includes("@imqueue/mcp")],
    ["get_doc", { url: "https://imqueue.org/get-started/" }, (t) => t.includes("imqueue.org")],
    ["search_docs", { query: "delayed jobs", limit: 3 }, (t) => t.includes("imqueue.org")],
  ];

  for (const [name, args, assert] of calls) {
    const r = await rpc("tools/call", { name, arguments: args });
    const t = r?.content?.[0]?.text ?? "";
    check(`${name} returns a usable response`, !r?.isError && assert(t), t.split("\n")[0]?.slice(0, 80));
    // Declaring an outputSchema and then not returning structuredContent is worse
    // than declaring nothing: a client that trusts the schema gets undefined.
    check(`${name} returns structuredContent`, !!r?.structuredContent && typeof r.structuredContent === "object");
  }

  // The chain the schemas exist to make possible: take a URL out of search_docs'
  // structured results and feed it to get_doc, with no text parsing anywhere.
  const found = await rpc("tools/call", { name: "search_docs", arguments: { query: "expose a service method", limit: 3 } });
  const firstUrl = found?.structuredContent?.results?.[0]?.url;
  check("search_docs structured results carry a usable url", typeof firstUrl === "string" && firstUrl.startsWith("https://imqueue.org"), String(firstUrl));

  if (firstUrl) {
    const chained = await rpc("tools/call", { name: "get_doc", arguments: { url: firstUrl } });
    const md = chained?.content?.[0]?.text ?? "";
    const meta = chained?.structuredContent ?? {};
    check("get_doc consumes that url and returns the page", md.includes(firstUrl) && md.length > 0, `${md.length} chars`);
    // The page must appear exactly once across both fields.
    const structuredBytes = JSON.stringify(meta).length;
    check(
      "the page is not duplicated into structuredContent",
      structuredBytes < 400 && typeof meta.bytes === "number" && meta.bytes > 0,
      `metadata ${structuredBytes} B, reports bytes=${meta.bytes}`,
    );
  }

  // The hosted server answers chat clients, so the query shape that matters is a
  // whole spoken question, not keywords. ChatGPT drops this server's results and
  // web-searches instead when they look off-topic, so ranking is part of the
  // listed contract, not a nicety.
  const asked = await rpc("tools/call", {
    name: "search_docs",
    arguments: { query: "How do I expose a method on an @imqueue service?", limit: 5 },
  });
  const ranked = asked?.structuredContent?.results ?? [];
  check(
    "a question ranks the page that answers it first",
    /\/api\/rpc\/latest\/rpc\.expose\/|\/tutorial\//.test(ranked[0]?.url ?? ""),
    ranked[0]?.url ?? "no results",
  );
  const firstBlog = ranked.findIndex((r) => r.url.includes("/blog/"));
  const lastDoc = ranked.reduce((m, r, i) => (r.url.includes("/blog/") ? m : i), -1);
  check(
    "no blog post outranks a doc page",
    firstBlog === -1 || firstBlog > lastDoc,
    ranked.map((r) => r.url.replace("https://imqueue.org", "")).join(" | "),
  );

  // Invalid input must produce an actionable message rather than a bare stack or a
  // generic failure — a reviewer checks this explicitly.
  const refused = await rpc("tools/call", { name: "get_doc", arguments: { url: "https://example.com/" } });
  const refusedText = refused?.content?.[0]?.text ?? "";
  check("get_doc refuses a third-party URL", /imqueue\.org/i.test(refusedText), refusedText.slice(0, 90));

  // Both editions are readable, and the commercial one is the only place the
  // licensing question is answered.
  const commercial = await rpc("tools/call", { name: "search_docs", arguments: { query: "commercial license pricing", limit: 4 } });
  const comResults = commercial?.structuredContent?.results ?? [];
  check(
    "search_docs answers the commercial question",
    comResults.some((r) => r.url.includes("imqueue.com")),
    comResults.map((r) => r.url).join(" | ") || "no results",
  );

  const comDoc = await rpc("tools/call", { name: "get_doc", arguments: { url: "https://imqueue.com/pricing/" } });
  check(
    "get_doc reads an imqueue.com page instead of refusing it",
    !comDoc?.isError && (comDoc?.content?.[0]?.text ?? "").length > 100,
    (comDoc?.content?.[0]?.text ?? "").split("\n")[0]?.slice(0, 70),
  );

  // A URL that names a file must not have index.md appended to it.
  const feed = await rpc("tools/call", { name: "get_doc", arguments: { url: "https://imqueue.org/blog/feed.xml" } });
  check(
    "get_doc reads a URL that already names a file",
    !feed?.isError && (feed?.content?.[0]?.text ?? "").includes("<feed"),
    feed?.structuredContent?.url ?? "absent",
  );

  // The whole documentation set is a legitimate index entry at 574 kB; returning it
  // whole is a context flush rather than a read.
  const full = await rpc("tools/call", { name: "get_doc", arguments: { url: "https://imqueue.org/llms-full.txt" } });
  check(
    "an oversized page is truncated and says so",
    full?.structuredContent?.truncated === true && full.structuredContent.bytes < 400_000,
    `${full?.structuredContent?.bytes} B, truncated=${full?.structuredContent?.truncated}`,
  );

  // The client idiom, on the wire. A wrong one here propagates into public
  // repositories and back into training data.
  const client = await rpc("tools/call", { name: "scaffold_client", arguments: { service: "user" } });
  const cs = client?.structuredContent ?? {};
  check(
    "scaffold_client emits the namespace import that actually resolves",
    cs.namespace === "userService"
      && cs.generateCommand === "imq client generate UserService ./src/clients"
      && cs.output === "./src/clients/UserService.ts"
      && (cs.example?.content ?? "").includes("new userService.UserClient("),
    `${cs.generateCommand} -> ${cs.output}`,
  );

  // A complex type must arrive with the decorators it needs, or the generated client
  // types it `any` — which compiles.
  const svc = await rpc("tools/call", { name: "scaffold_service", arguments: { name: "user", methods: [{ name: "get", params: [{ name: "id", type: "string" }], returns: "User" }] } });
  const files = svc?.structuredContent?.files ?? [];
  check(
    "scaffold_service declares the complex types it names",
    JSON.stringify(svc?.structuredContent?.types) === JSON.stringify(["User"])
      && files.some((f) => f.path === "types.ts" && f.content.includes("@classType()")),
    (svc?.structuredContent?.types ?? []).join(", ") || "none",
  );

  // Domain verification. Both outcomes are legitimate: 404 until the portal issues a
  // token, then the token. What must never happen is a 200 carrying nothing useful —
  // the portal reads that as a WRONG token rather than an absent one, which is a
  // confusing failure to debug from the other side.
  const challengeUrl = `${origin}/.well-known/openai-apps-challenge`;
  const res = await fetch(challengeUrl);
  const body = (await res.text()).trim();

  if (res.status === 404) {
    console.log(`ℹ️  challenge route: 404 — OPENAI_APPS_CHALLENGE not set yet (expected until the portal issues a token)`);
    check("404 body does not leak a partial token", body === "Not found", body.slice(0, 60));
  } else {
    check("challenge route returns 200", res.status === 200, String(res.status));
    check("challenge token is non-empty", body.length > 0);
    check("challenge token is not the string 'undefined'", body !== "undefined");
    check("challenge is served as text/plain", (res.headers.get("content-type") ?? "").includes("text/plain"), res.headers.get("content-type") ?? "");
  }

  // An unknown well-known path must still 404, i.e. the route above is a specific
  // match and not a catch-all that would answer any probe.
  const other = await fetch(`${origin}/.well-known/something-else`);
  check("unrelated .well-known path still 404s", other.status === 404, String(other.status));

  // Measured warm: 0.49–0.54 s, and a fully cold isolate is bounded by ~1.7 s of
  // origin time. Five seconds means something has gone wrong upstream that a client
  // will feel long before anyone reads a dashboard.
  check(`no call took longer than 5s (slowest: ${slowest.method})`, slowest.ms <= 5000, `${slowest.ms}ms`);

  // Re-read the version at the END. A colo can roll over part-way through, so a run
  // that started on the right build can still be answered by the wrong one in the
  // middle — and that is the shape of the false failure this whole mechanism exists
  // to stop being mistaken for a broken contract.
  if (expectVersion) {
    const closing = await liveVersion();

    if (closing !== expectVersion) {
      sawStaleVersion = true;
      console.log(`ℹ️  endpoint reported ${closing} on a closing probe (expected ${expectVersion})`);
    }
  }

  console.log(failures ? `\n${failures} hosted check(s) FAILED` : "\nAll hosted checks passed");
} catch (e) {
  failures++;
  console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
  console.log(`\n${failures} hosted check(s) FAILED`);
}

// THREE outcomes, not two.
//
//   0 — everything passed.
//   2 — something failed AND a stale version answered at some point during the run.
//       That is very likely a rollout in progress rather than a broken contract, so
//       deploy-worker.mjs retries this instead of failing the release. A genuine
//       defect will still be there on the retry; a stale isolate will not.
//   1 — something failed while the endpoint consistently served the expected build.
//       Real. Stop.
//
// Conflating 2 with 1 is what turned two consecutive releases into false alarms; the
// contract was correct both times and the endpoint was answering from a version that
// no longer existed a few seconds later.
if (!failures) process.exit(0);

if (sawStaleVersion) {
  console.log(
    `\n⚠  ${failures} check(s) failed, and the endpoint served a version other than `
      + `${expectVersion} during this run. Treating as a rollout in progress (exit 2).`,
  );
  process.exit(2);
}

process.exit(1);
