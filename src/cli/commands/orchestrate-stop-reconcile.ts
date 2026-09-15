import { readdir } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { parseStopArgs, stopDecision, stopOutput } from "../../core/orchestrate-stop.js";
import { reconcileDecision } from "../../core/orchestrate-reconcile.js";
import { classifyLiveness } from "../../core/liveness.js";
import { resolveStateDirectory } from "../../core/state.js";
import { dispatchFile, dispatchPath, resolveDispatchDirectory } from "../../adapters/dispatch-store.js";
import { appendMessage, atomicJson, readJson, type QueueEnvironment } from "./queue-write.js";
import { type ProcessAdapter } from "../../adapters/proc.js";

type RecordValue = Record<string, unknown>;
const value = (input: unknown): string => typeof input === "string" ? input : "";
function normalize(meta: RecordValue): RecordValue {
  const state = value(meta.state) || "running";
  return {
    ...meta,
    processState: value(meta.processState) || (state === "closed" ? "stopped" : state === "done" ? "succeeded" : state === "failed" ? "failed" : state === "spawning" ? "starting" : "running"),
    terminalState: value(meta.terminalState) || "owned",
    terminalReason: meta.terminalReason ?? null,
    failureCount: typeof meta.failureCount === "number" ? meta.failureCount : 0,
    stage: meta.stage ?? null,
    reason: meta.reason ?? null,
    reconcileOutcome: meta.reconcileOutcome ?? null,
    modelSubstitution: meta.modelSubstitution ?? null,
    effort: meta.effort ?? null,
    promptPublication: meta.promptPublication ?? "unknown",
    promptTransport: meta.promptTransport ?? "unknown",
    promptReceipt: meta.promptReceipt ?? "unknown",
    promptState: meta.promptState ?? "legacy",
  };
}

async function parentMeta(root: string, dispatch: string, env: QueueEnvironment): Promise<Result<RecordValue>> {
  const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const host = env.MEGABRAIN_SESSION_HOST ?? (env.SUPERSET_TERMINAL_ID !== undefined ? "superset" : env.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : undefined);
  const id = env.MEGABRAIN_SESSION_ID ?? env.SUPERSET_TERMINAL_ID ?? env.ORCA_TERMINAL_HANDLE;
  if (host === undefined || id === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  if (meta.parentHost !== host || meta.parentSessionId !== id) return failed(`dispatch ${dispatch} is owned by ${value(meta.parentHost)}/${value(meta.parentSessionId)}, not ${host}/${id}`);
  return ok(meta);
}

async function tmuxLiveness(meta: RecordValue, process: ProcessAdapter): Promise<{ status: string; identity: "known" | "unknown" }> {
  const pane = value(meta.tmuxPane); const session = value(meta.tmuxSession);
  if ((await process.run("tmux", ["has-session", "-t", session])).kind !== "ok") return { status: "missing", identity: "unknown" };
  const capture = await process.run("tmux", ["capture-pane", "-p", "-t", pane, "-S", "-200"]);
  if (capture.kind !== "ok") return { status: "unknown", identity: "unknown" };
  return { status: classifyLiveness(value(meta.agent), capture.value.stdout).status, identity: "known" };
}

export async function executeOrchestrateStop(args: readonly string[], env: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate stop <dispatch-id> [--json]\n");
  const parsed = parseStopArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(env); const parent = await parentMeta(root, parsed.value.dispatchId, env); if (parent.kind !== "ok") return parent;
  const meta = parent.value; const runtime = value(meta.runtime) || "host"; let status = "unknown"; let affordance: "known" | "unknown" = "unknown"; let reason = "";
  if (runtime === "tmux") { const live = await tmuxLiveness(meta, process); status = live.status; affordance = value(meta.agent) === "codex" || value(meta.agent) === "claude" ? "known" : "unknown"; }
  else if (value(meta.childHost) === "orca") { affordance = "known"; status = "working"; }
  else { reason = value(meta.childHost) === "superset" ? "Superset terminals send offers no interrupt capability" : `interrupt capability is unavailable for host ${value(meta.childHost) || "unknown"}`; }
  const decision = stopDecision(status, affordance); if (decision.kind !== "ok") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: ${reason || decision.error}`);
  const session = env.MEGABRAIN_SESSION_ID ?? env.SUPERSET_TERMINAL_ID ?? env.ORCA_TERMINAL_HANDLE ?? "";
  const attempted = `interrupt attempted for dispatch ${parsed.value.dispatchId} with ${runtime === "tmux" ? "Escape" : "--interrupt"}`;
  const append = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt", attempted, session, env, process); if (append.kind !== "ok") return append;
  let result = "not-landed"; let interruptReason = "";
  if (runtime === "tmux") { const sent = await process.run("tmux", ["send-keys", "-t", value(meta.tmuxPane), "Escape"]); result = sent.kind === "ok" ? "landed" : "not-landed"; }
  else { const sent = await process.run("orca", ["terminal", "send", "--terminal", value(meta.terminalId), "--interrupt", "--json"]); result = sent.kind === "ok" ? "landed" : "not-landed"; interruptReason = sent.kind === "failed" ? sent.error : ""; }
  const resultText = `interrupt ${result === "landed" || result === "queued" ? result : "did not land"} for dispatch ${parsed.value.dispatchId}${interruptReason === "" ? "" : `: ${interruptReason}`}`;
  const resultAppend = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt-result", resultText, session, env, process); if (resultAppend.kind !== "ok") return resultAppend;
  return { kind: result === "landed" || result === "queued" ? "ok" : "failed", ...(result === "landed" || result === "queued" ? { value: stopOutput(parsed.value.dispatchId, result, parsed.value.json) } : { error: stopOutput(parsed.value.dispatchId, result, parsed.value.json, interruptReason), exitCode: 1 }) } as Result<string>;
}

async function terminalStatus(meta: RecordValue, process: ProcessAdapter): Promise<"proven" | "missing" | "unknown"> {
  if (value(meta.runtime) !== "tmux") return "unknown";
  const session = await process.run("tmux", ["has-session", "-t", value(meta.tmuxSession)]); if (session.kind !== "ok") return "missing";
  const panes = await process.run("tmux", ["list-panes", "-t", value(meta.tmuxSession), "-F", "#{pane_id}"]); if (panes.kind !== "ok") return "unknown";
  return panes.value.stdout.split("\n").includes(value(meta.tmuxPane)) ? "proven" : "missing";
}

async function hasChildMessage(root: string, dispatch: string): Promise<boolean> { return (await readdir(await dispatchPath(root, dispatch, "messages")).catch(() => [])).some((name) => name.includes("-child-")); }

async function reconcileOne(root: string, dispatch: string, process: ProcessAdapter): Promise<Result<RecordValue>> {
  const path = await dispatchPath(root, dispatch, "meta.json"); const loaded = await readJson(path); if (loaded === undefined) return failed(`dispatch not found: ${dispatch}`); const meta = normalize(loaded);
  const terminal = await terminalStatus(meta, process); const proven = terminal === "proven" || await hasChildMessage(root, dispatch);
  let parent: "alive" | "gone" | "unknown" = "unknown";
  if (proven && value(meta.parentTmuxSession) !== "") parent = (await process.run("tmux", ["has-session", "-t", value(meta.parentTmuxSession)])).kind === "ok" ? "alive" : "gone";
  const decision = reconcileDecision(meta, proven ? "proven" : terminal, parent);
  const next = decision.outcome === "unchanged" ? meta : { ...meta, ...decision.updates, reconcileOutcome: decision.outcome, updatedAt: new Date().toISOString() };
  if (decision.outcome !== "unchanged") await atomicJson(path, next);
  return ok({ ...next, reconcileResult: decision.outcome });
}

export async function executeOrchestrateReconcile(args: readonly string[], env: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate reconcile <dispatch-id> [--all] [--json]\n");
  let dispatch = ""; let all = false; let json = false;
  for (const arg of args) { if (arg === "--all") all = true; else if (arg === "--json") json = true; else if (dispatch === "") dispatch = arg; else return failed(`unknown reconcile option: ${arg}`, 2); }
  const root = resolveStateDirectory(env); const ids = all ? await readdir(`${root}/dispatches`).catch(() => []) : [dispatch]; if (!all && dispatch === "") return failed("Usage: megabrain orchestrate reconcile <dispatch-id> [--all] [--json]\n", 2);
  const entries: RecordValue[] = []; for (const id of ids) { if (id === "archive") continue; const result = await reconcileOne(root, id, process); if (result.kind !== "ok") return result; entries.push(result.value); }
  if (json) return ok(`${JSON.stringify(entries.length === 1 ? entries[0] : entries, null, 2)}\n`);
  return ok(entries.map((item) => `dispatch: ${value(item.dispatchId)}\nresult: ${value(item.reconcileResult)}\nstate: ${value(item.state)}\nprocess: ${value(item.processState)}\nterminal: ${value(item.terminalState)}\n`).join(""));
}
