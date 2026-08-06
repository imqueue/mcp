// Minimal MCP stdio smoke test: spawn the built server, do the JSON-RPC
// handshake, list tools, then call search_docs and scaffold_service.
// Usage: node scripts/smoke.mjs
//
// This covers the LOCAL surface only. The hosted one is a different tool list and
// has its own check — scripts/remote-smoke.mjs.
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/index.js"], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const waiters = new Map(); // id -> resolve
proc.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});

function send(obj) { proc.stdin.write(JSON.stringify(obj) + "\n"); }
function rpc(id, method, params) {
  return new Promise((resolve) => { waiters.set(id, resolve); send({ jsonrpc: "2.0", id, method, params }); });
}

const ok = (c) => (c ? "✅" : "❌");
let failures = 0;
function check(label, cond, extra = "") { if (!cond) failures++; console.log(`${ok(cond)} ${label}${extra ? " — " + extra : ""}`); }

try {
  const init = await rpc(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  check("initialize", init.result?.serverInfo?.name === "imqueue", init.result?.serverInfo?.name);

  // Instructions reach the host model's system prompt, and a server without them
  // still works — which is why their absence went unnoticed for three releases.
  const instructions = init.result?.instructions ?? "";
  check("initialize returns instructions", instructions.length > 0, `${instructions.length} chars`);
  check("serverInfo carries a display title", init.result?.serverInfo?.title === "@imqueue", init.result?.serverInfo?.title ?? "absent");

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc(2, "tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name).sort();
  const expected = ["cli_help", "cli_install", "cli_status", "config", "create_service", "fleet", "generate_client", "get_doc", "list_packages", "logs", "scaffold_client", "scaffold_service", "search_docs"];
  check("tools/list", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));

  // local_install_guide exists only on the hosted server: locally the CLI tools it
  // points at are already here, so advertising it would be noise.
  check("local_install_guide is remote-only", !names.includes("local_install_guide"));

  // Annotations are a directory-submission requirement (both OpenAI's app directory
  // and the Anthropic Connectors Directory) and clients use readOnlyHint to decide
  // what may run without prompting. A tool registered without them is a silent
  // regression: it works, so nothing else catches it.
  const noTitle = tools.filter((t) => !t.title && !t.annotations?.title).map((t) => t.name);
  check("every tool has a title", noTitle.length === 0, noTitle.join(", "));

  // FOUR, not three. This list was missing `idempotentHint`, so the hint was absent
  // from all thirteen tools and this check was green — which is precisely what the
  // OpenAI directory rejected v3.1.1 for: "confirm annotations are explicitly set to
  // true or false (not null) for every tool".
  const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const badHints = tools
    .filter((t) => HINTS.some((h) => typeof t.annotations?.[h] !== "boolean"))
    .map((t) => `${t.name}(${HINTS.filter((h) => typeof t.annotations?.[h] !== "boolean").join(",")})`);
  check("every tool has all four behaviour hints as booleans", badHints.length === 0, badHints.join(" "));

  // The hints must match what the tool does. Spot-check the ones whose value is a
  // judgement call rather than a default, so a careless edit that flips them fails
  // here instead of at review.
  const hint = (name, h) => tools.find((t) => t.name === name)?.annotations?.[h];
  const readOnly = ["search_docs", "get_doc", "list_packages", "scaffold_service", "scaffold_client", "cli_status", "cli_help"];
  const notReadOnly = ["create_service", "generate_client", "cli_install", "fleet", "config", "logs"];
  const wrongRead = [
    ...readOnly.filter((n) => hint(n, "readOnlyHint") !== true),
    ...notReadOnly.filter((n) => hint(n, "readOnlyHint") !== false),
  ];
  check("readOnlyHint matches behaviour", wrongRead.length === 0, wrongRead.join(", "));

  // Mixed-action tools must own their worst case: one destructive action makes the
  // whole tool destructive.
  const destructive = ["cli_install", "fleet", "config", "logs"];
  const wrongDestructive = destructive.filter((n) => hint(n, "destructiveHint") !== true);
  check("destructive tools declare destructiveHint", wrongDestructive.length === 0, wrongDestructive.join(", "));

  // The live-docs tools read a site that changes between calls; the scaffolders and
  // the catalogue compute from the build and must not claim otherwise.
  const openWorld = ["search_docs", "get_doc"];
  const closedWorld = ["list_packages", "scaffold_service", "scaffold_client"];
  const wrongOpen = [
    ...openWorld.filter((n) => hint(n, "openWorldHint") !== true),
    ...closedWorld.filter((n) => hint(n, "openWorldHint") !== false),
  ];
  check("openWorldHint matches behaviour", wrongOpen.length === 0, wrongOpen.join(", "));

  // Every shared tool declares an outputSchema so clients can consume results as
  // data. The CLI-backed tools deliberately do not: they return `imq` stdout,
  // which has no shape worth promising.
  const WITH_SCHEMA = ["search_docs", "get_doc", "list_packages", "scaffold_service", "scaffold_client"];
  const missingSchema = WITH_SCHEMA.filter((n) => !tools.find((t) => t.name === n)?.outputSchema);
  check("shared tools declare an outputSchema", missingSchema.length === 0, missingSchema.join(", "));

  // get_doc's schema is METADATA ONLY. If a `markdown`/`content`/`text` field ever
  // appears in it, the page is being sent twice again — 33 kB to read one page.
  const docSchemaProps = Object.keys(tools.find((t) => t.name === "get_doc")?.outputSchema?.properties ?? {});
  const bodyFields = docSchemaProps.filter((k) => ["markdown", "content", "text", "body"].includes(k));
  check(
    "get_doc schema carries metadata, never the page body",
    bodyFields.length === 0 && docSchemaProps.includes("url"),
    docSchemaProps.join(", "),
  );

  const CLI_TOOLS = ["cli_status", "cli_help", "cli_install", "create_service", "generate_client", "fleet", "config", "logs"];
  const unexpectedSchema = CLI_TOOLS.filter((n) => tools.find((t) => t.name === n)?.outputSchema);
  check("CLI tools stay unstructured", unexpectedSchema.length === 0, unexpectedSchema.join(", "));

  const svc = await rpc(3, "tools/call", { name: "scaffold_service", arguments: { name: "user", methods: [{ name: "getUser", description: "Fetch a user by id", params: [{ name: "id", type: "number" }], returns: "User" }] } });
  const svcText = svc.result?.content?.[0]?.text ?? "";
  check("scaffold_service (offline)", svcText.includes("class UserService extends IMQService") && svcText.includes("@expose()"));

  // A tool with an outputSchema MUST return structuredContent, and it has to say
  // the same thing the prose does — the whole point of rendering the markdown from
  // the structure is that the two cannot drift.
  const svcData = svc.result?.structuredContent;
  // Three files, because `returns: "User"` is a complex type: the class, the
  // @classType()/@property() declarations it needs, and the bootstrap. Emitting a
  // signature that names an undeclared type was the original defect — it did not
  // compile, and once the caller declared `User` themselves the generated client
  // typed it `any`, which does.
  check(
    "scaffold_service returns structuredContent",
    svcData?.service === "UserService" && Array.isArray(svcData?.files) && svcData.files.length === 3,
    svcData ? `service=${svcData.service} files=${svcData.files?.length}` : "absent",
  );
  const svcFile = svcData?.files?.find((f) => f.path === "UserService.ts");
  check(
    "structured files carry paths and real content",
    !!svcFile && svcFile.content.includes("@expose()") && svcData.files.some((f) => f.path === "index.ts"),
    svcData?.files?.map((f) => f.path).join(", "),
  );
  const typesFile = svcData?.files?.find((f) => f.path === "types.ts");
  check(
    "a complex return type comes with its @classType() declaration",
    !!typesFile
      && typesFile.content.includes("@classType()")
      && typesFile.content.includes("export class User")
      && svcFile?.content.includes("import { User } from './types.js';")
      && JSON.stringify(svcData?.types) === JSON.stringify(["User"]),
    svcData?.types?.join(", ") ?? "types absent",
  );
  check(
    "text and structure agree",
    !!svcFile && svcText.includes(svcFile.content) && svcText.includes(svcData.cliAlternative),
  );

  // The client idiom, end to end. All three of these were wrong at once — the
  // command addressed a queue nobody serves, the output path was named after the
  // client instead of the service, and the example imported a symbol the
  // generated module does not export.
  const cl = await rpc(10, "tools/call", { name: "scaffold_client", arguments: { service: "user" } });
  const clData = cl.result?.structuredContent;
  const clText = cl.result?.content?.[0]?.text ?? "";
  check(
    "scaffold_client generates against the service class, into the service file",
    clData?.generateCommand === "imq client generate UserService ./src/clients"
      && clData?.output === "./src/clients/UserService.ts"
      && clData?.client === "UserClient"
      && clData?.namespace === "userService",
    `${clData?.generateCommand} -> ${clData?.output}`,
  );
  check(
    "scaffold_client's example uses the namespace the generated file exports",
    clData?.example?.content?.includes("import { userService } from './src/clients/UserService.js';")
      && clData?.example?.content?.includes("new userService.UserClient(")
      && !/import\s*\{\s*UserClient\s*\}/.test(clText),
    clData?.example?.content?.split("\n")[0] ?? "absent",
  );

  const pkgs = await rpc(4, "tools/call", { name: "list_packages", arguments: {} });
  const pkgText = pkgs.result?.content?.[0]?.text ?? "";
  check("list_packages (offline)", pkgText.includes("@imqueue/rpc"));

  const pkgData = pkgs.result?.structuredContent;
  check(
    "list_packages returns structuredContent",
    Array.isArray(pkgData?.packages) && pkgData.packages.length > 10 && pkgData.packages.every((p) => p.name && p.install && p.summary),
    `${pkgData?.packages?.length ?? 0} package(s)`,
  );

  // Renamed packages, asserted both ways. The catalog is compiled into the
  // tarball and into the Worker bundle, so a stale entry here is what an agent
  // acts on — it would install a deprecated package and get a working build,
  // which is invisible until someone notices the version never moves. The
  // negative assertions are the ones that matter: a half-applied rename that
  // fixed `name` and left `install` alone would otherwise ship green.
  const renamed = [["@imqueue/opentelemetry", "@imqueue/opentelemetry-instrumentation-imqueue"], ["@imqueue/pg-sequelize", "@imqueue/sequelize"], ["@imqueue/datadog", "@imqueue/dd-trace"]];
  for (const [current, retired] of renamed) {
    check(`list_packages offers ${ current }`, pkgText.includes(`npm i ${ current }`));
    check(`list_packages does not offer ${ retired }`, !pkgText.includes(`npm i ${ retired }`));
  }

  // cli_status must degrade gracefully whether or not `imq` is installed.
  const cli = await rpc(6, "tools/call", { name: "cli_status", arguments: {} });
  const ct = cli.result?.content?.[0]?.text ?? "";
  check("cli_status (graceful)", ct.includes("imq is available") || ct.includes("was not found"), ct.split("\n")[0]);

  // Network-dependent — treat failure as a warning, not a hard fail.
  try {
    const search = await rpc(5, "tools/call", { name: "search_docs", arguments: { query: "delayed jobs", limit: 3 } });
    const t = search.result?.content?.[0]?.text ?? "";
    console.log(`${t.includes("imqueue.org") ? "✅" : "⚠️ "} search_docs (live docs) ${t.includes("imqueue.org") ? "" : "— no network / docs unreachable"}`);
  } catch { console.log("⚠️  search_docs skipped (no network)"); }

  // Symbol lookup needs /api/search-index.json, which only exists once the site
  // has deployed it — a miss is a warning, so this stays useful offline too.
  try {
    const sym = await rpc(7, "tools/call", { name: "search_docs", arguments: { query: "RedisQueue.send", limit: 3 } });
    const t = sym.result?.content?.[0]?.text ?? "";
    const hit = t.includes("/api/core/latest/core.redisqueue.send/");
    console.log(`${hit ? "✅" : "⚠️ "} search_docs (API symbols)${hit ? "" : " — /api/search-index.json not reachable"}`);
  } catch { console.log("⚠️  search_docs (API symbols) skipped (no network)"); }

  // Ranking, for a natural-language question — the shape a chat user actually
  // types. Two ways this used to fail, both invisible without an assertion: term
  // weighting that pays `imqueue` and `service` (in nearly every title, so worth
  // nothing) the same as `expose`, and long blog posts outscoring the pages
  // written to answer the question. A client that gets three comparison essays
  // concludes this server cannot help and falls back to a web search.
  try {
    const q = "How do I expose a method on an @imqueue service?";
    const nl = await rpc(9, "tools/call", { name: "search_docs", arguments: { query: q, limit: 5 } });
    const results = nl.result?.structuredContent?.results ?? [];

    if (!results.length) {
      console.log("⚠️  search_docs (question ranking) skipped (no network)");
    } else {
      check(
        "a question ranks the page that answers it first",
        /\/api\/rpc\/latest\/rpc\.expose\/|\/tutorial\//.test(results[0].url),
        results[0].url,
      );
      // Docs before blog whenever the docs cover the question. Not "no blog posts":
      // a post may still appear, only never above a doc page that matched.
      const firstBlog = results.findIndex((r) => r.url.includes("/blog/"));
      const lastDoc = results.reduce((m, r, i) => (r.url.includes("/blog/") ? m : i), -1);
      check(
        "no blog post outranks a doc page",
        firstBlog === -1 || firstBlog > lastDoc,
        results.map((r) => r.url.replace("https://imqueue.org", "")).join(" | "),
      );
    }
  } catch { console.log("⚠️  search_docs (question ranking) skipped (no network)"); }

  // Three ranking rules that only a live corpus exercises. The unit tests pin the
  // rules on a fixed corpus (test/ranking.test.ts); these confirm they still hold
  // against the real 1,500-entry index, where term weights are what decide.
  try {
    const res = async (args) =>
      (await rpc(11, "tools/call", { name: "search_docs", arguments: args }))
        ?.result?.structuredContent?.results ?? [];

    // A symbol whose NAME says nothing about the query, found through its
    // hand-written summary. This scored exactly zero before.
    const sig = await res({ query: "SIGABRT", limit: 5 });
    if (!sig.length) {
      console.log("⚠️  search_docs (summary-only match) skipped (no network)");
    } else {
      check(
        "a symbol is findable by its summary alone",
        sig.some((r) => r.url.includes("handlesignals")),
        sig.map((r) => r.url.replace("https://imqueue.org", "")).join(" | "),
      );
    }

    // One member name repeated across six classes used to fill every slot.
    const stops = await res({ query: "how do I stop a service cleanly on SIGTERM", limit: 6 });
    check(
      "one member name does not fill the answer",
      stops.filter((r) => /\.stop\/$/.test(r.url)).length <= 2,
      stops.map((r) => r.url.replace("https://imqueue.org", "")).join(" | "),
    );

    // The package filter, which is the reliable way to ask about one of a
    // mutually exclusive pair.
    const scoped = await res({ query: "tracing", limit: 5, package: "opentelemetry" });
    check(
      "the package filter returns only that package",
      scoped.length > 0 && scoped.every((r) => r.url.includes("/opentelemetry/")),
      scoped.map((r) => r.url.replace("https://imqueue.org", "")).join(" | "),
    );
  } catch { console.log("⚠️  search_docs (live ranking rules) skipped (no network)"); }

  // get_doc must reach the markdown mirror of a generated API page.
  try {
    const doc = await rpc(8, "tools/call", { name: "get_doc", arguments: { url: "https://imqueue.org/api/core/latest/core.redisqueue.send/" } });
    const t = doc.result?.content?.[0]?.text ?? "";
    const hit = t.includes("RedisQueue.send") && t.includes("**Signature:**");
    console.log(`${hit ? "✅" : "⚠️ "} get_doc (API reference)${hit ? "" : " — API markdown mirror unreachable"}`);
  } catch { console.log("⚠️  get_doc (API reference) skipped (no network)"); }

  // A #fragment must return that section and nothing else. /api/ is 42 kB with 20 indexed
  // anchors, and search_docs returns those anchors — so before slicing, following its own
  // best result cost forty kilobytes to read four. Asserted against the LIVE feed because
  // that is where the line ranges come from: a generator change shifting them by one line
  // would still pass every unit test in this repo, whose ranges are fixtures.
  try {
    // Ids 12+ : `waiters` is keyed by id and a repeat silently overwrites the earlier
    // resolver, so reusing 9-11 here worked only because every call is awaited in order.
    const part = await rpc(12, "tools/call", { name: "get_doc", arguments: { url: "https://imqueue.org/api/#service-and-client" } });
    const whole = await rpc(13, "tools/call", { name: "get_doc", arguments: { url: "https://imqueue.org/api/" } });
    const t = part.result?.content?.[0]?.text ?? "";
    const partBytes = part.result?.structuredContent?.bytes ?? 0;
    const wholeBytes = whole.result?.structuredContent?.bytes ?? 0;

    check(
      "a #fragment returns one section, with its heading path",
      // The chain, the position notice, the section's own heading, and a real reduction —
      // each of which has its own way of silently not happening.
      t.includes("Section: API Reference › RPC API › Service and Client")
        && /This is section \d+ of \d+ on the page/.test(t)
        && t.includes("### Service and Client")
        && partBytes > 0 && wholeBytes > partBytes * 4,
      `section ${partBytes} B vs whole page ${wholeBytes} B`,
    );

    // An anchor that is not indexed must SAY so. Widening it to the whole page in silence
    // teaches an agent to keep citing a fragment that does not exist.
    const miss = await rpc(14, "tools/call", { name: "get_doc", arguments: { url: "https://imqueue.org/api/#no-such-heading" } });
    const missText = miss.result?.content?.[0]?.text ?? "";

    check(
      "an unindexed fragment is reported, not silently widened",
      missText.includes("#no-such-heading is not an indexed section")
        && missText.includes("Indexed sections:"),
      missText.split("\n").slice(1, 3).join(" / "),
    );
  } catch { console.log("⚠️  get_doc (fragment slicing) skipped (no network)"); }

  console.log(failures ? `\n${failures} offline check(s) FAILED` : "\nAll offline checks passed");
} finally {
  proc.kill();
  process.exit(failures ? 1 : 0);
}
