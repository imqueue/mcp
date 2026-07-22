// Bridge to the installed @imqueue/cli (`imq`). The MCP server runs locally, so
// when the developer has `imq` on PATH we can drive the real CLI instead of only
// emitting templates.
//
// Safety posture:
//   * stdin is closed and every call is time-boxed, so an interactive prompt
//     (a missing flag) fails fast instead of hanging the server.
//   * `imq service create` runs with --dry-run UNLESS the caller explicitly opts
//     in (apply: true) — an agent must not create repos / push to remotes silently.
import { execFile, type ExecFileException } from "node:child_process";

export interface CliResult {
  ok: boolean;
  code: number | null;
  output: string; // combined stdout+stderr, trimmed
}

const NOT_FOUND =
  "The `imq` CLI was not found on PATH. Install it with `npm i -g @imqueue/cli`, " +
  "or use scaffold_service/scaffold_client for offline code templates.";

/** Run any binary with args. Never rejects — returns a structured result. */
function exec(
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; notFound?: string } = {},
): Promise<CliResult> {
  const { cwd, timeoutMs = 60_000, notFound = `\`${file}\` was not found on PATH.` } = opts;
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd: cwd || process.cwd(), timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (ExecFileException & { killed?: boolean }) | null;
        if (e && e.code === "ENOENT") {
          resolve({ ok: false, code: null, output: notFound });
          return;
        }
        const out = `${stdout || ""}${stderr || ""}`.trim();
        if (e && e.killed) {
          resolve({ ok: false, code: null, output: `${file} timed out after ${timeoutMs}ms. If it was waiting for input, pass the required flags/values (see cli_help) instead.\n\n${out}` });
          return;
        }
        const code = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        resolve({ ok: !e, code, output: out || "(no output)" });
      },
    );
  });
}

/** Run `imq` with args in cwd. Never rejects — returns a structured result. */
export function runImq(args: string[], cwd?: string, timeoutMs = 60_000): Promise<CliResult> {
  return exec("imq", args, { cwd, timeoutMs, notFound: NOT_FOUND });
}

/** Install @imqueue/cli globally via npm. */
export async function installCli(version = "latest"): Promise<string> {
  const spec = `@imqueue/cli@${version}`;
  const r = await exec("npm", ["install", "-g", spec], {
    timeoutMs: 180_000,
    notFound: "npm was not found on PATH.",
  });
  if (r.ok) {
    return `Installed ${spec} globally. Run cli_status to confirm, then use create_service / generate_client / fleet / config.\n\n${r.output}`;
  }
  return `Failed to install ${spec} (npm exit ${r.code}). A global install may need a user-writable npm prefix (e.g. via nvm) or elevated permissions.\n\n${r.output}`;
}

/** Control the local services fleet: `imq ctl <start|stop|restart|status>`. */
export async function fleet(opts: {
  action: "start" | "stop" | "restart" | "status";
  path?: string;
  services?: string;
  update?: boolean;
  calm?: boolean;
  verbose?: boolean;
  cwd?: string;
}): Promise<string> {
  const args = ["ctl", opts.action];
  if (opts.path) args.push("-p", opts.path);
  if (opts.services) args.push("-s", opts.services);
  if (opts.update) args.push("-u");
  if (opts.calm) args.push("-c");
  if (opts.verbose) args.push("-v");
  const timeoutMs = opts.action === "status" ? 30_000 : 120_000;
  const r = await runImq(args, opts.cwd, timeoutMs);
  return `\`imq ${args.join(" ")}\`\n\n${r.output}`;
}

/** Manage CLI configuration: `imq config <check|get|set|init>`. */
export async function config(opts: {
  action: "check" | "get" | "set" | "init";
  option?: string;
  value?: string;
  cwd?: string;
}): Promise<string> {
  const args = ["config", opts.action];
  if (opts.action === "get" && opts.option) args.push(opts.option);
  if (opts.action === "set") {
    if (!opts.option || opts.value === undefined) {
      return "config set requires both `option` and `value` (e.g. option='ci.provider', value='github-actions'). Nested keys use a dot-path.";
    }
    args.push(opts.option, opts.value);
  }
  const r = await runImq(args, opts.cwd, 30_000);
  return `\`imq ${args.join(" ")}\`\n\n${r.output}`;
}

const LOG_MAX = 20_000; // cap dumped log output so it can't flood the agent context

/** Read (dump) or clean fleet logs: `imq log`. Never follows (that would hang). */
export async function logs(opts: {
  action?: "dump" | "clean";
  services?: string;
  prefix?: boolean;
  cwd?: string;
}): Promise<string> {
  if ((opts.action ?? "dump") === "clean") {
    const r = await runImq(["log", "--clean"], opts.cwd, 30_000);
    return `\`imq log --clean\`\n\n${r.output}`;
  }
  const args = ["log"];
  if (opts.services) {
    args.push(...opts.services.split(",").map((s) => s.trim()).filter(Boolean));
  }
  args.push("--no-follow"); // always bounded — the streaming --follow default is unsafe here
  if (opts.prefix === false) args.push("--no-prefix");

  const r = await runImq(args, opts.cwd, 30_000);
  let out = r.output;
  let note = "";
  if (out.length > LOG_MAX) {
    out = out.slice(-LOG_MAX);
    note = ` (truncated to last ${LOG_MAX} chars)`;
  }
  return `\`imq ${args.join(" ")}\`${note}\n\n${out}`;
}

/** Detect the CLI and its version. */
export async function cliStatus(): Promise<string> {
  const r = await runImq(["--version"], undefined, 15_000);
  if (!r.ok) return r.output;
  return `imq is available (version ${r.output}).`;
}

/** Pass through `imq [command] --help` so the agent learns exact, current flags. */
export async function cliHelp(command?: string): Promise<string> {
  const args = command ? [...command.split(/\s+/), "--help"] : ["--help"];
  const r = await runImq(args, undefined, 15_000);
  return r.output;
}

/** Preview or (with apply) run `imq service create`. */
export async function createService(opts: {
  name: string;
  path?: string;
  flags?: string[];
  cwd?: string;
  apply?: boolean;
}): Promise<string> {
  const args = ["service", "create", opts.name];
  if (opts.path) args.push(opts.path);
  if (opts.flags?.length) args.push(...opts.flags);
  if (!opts.apply) args.push("--dry-run");

  const r = await runImq(args, opts.cwd, opts.apply ? 120_000 : 30_000);
  const header = opts.apply
    ? "Ran `imq service create` (apply mode — files were written):"
    : "Dry-run plan (nothing was written). Re-call with apply: true to create it for real:";
  return `${header}\n\n\`imq ${args.join(" ")}\`\n\n${r.output}`;
}

/** Generate the real typed client from a running service. */
export async function generateClient(service: string, path?: string, cwd?: string): Promise<string> {
  const args = ["client", "generate", service];
  if (path) args.push(path);
  const r = await runImq(args, cwd, 90_000);
  const note = r.ok
    ? "Generated the typed client."
    : "Client generation needs the target service to be RUNNING (it introspects the live service). Start the service, then retry.";
  return `${note}\n\n\`imq ${args.join(" ")}\`\n\n${r.output}`;
}
