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
const origin = new URL(target).origin;

const ok = (c) => (c ? "✅" : "❌");
let failures = 0;
function check(label, cond, extra = "") {
  if (!cond) failures++;
  console.log(`${ok(cond)} ${label}${extra ? " — " + extra : ""}`);
}

async function rpc(method, params) {
  const res = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
  });

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

console.log(`Hosted MCP smoke: ${target}\n`);

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "remote-smoke", version: "0" },
  });
  check("initialize", init?.serverInfo?.name === "imqueue", `${init?.serverInfo?.name} ${init?.serverInfo?.version ?? ""}`);

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

  const noOpenWorld = tools.filter((t) => typeof t.annotations?.openWorldHint !== "boolean").map((t) => t.name);
  check("every hosted tool declares openWorldHint", noOpenWorld.length === 0, noOpenWorld.join(", "));

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
  check("get_doc refuses a non-imqueue.org URL", /imqueue\.org/i.test(refusedText), refusedText.slice(0, 90));

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

  console.log(failures ? `\n${failures} hosted check(s) FAILED` : "\nAll hosted checks passed");
} catch (e) {
  failures++;
  console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
  console.log(`\n${failures} hosted check(s) FAILED`);
}

process.exit(failures ? 1 : 0);
