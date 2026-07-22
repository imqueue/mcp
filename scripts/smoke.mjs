// Minimal MCP stdio smoke test: spawn the built server, do the JSON-RPC
// handshake, list tools, then call search_docs and scaffold_service.
// Usage: node scripts/smoke.mjs
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

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await rpc(2, "tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  const expected = ["cli_help", "cli_status", "create_service", "generate_client", "get_doc", "list_packages", "scaffold_client", "scaffold_service", "search_docs"];
  check("tools/list", JSON.stringify(names) === JSON.stringify(expected), names.join(", "));

  const svc = await rpc(3, "tools/call", { name: "scaffold_service", arguments: { name: "user", methods: [{ name: "getUser", description: "Fetch a user by id", params: [{ name: "id", type: "number" }], returns: "User" }] } });
  const svcText = svc.result?.content?.[0]?.text ?? "";
  check("scaffold_service (offline)", svcText.includes("class UserService extends IMQService") && svcText.includes("@expose()"));

  const pkgs = await rpc(4, "tools/call", { name: "list_packages", arguments: {} });
  check("list_packages (offline)", (pkgs.result?.content?.[0]?.text ?? "").includes("@imqueue/rpc"));

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

  console.log(failures ? `\n${failures} offline check(s) FAILED` : "\nAll offline checks passed");
} finally {
  proc.kill();
  process.exit(failures ? 1 : 0);
}
