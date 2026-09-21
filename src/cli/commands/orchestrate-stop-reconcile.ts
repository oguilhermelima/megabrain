import { readdir } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { parseStopArgs, stopDecision, stopOutput } from "../../core/orchestrate-stop.js";
import { reconcileDecision } from "../../core/orchestrate-reconcile.js";
import { classifyLiveness } from "../../core/liveness.js";
import { resolveStateDirectory } from "../../core/state.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { appendMessage, atomicJson, readJson, type QueueEnvironment } from "./queue-write.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { parentStatus, terminalStatus, interruptAffordance, type RecordValue, type TerminalStatus } from "./orchestrate-terminal.js";
import { getHost } from "../../hosts/index.js";

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

async function parentMeta(root: string, dispatch: string, env: QueueEnvironment): Promise<Result<RecordValue>> {
  const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const host = env.MEGABRAIN_SESSION_HOST ?? (env.SUPERSET_TERMINAL_ID !== undefined ? "superset" : env.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : undefined);
  const id = env.MEGABRAIN_SESSION_ID ?? env.SUPERSET_TERMINAL_ID ?? env.ORCA_TERMINAL_HANDLE;
  if (host === undefined || id === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  if (meta.parentHost !== host || meta.parentSessionId !== id) return failed(`dispatch ${dispatch} is owned by ${value(meta.parentHost)}/${value(meta.parentSessionId)}, not ${host}/${id}`);
  return ok(meta);
}

async function tmuxLiveness(meta: RecordValue, process: ProcessAdapter): Promise<{ readonly status: string; readonly reason: string; readonly identity: TerminalStatus }> {
  const identity = await terminalStatus(meta, process);
  if (identity !== "proven") return { status: identity === "missing" ? "missing" : "unknown", reason: identity === "missing" ? "terminal is no longer available" : "terminal identity is unproven", identity };
  const pane = value(meta.tmuxPane);
  const capture = await process.run("tmux", ["capture-pane", "-p", "-t", pane, "-S", "-200"]);
  if (capture.kind !== "ok") return { status: "unknown", reason: "terminal output is unavailable", identity };
  const classified = classifyLiveness(value(meta.agent), capture.value.stdout);
  return { status: classified.status, reason: classified.reason ?? "", identity };
}

async function childMessages(root: string, dispatch: string): Promise<RecordValue[]> {
  const directory = await dispatchPath(root, dispatch, "messages");
  const names = await readdir(directory).catch(() => []);
  const messages: RecordValue[] = [];
  for (const name of names) {
    const message = await readJson(`${directory}/${name}`);
    if (message !== undefined) messages.push(message);
  }
  return messages;
}

function hasChildIdentityProof(messages: readonly RecordValue[]): boolean {
  return messages.some((message) => message.from === "child" && (message.type === "received" || message.type === "ask" || message.type === "done"));
}

async function syncPromptReceipt(path: string, meta: RecordValue, messages: readonly RecordValue[]): Promise<RecordValue> {
  if (!messages.some((message) => message.from === "child" && message.type === "received")) return meta;
  const delivery = value(meta.promptDelivery) || "pending";
  const next: RecordValue = {
    ...meta,
    ...(delivery === "pending" || delivery === "delivered" ? { promptDelivered: true, promptDelivery: "delivered" } : {}),
    promptReceipt: "received",
    promptState: "confirmed",
    updatedAt: new Date().toISOString(),
  };
  await atomicJson(path, next);
  return next;
}

async function reconcileOne(root: string, dispatch: string, process: ProcessAdapter): Promise<Result<RecordValue>> {
  const path = await dispatchPath(root, dispatch, "meta.json");
  const loaded = await readJson(path);
  if (loaded === undefined) return failed(`dispatch not found: ${dispatch}`);
  let meta = normalize(loaded);
  if (JSON.stringify(meta) !== JSON.stringify(loaded)) await atomicJson(path, meta);
  const messages = await childMessages(root, dispatch);
  meta = await syncPromptReceipt(path, meta, messages);
  const state = value(meta.state);
  if (state === "closed" || state === "circuit_broken") return ok({ ...meta, reconcileResult: "unchanged" });
  const terminal = await terminalStatus(meta, process);
  const proven = terminal === "proven" || hasChildIdentityProof(messages);
  let parent: "alive" | "gone" | "unknown" = "unknown";
  if (proven) parent = await parentStatus(meta, process);
  const decision = reconcileDecision(meta, proven ? "proven" : terminal, parent);
  const next = decision.outcome === "unchanged" ? meta : { ...meta, ...decision.updates, reconcileOutcome: decision.outcome, updatedAt: new Date().toISOString() };
  if (decision.outcome !== "unchanged") await atomicJson(path, next);
  return ok({ ...next, reconcileResult: decision.outcome });
}

export async function executeOrchestrateStop(args: readonly string[], env: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate stop <dispatch-id> [--json]\n");
  const parsed = parseStopArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(env); const parent = await parentMeta(root, parsed.value.dispatchId, env); if (parent.kind !== "ok") return parent;
  const meta = parent.value; const runtime = value(meta.runtime) || "host"; let status = "unknown"; let interruptStatus: "landed" | "not-landed" = "not-landed"; let reason = ""; let interruptReason = "";
  if (runtime === "tmux") {
    const live = await tmuxLiveness(meta, process); status = live.status;
    reason = status === "pending-check" ? "pending check frame: messages are waiting for the next tool call" : status === "unknown" ? `unknown liveness: ${live.reason || "liveness is not proven"}` : live.reason || `${status}: agent is not working`;
    const affordance = interruptAffordance(value(meta.agent));
    const decision = stopDecision(status, affordance === undefined ? "unknown" : "known");
    if (decision.kind !== "ok") return failed(`dispatch ${parsed.value.dispatchId} cannot be stopped: ${reason || decision.error}`);
    const attempted = `interrupt attempted for dispatch ${parsed.value.dispatchId} with Escape`;
    const session = env.MEGABRAIN_SESSION_ID ?? env.SUPERSET_TERMINAL_ID ?? env.ORCA_TERMINAL_HANDLE ?? "";
    const append = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt", attempted, session, env, process); if (append.kind !== "ok") return append;
    const sent = await process.run("tmux", ["send-keys", "-t", value(meta.tmuxPane), affordance ?? "Escape"]); interruptStatus = sent.kind === "ok" ? "landed" : "not-landed";
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
    const session = env.MEGABRAIN_SESSION_ID ?? env.SUPERSET_TERMINAL_ID ?? env.ORCA_TERMINAL_HANDLE ?? "";
    const attempted = `interrupt attempted for dispatch ${parsed.value.dispatchId} with --interrupt; terminal identity is proven, but working liveness and pending-check frame are unavailable on Orca`;
    const append = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt", attempted, session, env, process); if (append.kind !== "ok") return append;
    const sent = await process.run(interrupt.value.command, interrupt.value.args);
    interruptStatus = sent.kind === "ok" ? "landed" : "not-landed";
    interruptReason = sent.kind === "failed" ? sent.error : "";
  }
  const session = env.MEGABRAIN_SESSION_ID ?? env.SUPERSET_TERMINAL_ID ?? env.ORCA_TERMINAL_HANDLE ?? "";
  const resultText = interruptStatus === "landed" ? `interrupt landed for dispatch ${parsed.value.dispatchId}` : `interrupt did not land for dispatch ${parsed.value.dispatchId}${interruptReason === "" ? "" : `: ${interruptReason}`}`;
  const resultAppend = await appendMessage(root, parsed.value.dispatchId, "parent", "interrupt-result", resultText, session, env, process); if (resultAppend.kind !== "ok") return resultAppend;
  const output = stopOutput(parsed.value.dispatchId, interruptStatus, parsed.value.json, interruptReason);
  return interruptStatus === "landed" ? ok(output) : failed(output);
}

export async function executeOrchestrateReconcile(args: readonly string[], env: QueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate reconcile <dispatch-id> [--all] [--json]\n");
  let dispatch = ""; let all = false; let json = false;
  for (const arg of args) { if (arg === "--all") all = true; else if (arg === "--json") json = true; else if (dispatch === "") dispatch = arg; else return failed(`unknown reconcile option: ${arg}`, 2); }
  const root = resolveStateDirectory(env); const ids = all ? (await readdir(`${root}/dispatches`, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && entry.name !== "archive").map((entry) => entry.name) : [dispatch]; if (!all && dispatch === "") return failed("Usage: megabrain orchestrate reconcile <dispatch-id> [--all] [--json]\n", 2);
  const entries: RecordValue[] = [];
  for (const id of ids) {
    if (await readJson(await dispatchPath(root, id, "meta.json")) === undefined) { if (all) continue; return failed(`dispatch not found: ${id}`); }
    const result = await reconcileOne(root, id, process); if (result.kind !== "ok") return result; entries.push(result.value);
  }
  if (json) return ok(`${JSON.stringify(entries.length === 1 ? entries[0] : entries, null, 2)}\n`);
  return ok(entries.map((item) => `dispatch: ${value(item.dispatchId)}\nresult: ${value(item.reconcileResult)}\nstate: ${value(item.state)}\nprocess: ${value(item.processState)}\nterminal: ${value(item.terminalState)}\n`).join(""));
}
