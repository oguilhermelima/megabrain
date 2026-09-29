import { readFile } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { classifyLiveness, type LivenessResult } from "../../core/liveness.js";
import { formatDispatchRead, renderTranscript } from "../../core/dispatch-read.js";
import { hasCallerIdentity, ownsDispatch } from "../../core/context.js";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { resolveCaller } from "./queue-write.js";
import { hostReadText, terminalStatus, type RecordValue } from "./orchestrate-terminal.js";
import { getHost } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, getDispatch, transcriptPath } from "../../adapters/state-db.js";

type Environment = Readonly<Record<string, string | undefined>>;
const defaultTranscriptCap = 10485760;
const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const transcriptCap = (environment: Environment): number => {
  const configured = Number(environment.MEGABRAIN_TRANSCRIPT_MAX_BYTES);
  return Number.isInteger(configured) && configured > 0 ? configured : defaultTranscriptCap;
};
type ParentMeta = Readonly<{ meta: RecordValue }>;

async function parentMeta(id: string, environment: Environment, process: ProcessAdapter): Promise<Result<ParentMeta>> {
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const stored = getDispatch(database.value, id);
  if (stored.kind !== "ok") return stored;
  const meta = stored.value;
  if (meta === undefined) return failed(`dispatch not found: ${id}`);
  const current = await resolveCaller(environment, process);
  if (!hasCallerIdentity(current)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = stringValue(meta.parentHost); const expectedId = stringValue(meta.parentSessionId);
  if (!ownsDispatch(current, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${id} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id || current.terminalId || ""}`);
  return ok({ meta });
}

async function hostRead(meta: RecordValue, process: ProcessAdapter): Promise<Result<string>> {
  const host = stringValue(meta.childHost); const terminal = stringValue(meta.terminalId); const workspace = stringValue(meta.workspaceId);
  const call = getHost(host)?.read({ workspaceId: workspace === "" ? null : workspace, terminalId: terminal });
  if (call === undefined || call.kind !== "ok") return failed(`${host} terminal ${terminal} could not be read; host terminal output is unavailable`);
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind !== "ok") return failed(`${host} terminal ${terminal} could not be read; host terminal output is unavailable`);
  try {
    const value: unknown = JSON.parse(result.value.stdout);
    return ok(hostReadText(value));
  } catch { return failed(`${host} terminal ${terminal} returned invalid read-back data; host terminal output is unavailable`); }
}

async function capture(pane: string, lines: number, process: ProcessAdapter): Promise<Result<string>> {
  const result = await getTmux().capturePane(pane, lines, process);
  return result.kind === "ok" ? ok(result.value.replace(/\n+$/, "")) : failed("capture failed");
}

export async function executeOrchestrateRead(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-read"));
  const id = args[0] ?? ""; if (id === "") return failed(usageText("orchestrate-read"), 2);
  let lines = 200; let json = false;
  for (let index = 1; index < args.length; index += 1) { const arg = args[index]; if (arg === "--json") json = true; else if (arg === "--lines") lines = Number(args[++index]); else if (arg === "-h" || arg === "--help") return ok(usageText("orchestrate-read")); else return failed(`unknown orchestrate read option: ${arg}`, 2); }
  if (!Number.isInteger(lines) || lines < 1) return failed("--lines must be a positive number", 2);
  const metaResult = await parentMeta(id, environment, process); if (metaResult.kind !== "ok") return metaResult; const { meta } = metaResult.value; const runtime = stringValue(meta.runtime) || "host";
  const cap = transcriptCap(environment);
  let output = ""; let source: "tmux" | "file" | "host"; let truncated = false; let pane = "";
  if (runtime === "tmux") { pane = stringValue(meta.tmuxPane); const live = await capture(pane, lines, process); if (live.kind === "ok") { output = live.value; source = "tmux"; } else { const path = transcriptPath(environment, id); const file = path.kind === "ok" ? await readFile(path.value, "utf8").catch(() => undefined) : undefined; if (file === undefined) return failed(`could not read tmux pane ${pane} and no persisted transcript exists`); const rendered = renderTranscript(file, cap); output = rendered.text; truncated = rendered.truncated; source = "file"; } }
  else { const host = await hostRead(meta, process); if (host.kind !== "ok") return host; output = host.value; source = "host"; }
  return ok(formatDispatchRead({ dispatchId: id, pane, source, truncated, text: output }, json, cap));
}

export async function executeOrchestrateLiveness(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-liveness"));
  const id = args[0] ?? ""; if (id === "") return failed(usageText("orchestrate-liveness"), 2); const json = args.slice(1).every((arg) => arg === "--json"); if (!json && args.length > 1) return failed(`unknown liveness option: ${args[1]}`, 2);
  const metaResult = await parentMeta(id, environment, process); if (metaResult.kind !== "ok") return metaResult; const { meta } = metaResult.value; let result: LivenessResult = { status: "unknown", reason: null }; let source = "unknown";
  if (stringValue(meta.runtime) === "tmux") { const status = await terminalStatus(meta, process); if (stringValue(meta.state) === "closed") result = { status: "missing", reason: "dispatch is closed" }; else if (status === "missing") result = { status: "missing", reason: "terminal is no longer available" }; else if (status === "unknown") result = { status: "unknown", reason: "terminal identity is unproven" }; else { const captured = await capture(stringValue(meta.tmuxPane), 200, process); if (captured.kind === "ok" && captured.value.length > 0) { source = "tmux"; result = classifyLiveness(stringValue(meta.agent), captured.value); } } }
  const value = { dispatchId: id, dispatchState: stringValue(meta.state) || "unknown", terminalLiveness: result.status, source, reason: result.reason };
  return ok(json ? `${JSON.stringify(value, null, 2)}\n` : `dispatch: ${id}\nstate: ${value.dispatchState}\nterminal liveness: ${result.status}\nsource: ${source}\n${result.reason === null ? "" : `reason: ${result.reason}\n`}`);
}
