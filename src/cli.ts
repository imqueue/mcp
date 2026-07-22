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

/** Run `imq` with args in cwd. Never rejects — returns a structured result. */
export function runImq(args: string[], cwd?: string, timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      "imq",
      args,
      { cwd: cwd || process.cwd(), timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        const e = err as (ExecFileException & { killed?: boolean }) | null;
        if (e && e.code === "ENOENT") {
          resolve({ ok: false, code: null, output: NOT_FOUND });
          return;
        }
        const out = `${stdout || ""}${stderr || ""}`.trim();
        if (e && e.killed) {
          resolve({ ok: false, code: null, output: `imq timed out after ${timeoutMs}ms. If it was waiting for input, pass the missing flags (see cli_help) or use create_service without apply for a dry-run.\n\n${out}` });
          return;
        }
        const code = typeof e?.code === "number" ? e.code : e ? 1 : 0;
        resolve({ ok: !e, code, output: out || "(no output)" });
      },
    );
  });
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
