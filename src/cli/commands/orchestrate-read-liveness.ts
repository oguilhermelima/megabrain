import { failed, ok, type Result } from "../../core/result.js";
import { classifyLiveness, type LivenessResult } from "../../core/liveness.js";
import { capTranscript, formatDispatchRead } from "../../core/dispatch-read.js";
import { resolveStateDirectory } from "../../core/state.js";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { readJson } from "./check.js";
import { dispatchFile, resolveDispatchDirectory, type DispatchHandle } from "../../adapters/dispatch-store.js";

type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;
const transcriptCap = 10485760;
const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
type ParentMeta = Readonly<{ handle: DispatchHandle; meta: RecordValue }>;

async function parentMeta(id: string, environment: Environment): Promise<Result<ParentMeta>> {
  const resolved = await resolveDispatchDirectory(resolveStateDirectory(environment), id);
  if (resolved.kind !== "ok") return resolved;
  const meta = await readJson(dispatchFile(resolved.value, "meta"));
  if (meta === undefined) return failed(`dispatch not found: ${id}`);
  const host = environment.MEGABRAIN_SESSION_HOST ?? (environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : environment.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : undefined);
  const session = environment.MEGABRAIN_SESSION_ID ?? environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE;
  if (host === undefined || session === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  if (meta.parentHost !== host || meta.parentSessionId !== session) return failed(`dispatch ${id} is owned by ${stringValue(meta.parentHost)}/${stringValue(meta.parentSessionId)}, not ${host}/${session}`);
  return ok({ handle: resolved.value, meta });
}

async function hostRead(meta: RecordValue, process: ProcessAdapter): Promise<Result<string>> {
  const host = stringValue(meta.childHost); const terminal = stringValue(meta.terminalId); const workspace = stringValue(meta.workspaceId);
  const command = host === "orca" ? "orca" : "megabrain_superset";
  const args = host === "orca" ? ["terminal", "read", "--terminal", terminal, "--json"] : ["terminals", "read", "--workspace", workspace, "--terminal", terminal, "--json"];
  const result = await process.run(command, args);
  if (result.kind !== "ok") return failed(`${host} terminal ${terminal} could not be read; host terminal output is unavailable`);
  try {
    const value: unknown = JSON.parse(result.value.stdout);
    if (typeof value === "string") return ok(value);
    if (typeof value === "object" && value !== null) { const root = value as RecordValue; const nested = root.result as RecordValue | undefined; return ok(stringValue(root.text) || stringValue(root.output) || stringValue(root.content) || stringValue(nested?.text) || stringValue(nested?.output) || JSON.stringify(value)); }
    return ok(String(value));
  } catch { return failed(`${host} terminal ${terminal} returned invalid read-back data; host terminal output is unavailable`); }
}

async function capture(pane: string, lines: number, process: ProcessAdapter): Promise<Result<string>> {
  const result = await process.run("tmux", ["capture-pane", "-p", "-t", pane, "-S", `-${lines}`]);
  return result.kind === "ok" ? ok(result.value.stdout.replace(/\n+$/, "")) : failed("capture failed");
}

async function terminalStatus(meta: RecordValue, process: ProcessAdapter): Promise<"proven" | "missing" | "unknown"> {
  const session = stringValue(meta.tmuxSession); const pane = stringValue(meta.tmuxPane); const id = stringValue(meta.dispatchId);
  if ((await process.run("tmux", ["has-session", "-t", session])).kind !== "ok") return "missing";
  const panes = await process.run("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"]);
  if (panes.kind !== "ok" || !panes.value.stdout.split("\n").includes(pane)) return "missing";
  const pid = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"]); if (pid.kind !== "ok") return "unknown";
  const tty = await process.run("ps", ["-p", pid.value.stdout.trim(), "-o", "tty="]); if (tty.kind !== "ok" || tty.value.stdout.trim() === "") return "unknown";
  const tree = await process.run("ps", ["eww", "-t", tty.value.stdout.trim(), "-o", "pid=,ppid=,command="]);
  return tree.kind === "ok" && tree.value.stdout.includes(`MEGABRAIN_DISPATCH_ID=${id}`) ? "proven" : "unknown";
}

export async function executeOrchestrateRead(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate read <dispatch-id> [--lines <count>] [--json]\n");
  const id = args[0] ?? ""; if (id === "") return failed("Usage: megabrain orchestrate read <dispatch-id> [--lines <count>] [--json]\n", 2);
  let lines = 200; let json = false;
  for (let index = 1; index < args.length; index += 1) { const arg = args[index]; if (arg === "--json") json = true; else if (arg === "--lines") lines = Number(args[++index]); else if (arg === "-h" || arg === "--help") return ok("Usage: megabrain orchestrate read <dispatch-id> [--lines <count>] [--json]\n"); else return failed(`unknown orchestrate read option: ${arg}`, 2); }
  if (!Number.isInteger(lines) || lines < 1) return failed("--lines must be a positive number", 2);
  const metaResult = await parentMeta(id, environment); if (metaResult.kind !== "ok") return metaResult; const { handle, meta } = metaResult.value; const runtime = stringValue(meta.runtime) || "host";
  let output = ""; let source: "tmux" | "file" | "host"; let truncated = false; let pane = "";
  if (runtime === "tmux") { pane = stringValue(meta.tmuxPane); const live = await capture(pane, lines, process); if (live.kind === "ok") { output = live.value; source = "tmux"; } else { const file = await Bun.file(dispatchFile(handle, "transcript")).text().catch(() => undefined); if (file === undefined) return failed(`could not read tmux pane ${pane} and no persisted transcript exists`); const capped = capTranscript(file, transcriptCap); output = capped.text; truncated = capped.truncated; source = "file"; } }
  else { const host = await hostRead(meta, process); if (host.kind !== "ok") return host; output = host.value; source = "host"; }
  return ok(formatDispatchRead({ dispatchId: id, pane, source, truncated, text: output }, json, transcriptCap));
}

export async function executeOrchestrateLiveness(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate liveness <dispatch-id> [--json]\n");
  const id = args[0] ?? ""; if (id === "") return failed("Usage: megabrain orchestrate liveness <dispatch-id> [--json]\n", 2); const json = args.slice(1).every((arg) => arg === "--json"); if (!json && args.length > 1) return failed(`unknown liveness option: ${args[1]}`, 2);
  const metaResult = await parentMeta(id, environment); if (metaResult.kind !== "ok") return metaResult; const { meta } = metaResult.value; let result: LivenessResult = { status: "unknown", reason: null }; let source = "unknown";
  if (stringValue(meta.runtime) === "tmux") { const status = await terminalStatus(meta, process); if (stringValue(meta.state) === "closed") result = { status: "missing", reason: "dispatch is closed" }; else if (status === "missing") result = { status: "missing", reason: "terminal is no longer available" }; else if (status === "unknown") result = { status: "unknown", reason: "terminal identity is unproven" }; else { const captured = await capture(stringValue(meta.tmuxPane), 200, process); if (captured.kind === "ok" && captured.value.length > 0) { source = "tmux"; result = classifyLiveness(stringValue(meta.agent), captured.value); } } }
  const value = { dispatchId: id, dispatchState: stringValue(meta.state) || "unknown", terminalLiveness: result.status, source, reason: result.reason };
  return ok(json ? `${JSON.stringify(value, null, 2)}\n` : `dispatch: ${id}\nstate: ${value.dispatchState}\nterminal liveness: ${result.status}\nsource: ${source}\n${result.reason === null ? "" : `reason: ${result.reason}\n`}`);
}
