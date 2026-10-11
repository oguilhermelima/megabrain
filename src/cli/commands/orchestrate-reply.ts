import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { normalizeDispatchState, parseParentChangeArgs, parseParentReplyArgs, replyStateError, type SupersedeSummary } from "../../core/parent-reply.js";
import { classifyLiveness, waitForStableIdle } from "../../core/liveness.js";
import { notifyChild, resolveCaller, appendMessage, type QueueEnvironment } from "./queue-write.js";
import { hasCallerIdentity, ownsDispatch } from "../../core/context.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { executeOrchestrateStop } from "./orchestrate-stop-reconcile.js";
import { terminalStatus } from "./orchestrate-terminal.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { submitKey } from "../../agents/index.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, getDispatch, listDispatches, mutateDispatch, appendParentReply, listMessages } from "../../adapters/state-db.js";
import type { DatabaseHandle } from "../../db/db.js";
import { PROMPT_BUDGET_TMUX_BYTES, promptByteLength } from "../../core/prompt-budget.js";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function stopReason(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = recordValue(parsed);
    if (record !== undefined) {
      const reason = record.reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  } catch {
    // Stop errors are also allowed to be plain host text.
  }
  return value;
}

type ChangeRead = (meta: JsonRecord, process: ProcessAdapter) => Promise<Result<string>>;

function screenText(agent: string, output: string): string {
  if (classifyLiveness(agent, output).status !== "unknown") return output;
  if (agent === "codex" && /Conversation interrupted/.test(output) && /^\s*› (?!Ask Codex to do anything\s*$).+$/m.test(output)) return `${output}\n› Ask Codex to do anything`;
  if (agent === "claude" && /Interrupted · What should Claude do instead\?/.test(output) && /^\s*❯\s*\S.+$/m.test(output)) return `${output}\n❯`;
  return output;
}

function terminalScreen(stdout: string): Result<string> {
  try {
    const root = recordValue(JSON.parse(stdout));
    const terminal = recordValue(recordValue(root?.result)?.terminal);
    const tail = terminal?.tail;
    const output = typeof tail === "string" ? tail : Array.isArray(tail) && tail.every((line) => typeof line === "string") ? tail.join("\n") : undefined;
    if (output === undefined) return failed("terminal screen read did not include result.terminal.tail");
    const draft = typeof terminal?.draft === "string" ? terminal.draft : "";
    return ok(draft === "" ? output : `${output}\n${draft}`);
  } catch {
    return failed("terminal screen read returned invalid JSON");
  }
}

async function readChangeScreen(meta: JsonRecord, process: ProcessAdapter): Promise<Result<string>> {
  const agent = typeof meta.agent === "string" ? meta.agent : "";
  if (meta.runtime === "tmux") {
    const identity = await terminalStatus(meta, process);
    if (identity !== "proven") return failed(identity === "missing" ? "terminal is no longer available" : "terminal identity is unproven");
    const capture = await getTmux().capturePane(String(meta.tmuxPane ?? ""), 200, process, true);
    return capture.kind === "ok" ? ok(screenText(agent, capture.value)) : capture;
  }
  const identity = await terminalStatus(meta, process);
  if (identity !== "proven") return failed(identity === "missing" ? "terminal is no longer available" : "terminal identity is unproven");
  const provider = getHost(String(meta.childHost ?? ""));
  if (provider === undefined) return failed(`screen read is unavailable for host ${String(meta.childHost ?? "unknown")}`);
  const call = provider.read({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? "") });
  if (call.kind !== "ok") return call.kind === "failed" ? failed(call.error, call.exitCode) : failed(call.reason);
  const captured = await process.run(call.value.command, [...call.value.args, "--screen"]);
  if (captured.kind !== "ok") return failed(captured.error, captured.exitCode);
  const raw = terminalScreen(captured.value.stdout);
  return raw.kind === "ok" ? ok(screenText(agent, raw.value)) : raw;
}

function changeOutput(dispatch: string, json: boolean, value: {
  attempts: number;
  idleReached: boolean;
  delivered: boolean;
  confirmed: boolean;
  superseded: SupersedeSummary;
  oversized: boolean;
  reason?: string;
}): string {
  if (json) return `${JSON.stringify({ dispatchId: dispatch, queueChanged: true, interrupted: value.attempts > 0, status: value.delivered ? value.confirmed ? "delivered" : "delivered-unconfirmed" : "queued", attempts: value.attempts, idleReached: value.idleReached, delivered: value.delivered, confirmed: value.confirmed, supersededQueued: value.superseded.queued, supersededDelivered: value.superseded.delivered, deliveredSequences: value.superseded.deliveredSequences, oversized: value.oversized, ...(value.reason === undefined ? {} : { reason: value.reason }) }, null, 2)}\n`;
  return `changed: ${dispatch}\nattempts: ${value.attempts}\nidle reached: ${value.idleReached}\ndelivered: ${value.delivered ? value.confirmed ? "yes (confirmed)" : "yes (unconfirmed)" : "no"}\nsuperseded queued: ${value.superseded.queued}\nsuperseded delivered: ${value.superseded.delivered}\n${value.oversized ? "direction exceeded the tmux limit; sent a megabrain check pointer\n" : ""}${value.reason === undefined ? "" : `${value.reason}\n`}`;
}

async function recordChangeEvent(root: string, dispatch: string, type: string, text: string, session: string, env: QueueEnvironment, process: ProcessAdapter): Promise<Result<void>> {
  const appended = await appendMessage(root, dispatch, "parent", type, text, session, env, process);
  return appended.kind === "ok" ? ok(undefined) : appended;
}

async function waitForChangeIdle(agent: string, timeoutMs: number, read: ChangeRead, meta: JsonRecord, process: ProcessAdapter): Promise<Result<void>> {
  return waitForStableIdle(agent, timeoutMs, () => read(meta, process), `child did not become idle within ${timeoutMs}ms`);
}

async function clearChangeComposer(meta: JsonRecord, process: ProcessAdapter): Promise<Result<void>> {
  if (meta.runtime === "tmux") return getTmux().sendKey(String(meta.tmuxPane ?? ""), "C-u", process);
  const host = String(meta.childHost ?? "");
  const provider = getHost(host);
  if (provider === undefined) return failed(`composer clearing is unavailable for host ${host || "unknown"}`);
  const call = provider.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? ""), text: "\u0015", enter: false });
  if (call.kind !== "ok") return call.kind === "failed" ? failed(call.error, call.exitCode) : failed(call.reason);
  const result = await runHostSend(host, process, call.value);
  return result.kind === "ok" ? ok(undefined) : result.kind === "failed" ? failed(result.error, result.exitCode) : failed(result.reason);
}

async function sendChange(meta: JsonRecord, root: string, text: string, process: ProcessAdapter, env: QueueEnvironment, afterClear?: () => Promise<Result<void>>): Promise<Result<void>> {
  const submit = submitKey(String(meta.agent ?? ""));
  if (submit.kind !== "ok") return failed(submit.kind === "failed" ? submit.error : submit.reason);
  if (meta.runtime === "tmux") return sendTmuxPair(root, String(meta.tmuxPane ?? ""), text, submit.value, env, process, true, afterClear);
  const host = String(meta.childHost ?? "");
  const provider = getHost(host);
  if (provider === undefined) return failed(`send capability is unavailable for host ${host || "unknown"}`);
  const target = { workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? "") };
  const key = submit.value === "Tab" ? "\t" : "\r";
  const typed = provider.send({ ...target, text: `${text}${key}`, enter: false });
  if (typed.kind !== "ok") return typed.kind === "failed" ? failed(typed.error, typed.exitCode) : failed(typed.reason);
  const sent = await runHostSend(host, process, typed.value);
  return sent.kind === "ok" ? ok(undefined) : sent.kind === "failed" ? failed(sent.error, sent.exitCode) : failed(sent.reason);
}

async function waitForChangeWorking(agent: string, timeoutMs: number, read: ChangeRead, meta: JsonRecord, process: ProcessAdapter): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const captured = await read(meta, process);
    if (captured.kind === "ok" && classifyLiveness(agent, captured.value).status === "working") return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function requireParent(database: DatabaseHandle, dispatch: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<JsonRecord>> {
  const stored = getDispatch(database, dispatch);
  if (stored.kind !== "ok") return stored;
  const meta = stored.value;
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const live = listDispatches(database);
  if (live.kind !== "ok") return live;
  if (!live.value.some((record) => record.dispatchId === dispatch)) return failed(`dispatch ${dispatch} is archived; refusing to change it`);
  const current = await resolveCaller(environment, processAdapter);
  if (!hasCallerIdentity(current)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = String(meta.parentHost ?? ""); const expectedId = String(meta.parentSessionId ?? "");
  if (!ownsDispatch(current, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${dispatch} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id || current.terminalId || ""}`);
  return ok(meta);
}

function outputReply(dispatch: string, json: boolean, nudge: string, summary: SupersedeSummary): string {
  if (json) return `${JSON.stringify({ dispatchId: dispatch, status: "queued", nudge, supersededQueued: summary.queued, supersededDelivered: summary.delivered, deliveredSequences: summary.deliveredSequences }, null, 2)}\n`;
  return `queued: ${dispatch}\n${summary.queued > 0 || summary.delivered > 0 ? `superseded queued: ${summary.queued}\nsuperseded delivered: ${summary.delivered}\n` : ""}${nudge === "typed" ? "" : "nudge not typed; the child will still find this reply with megabrain check\n"}`;
}

export async function executeOrchestrateReply(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-reply"));
  const parsed = parseParentReplyArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const opened = stateDatabase(environment); if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const parent = await requireParent(opened.value, parsed.value.dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  // The shell normalizes a persisted "stalled"/"timeout" state to "running" on every meta read
  // (megabrain_dispatch_meta_normalize), before the reply's own state check ever runs — so it,
  // and the "state !== done" guard below that decides whether to resume the dispatch, both see
  // the normalized value, never the raw legacy one.
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "");
  const stateError = replyStateError(parsed.value.dispatchId, state, false); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const sessionId = caller.id || caller.terminalId || "";
  const append = appendParentReply(opened.value, parsed.value.dispatchId, { from: "parent", type: "reply", text: parsed.value.text, sessionId }, { supersede: parsed.value.supersede });
  if (append.kind !== "ok") return append;
  const summary: SupersedeSummary = append.value.supersedeSummary as SupersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  const notification = await notifyChild(root, parent.value, parsed.value.dispatchId, processAdapter).catch(() => ({ outcome: "failed", reason: "notification failed" }));
  if (state !== "done") {
    const updated = mutateDispatch(opened.value, parsed.value.dispatchId, (current) => ({ ...current, state: "running", updatedAt: new Date().toISOString() }));
    if (updated.kind !== "ok") return updated;
  }
  return ok(outputReply(parsed.value.dispatchId, parsed.value.json, notification.outcome === "delivered" ? "typed" : "not-typed", summary));
}

export async function executeOrchestrateChange(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-change"));
  const parsed = parseParentChangeArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const database = stateDatabase(environment); if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const parent = await requireParent(database.value, parsed.value.dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "");
  const stateError = replyStateError(parsed.value.dispatchId, state, true); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const session = caller.id || caller.terminalId || "";
  const appended = appendParentReply(database.value, parsed.value.dispatchId, { from: "parent", type: "reply", text: parsed.value.text, sessionId: session }, { supersede: true });
  if (appended.kind !== "ok") return appended;
  const superseded = appended.value.supersedeSummary as SupersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  const updated = mutateDispatch(database.value, parsed.value.dispatchId, (current) => ({ ...current, state: "running", updatedAt: new Date().toISOString() }));
  if (updated.kind !== "ok") return updated;

  const meta = parent.value;
  const timeoutMs = parsed.value.idleTimeout * 1000;
  const summary = { attempts: 0, idleReached: false, delivered: false, confirmed: false, superseded, oversized: false };
  const agent = typeof meta.agent === "string" ? meta.agent : "";
  const recordIdle = (attempt: number, idle: boolean, detail: string): Promise<Result<void>> => recordChangeEvent(root, parsed.value.dispatchId, "idle-result", `after interrupt ${attempt}: idle=${idle}; ${detail}`, session, environment, processAdapter);

  if (meta.runtime !== "tmux" && meta.childHost === "superset") {
    const stopped = await executeOrchestrateStop([parsed.value.dispatchId, "--json"], environment, processAdapter);
    const reason = stopped.kind === "failed" ? stopReason(stopped.error) : "Superset terminals send offers no interrupt capability";
    await recordChangeEvent(root, parsed.value.dispatchId, "interrupt-result", reason, session, environment, processAdapter);
    return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, { ...summary, reason: `queue changed; agent was not interrupted: ${reason}` }));
  }

  let screen = await readChangeScreen(meta, processAdapter);
  if (screen.kind !== "ok") {
    await recordIdle(0, false, `screen unavailable: ${screen.error}`);
    return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, { ...summary, reason: `queue changed; agent was not interrupted: ${screen.error}` }));
  }
  let liveness = classifyLiveness(agent, screen.value).status;
  if (liveness === "idle") {
    const idle = await waitForChangeIdle(agent, timeoutMs, readChangeScreen, meta, processAdapter);
    summary.idleReached = idle.kind === "ok";
    const recorded = await recordIdle(0, summary.idleReached, summary.idleReached ? "composer idle and stable before interrupt" : "idle was not stable");
    if (recorded.kind !== "ok") return recorded;
  } else if (liveness !== "working") {
    await recordIdle(0, false, `child liveness is ${liveness}`);
    return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, { ...summary, reason: `queue changed; agent was not interrupted: child liveness is ${liveness}` }));
  }

  for (let attempt = 1; !summary.idleReached && attempt <= parsed.value.attempts; attempt += 1) {
    const before = listMessages(database.value, parsed.value.dispatchId);
    if (before.kind !== "ok") return before;
    const stopped = await executeOrchestrateStop([parsed.value.dispatchId, "--json"], environment, processAdapter);
    const after = listMessages(database.value, parsed.value.dispatchId);
    if (after.kind !== "ok") return after;
    const attemptsBefore = (before.value as JsonRecord[]).filter((message) => message.type === "interrupt").length;
    const attemptsAfter = (after.value as JsonRecord[]).filter((message) => message.type === "interrupt").length;
    summary.attempts += attemptsAfter - attemptsBefore;
    if (stopped.kind === "failed" && attemptsAfter === attemptsBefore) {
      const reason = stopReason(stopped.error);
      if (reason.includes("Superset terminals send offers no interrupt capability")) {
        await recordChangeEvent(root, parsed.value.dispatchId, "delivery-result", "direction not typed because the host cannot interrupt; direction remains queued", session, environment, processAdapter);
        return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, { ...summary, reason: `queue changed; agent was not interrupted: ${reason}` }));
      }
      screen = await readChangeScreen(meta, processAdapter);
      if (screen.kind !== "ok") {
        await recordIdle(attempt, false, `screen unavailable: ${screen.error}`);
        return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, { ...summary, reason: `queue changed; agent was not interrupted: ${screen.error}` }));
      }
      liveness = classifyLiveness(agent, screen.value).status;
      if (liveness !== "idle") {
        await recordIdle(attempt, false, `stop refused: ${reason}`);
        return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, { ...summary, reason: `queue changed; agent was not interrupted: ${reason}` }));
      }
    }
    const idle = await waitForChangeIdle(agent, timeoutMs, readChangeScreen, meta, processAdapter);
    summary.idleReached = idle.kind === "ok";
    const recorded = await recordIdle(attempt, summary.idleReached, summary.idleReached ? "composer idle and stable" : "child remained busy or screen was unreadable");
    if (recorded.kind !== "ok") return recorded;
  }

  if (!summary.idleReached) {
    const message = `child did not stop after ${summary.attempts} interrupts; direction stays queued for megabrain check`;
    if (parsed.value.json) return failed(JSON.stringify({ dispatchId: parsed.value.dispatchId, status: "queued", attempts: summary.attempts, idleReached: false, delivered: false, confirmed: false, supersededQueued: superseded.queued, supersededDelivered: superseded.delivered, deliveredSequences: superseded.deliveredSequences, oversized: false, message }, null, 2), 1);
    return failed(`${message}\nattempts: ${summary.attempts}\nidle reached: false\ndelivered: false\nconfirmed: false\nsuperseded queued: ${superseded.queued}\nsuperseded delivered: ${superseded.delivered}`, 1);
  }

  const verifyClearedComposer = async (): Promise<Result<void>> => {
    const empty = await waitForChangeIdle(agent, timeoutMs, readChangeScreen, meta, processAdapter);
    const recorded = await recordChangeEvent(root, parsed.value.dispatchId, "composer-clear", empty.kind === "ok" ? "Ctrl-U sent and screen proved the composer empty" : "Ctrl-U sent but the composer was not proven empty", session, environment, processAdapter);
    if (recorded.kind !== "ok") return recorded;
    return empty.kind === "ok" ? ok(undefined) : failed("composer was not proven empty after clearing");
  };
  if (meta.runtime !== "tmux") {
    const cleared = await clearChangeComposer(meta, processAdapter);
    if (cleared.kind !== "ok") {
      const recorded = await recordChangeEvent(root, parsed.value.dispatchId, "composer-clear", `clear failed: ${cleared.error}`, session, environment, processAdapter);
      if (recorded.kind !== "ok") return recorded;
      return failed(`direction stays queued for megabrain check; composer could not be cleared: ${cleared.error}`);
    }
    const empty = await verifyClearedComposer();
    if (empty.kind !== "ok") return failed(`direction stays queued for megabrain check; ${empty.error}`);
  }

  const formatted = `[megabrain] Change of direction from your coordinator. Stop the approach you were on and follow this instead:\n${parsed.value.text}\n(The same text is available with megabrain check.)`;
  summary.oversized = meta.runtime === "tmux" && promptByteLength(formatted) > PROMPT_BUDGET_TMUX_BYTES;
  const deliveryText = summary.oversized ? "[megabrain] A new direction is queued; run megabrain check to read it." : formatted;
  const delivery = await sendChange(meta, root, deliveryText, processAdapter, environment, meta.runtime === "tmux" ? verifyClearedComposer : undefined);
  summary.delivered = delivery.kind === "ok";
  const deliveryError = delivery.kind === "ok" ? "" : delivery.error;
  const deliveryEvent = await recordChangeEvent(root, parsed.value.dispatchId, "delivery-result", summary.delivered ? `direction submitted${summary.oversized ? " as check pointer because it exceeded 12000 bytes" : ""}` : `direction not submitted: ${deliveryError}`, session, environment, processAdapter);
  if (deliveryEvent.kind !== "ok") return deliveryEvent;
  if (!summary.delivered) return failed(`direction stays queued for megabrain check; could not submit the direction: ${deliveryError}`);
  summary.confirmed = await waitForChangeWorking(agent, timeoutMs, readChangeScreen, meta, processAdapter);
  const confirmed = await recordChangeEvent(root, parsed.value.dispatchId, "delivery-confirmation", `agent started working: ${summary.confirmed}`, session, environment, processAdapter);
  if (confirmed.kind !== "ok") return confirmed;
  return ok(changeOutput(parsed.value.dispatchId, parsed.value.json, summary));
}
