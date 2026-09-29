import { failed, ok, type Result } from "../../core/result.js";
import { parseStopArgs, stopDecision, stopOutput } from "../../core/orchestrate-stop.js";
import { reconcileDecision } from "../../core/orchestrate-reconcile.js";
import { classifyLiveness } from "../../core/liveness.js";
import { resolveStateDirectory } from "../../core/state.js";
import { appendMessage, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { hasCallerIdentity, ownsDispatch } from "../../core/context.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { parentStatus, terminalStatus, type RecordValue, type TerminalStatus } from "./orchestrate-terminal.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { interruptKey } from "../../agents/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, getDispatch, listDispatches, listMessages, mutateDispatch } from "../../adapters/state-db.js";
import type { DatabaseHandle } from "../../db/db.js";

const value = (input: unknown): string => typeof input === "string" ? input : "";

function normalize(meta: RecordValue): RecordValue {
  const storedState = value(meta.state);
  const state = storedState === "stalled" || storedState === "timeout" ? "running" : storedState === "" ? "running" : storedState;
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

async function parentMeta(database: DatabaseHandle, dispatch: string, env: QueueEnvironment, process: ProcessAdapter): Promise<Result<RecordValue>> {
  const stored = getDispatch(database, dispatch);
  if (stored.kind !== "ok") return stored;
  const meta = stored.value;
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const live = listDispatches(database);
  if (live.kind !== "ok") return live;
  if (!live.value.some((record) => record.dispatchId === dispatch)) return failed(`dispatch ${dispatch} is archived; refusing to change it`);
  const current = await resolveCaller(env, process);
  if (!hasCallerIdentity(current)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = value(meta.parentHost); const expectedId = value(meta.parentSessionId);
  if (!ownsDispatch(current, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${dispatch} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id || current.terminalId || ""}`);
  return ok(meta);
}

async function tmuxLiveness(meta: RecordValue, process: ProcessAdapter): Promise<{ readonly status: string; readonly reason: string; readonly identity: TerminalStatus }> {
  const identity = await terminalStatus(meta, process);
  if (identity !== "proven") return { status: identity === "missing" ? "missing" : "unknown", reason: identity === "missing" ? "terminal is no longer available" : "terminal identity is unproven", identity };
  const pane = value(meta.tmuxPane);
  const capture = await getTmux().capturePane(pane, 200, process);
  if (capture.kind !== "ok") return { status: "unknown", reason: "terminal output is unavailable", identity };
  const classified = classifyLiveness(value(meta.agent), capture.value);
  return { status: classified.status, reason: classified.reason ?? "", identity };
}

function childMessages(database: DatabaseHandle, dispatch: string): RecordValue[] {
  const messages = listMessages(database, dispatch);
  return messages.kind === "ok" ? messages.value as RecordValue[] : [];
}

function hasChildIdentityProof(messages: readonly RecordValue[]): boolean {
  return messages.some((message) => message.from === "child" && (message.type === "received" || message.type === "ask" || message.type === "done"));
}

function syncPromptReceipt(database: DatabaseHandle, dispatch: string, meta: RecordValue, messages: readonly RecordValue[]): RecordValue {
  if (!messages.some((message) => message.from === "child" && message.type === "received")) return meta;
  const delivery = value(meta.promptDelivery) || "pending";
  const next: RecordValue = {
    ...meta,
    ...(delivery === "pending" || delivery === "delivered" ? { promptDelivered: true, promptDelivery: "delivered" } : {}),
    promptReceipt: "received",
    promptState: "confirmed",
    updatedAt: new Date().toISOString(),
  };
  const updated = mutateDispatch(database, dispatch, () => next);
  return updated.kind === "ok" ? updated.value as RecordValue : meta;
}

async function reconcileOne(database: DatabaseHandle, dispatch: string, process: ProcessAdapter): Promise<Result<RecordValue>> {
  const loaded = getDispatch(database, dispatch);
  if (loaded.kind !== "ok") return loaded;
  if (loaded.value === undefined) return failed(`dispatch not found: ${dispatch}`);
  let meta = normalize(loaded.value as RecordValue);
  if (JSON.stringify(meta) !== JSON.stringify(loaded.value)) {
    const updated = mutateDispatch(database, dispatch, () => meta);
    if (updated.kind !== "ok") return updated;
    meta = updated.value as RecordValue;
  }
  const messages = childMessages(database, dispatch);
  meta = syncPromptReceipt(database, dispatch, meta, messages);
  const state = value(meta.state);
  if (state === "closed" || state === "circuit_broken") return ok({ ...meta, reconcileResult: "unchanged" });
  const terminal = await terminalStatus(meta, process);
  const proven = terminal === "proven" || hasChildIdentityProof(messages);
  let parent: "alive" | "gone" | "unknown" = "unknown";
  if (proven) parent = await parentStatus(meta, process);
  const decision = reconcileDecision(meta, proven ? "proven" : terminal, parent);
  const next = decision.outcome === "unchanged" ? meta : { ...meta, ...decision.updates, reconcileOutcome: decision.outcome, updatedAt: new Date().toISOString() };
  if (decision.outcome !== "unchanged") {
    const updated = mutateDispatch(database, dispatch, () => next);
    if (updated.kind !== "ok") return updated;
  }
  return ok({ ...next, reconcileResult: decision.outcome });
}

export async function executeOrchestrateStop(args: readonly string[], env: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-stop"));
  const parsed = parseStopArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(env); const database = stateDatabase(env); if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const parent = await parentMeta(database.value, parsed.value.dispatchId, env, process); if (parent.kind !== "ok") return parent;
  const caller = await resolveCaller(env, process); const session = caller.id || caller.terminalId || "";
  const meta = parent.value; const runtime = value(meta.runtime) || "host"; let status = "unknown"; let interruptStatus: "landed" | "not-landed" = "not-landed"; let reason = ""; let interruptReason = "";
  if (runtime === "tmux") {
    const live = await tmuxLiveness(meta, process); status = live.status;
    reason = status === "pending-check" ? "pending check frame: messages are waiting for the next tool call" : status === "unknown" ? `unknown liveness: ${live.reason || "liveness is not proven"}` : live.reason || `${status}: agent is not working`;
    const affordance = interruptKey(value(meta.agent));
    const decision = stopDecision(status, affordance.kind === "ok" ? "known" : "unknown");
    if (decision.kind !== "ok") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: ${reason || decision.error}`);
    if (affordance.kind !== "ok") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: ${affordance.error}`);
    const attempted = `interrupt attempted for dispatch ${parsed.value.dispatchId} with ${affordance.value}`;
    const append = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt", attempted, session, env, process); if (append.kind !== "ok") return append;
    const sent = await getTmux().sendKey(value(meta.tmuxPane), affordance.value, process); interruptStatus = sent.kind === "ok" ? "landed" : "not-landed";
  } else {
    const host = value(meta.childHost);
    const provider = getHost(host);
    if (provider === undefined) return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: interrupt capability is unavailable for host ${host || "unknown"}`);
    const interrupt = provider.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: value(meta.terminalId), interrupt: true });
    if (interrupt.kind === "unknown") {
      const reason = host === "superset" ? "Superset terminals send offers no interrupt capability" : interrupt.reason;
      return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: ${reason}`);
    }
    if (interrupt.kind !== "ok") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: ${interrupt.error}`);
    const identity = await terminalStatus(meta, process);
    if (identity === "missing") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: Orca terminal identity is missing; cannot safely interrupt`);
    if (identity !== "proven") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: Orca terminal identity is unproven; cannot safely interrupt`);
    const attempted = `interrupt attempted for dispatch ${parsed.value.dispatchId} with --interrupt; terminal identity is proven, but working liveness and pending-check frame are unavailable on Orca`;
    const append = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt", attempted, session, env, process); if (append.kind !== "ok") return append;
    const sent = await runHostSend(host, process, interrupt.value);
    interruptStatus = sent.kind === "ok" ? "landed" : "not-landed";
    interruptReason = sent.kind === "failed" ? sent.error : "";
  }
  const resultText = interruptStatus === "landed" ? `interrupt landed for dispatch ${parsed.value.dispatchId}` : `interrupt did not land for dispatch ${parsed.value.dispatchId}${interruptReason === "" ? "" : `: ${interruptReason}`}`;
  const resultAppend = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt-result", resultText, session, env, process); if (resultAppend.kind !== "ok") return resultAppend;
  const output = stopOutput(parsed.value.dispatchId, interruptStatus, parsed.value.json, interruptReason);
  return interruptStatus === "landed" ? ok(output) : failed(output);
}

export async function executeOrchestrateReconcile(args: readonly string[], env: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-reconcile"));
  let dispatch = ""; let all = false; let json = false;
  for (const arg of args) { if (arg === "--all") all = true; else if (arg === "--json") json = true; else if (dispatch === "") dispatch = arg; else return failed(`unknown reconcile option: ${arg}`, 2); }
  const database = stateDatabase(env); if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const live = listDispatches(database.value); if (live.kind !== "ok") return live;
  const ids = all ? live.value.map((record) => record.dispatchId) : [dispatch]; if (!all && dispatch === "") return failed(usageText("orchestrate-reconcile"), 2);
  const entries: RecordValue[] = [];
  for (const id of ids) {
    const stored = getDispatch(database.value, id); if (stored.kind !== "ok") return stored;
    if (stored.value === undefined) { if (all) continue; return failed(`dispatch not found: ${id}`); }
    if (!all && !live.value.some((record) => record.dispatchId === id)) return failed(`dispatch ${id} is archived; refusing to reconcile it`);
    const result = await reconcileOne(database.value, id, process); if (result.kind !== "ok") return result; entries.push(result.value);
  }
  if (json) return ok(`${JSON.stringify(entries.length === 1 ? entries[0] : entries, null, 2)}\n`);
  return ok(entries.map((item) => `dispatch: ${value(item.dispatchId)}\nresult: ${value(item.reconcileResult)}\nstate: ${value(item.state)}\nprocess: ${value(item.processState)}\nterminal: ${value(item.terminalState)}\n`).join(""));
}
