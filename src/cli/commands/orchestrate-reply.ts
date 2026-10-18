import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { normalizeDispatchState, parseParentChangeArgs, parseParentReplyArgs, replyStateError, type SupersedeSummary } from "../../core/parent-reply.js";
import { classifyLiveness } from "../../core/liveness.js";
import { notifyChild, resolveCaller, appendMessage, type QueueEnvironment } from "./queue-write.js";
import { acknowledgeImplicitDelivery, setDeliveryTransport, claimOutbox, finishOutbox, acquireLease, releaseLease, listDeliveries, listMessages } from "../../adapters/state-db.js";
import { executeDeliveryWorker, startDeliveryWorker, deliveryTarget } from "./delivery-worker.js";
import { randomUUID } from "node:crypto";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { readDeliveryScreen } from "./delivery-screen.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, getDispatch, listDispatches, mutateDispatch, appendParentReply } from "../../adapters/state-db.js";
import type { DatabaseHandle } from "../../db/db.js";
import { PROMPT_BUDGET_TMUX_BYTES, promptByteLength } from "../../core/prompt-budget.js";
import { dispatchMessageHeader, formatDispatchMessage, formatFullDirection } from "../../core/chat-message-format.js";
import { setTmuxChatPane } from "../../core/chat-pane.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";
import { interruptKey } from "../../agents/index.js";
import { agentOwnsForegroundProcess } from "../../core/terminal-process.js";

type JsonRecord = Record<string, unknown>;

function acknowledgeParentReads(database: DatabaseHandle, dispatch: string): void {
  const deliveries = listDeliveries(database, dispatch);
  const messages = listMessages(database, dispatch);
  if (deliveries.kind !== "ok" || messages.kind !== "ok") return;
  for (const delivery of deliveries.value) {
    if (delivery.recipient !== "parent" || !Array.isArray(delivery.messageSeqs)) continue;
    if (!delivery.messageSeqs.some((sequence) => messages.value.some((message) => message.seq === sequence && message.from === "child" && message.type === "ask"))) continue;
    acknowledgeImplicitDelivery(database, dispatch, delivery.id, "parent");
  }
}

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
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

async function interruptChange(meta: JsonRecord, process: ProcessAdapter): Promise<boolean> {
  const screen = await readDeliveryScreen(meta, process);
  const captured = screen.kind === "ok" ? screen.value : "";
  if (meta.runtime === "tmux") {
    const key = interruptKey(String(meta.agent ?? ""), captured);
    return key.kind === "ok" && (await getTmux().sendKey(String(meta.tmuxPane ?? ""), key.value, process)).kind === "ok";
  }
  const host = String(meta.childHost ?? "");
  const provider = getHost(host);
  const key = interruptKey(String(meta.agent ?? ""), captured);
  const interrupt = key.kind === "ok" ? provider?.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? ""), text: key.value === "Escape" ? "\u001b" : "\u0003", enter: false }) : undefined;
  if (interrupt?.kind !== "ok") return false;
  return (await runHostSend(host, process, interrupt.value)).kind === "ok";
}

async function requireParent(database: DatabaseHandle, dispatch: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<JsonRecord & { dispatchId: string }>> {
  const current = await resolveCaller(environment, processAdapter);
  const resolved = resolveParentDispatchId(database, dispatch, current);
  if (resolved.kind !== "ok") return resolved;
  const stored = getDispatch(database, resolved.value);
  if (stored.kind !== "ok") return stored;
  const meta = stored.value;
  if (meta === undefined) return failed(`dispatch not found: ${resolved.value}`);
  const live = listDispatches(database);
  if (live.kind !== "ok") return live;
  if (!live.value.some((record) => record.dispatchId === resolved.value)) return failed(`dispatch ${resolved.value} is archived; refusing to change it`);
  return ok({ ...meta, dispatchId: resolved.value });
}

function outputReply(dispatch: string, json: boolean, nudge: string, summary: SupersedeSummary): string {
  if (json) return `${JSON.stringify({ dispatchId: dispatch, status: "queued", nudge, supersededQueued: summary.queued, supersededDelivered: summary.delivered, deliveredSequences: summary.deliveredSequences }, null, 2)}\n`;
  return `queued: ${dispatch}\n${summary.queued > 0 || summary.delivered > 0 ? `superseded queued: ${summary.queued}\nsuperseded delivered: ${summary.delivered}\n` : ""}${nudge === "typed" ? "" : nudge === "supervisor" ? "reply queued for idle delivery; the supervisor will restart delivery if needed\n" : "nudge not typed; the child will still find this reply with megabrain check\n"}`;
}

export async function executeOrchestrateReply(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-reply"));
  const parsed = parseParentReplyArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const opened = stateDatabase(environment); if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  let dispatchId = parsed.value.dispatchId;
  const parent = await requireParent(opened.value, dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  dispatchId = parent.value.dispatchId;
  // The shell normalizes a persisted "stalled"/"timeout" state to "running" on every meta read
  // (megabrain_dispatch_meta_normalize), before the reply's own state check ever runs — so it,
  // and the "state !== done" guard below that decides whether to resume the dispatch, both see
  // the normalized value, never the raw legacy one.
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "");
  const stateError = replyStateError(dispatchId, state, false); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const sessionId = caller.id || caller.terminalId || "";
  const childMessage = formatDispatchMessage({ dispatchId: dispatchId, chatName: String(parent.value.chatName ?? parent.value.branch ?? dispatchId), agent: String(parent.value.agent ?? "unknown"), type: "reply", text: parsed.value.text, direction: "child-bound", parentAgent: String(parent.value.parentAgent ?? "megabrain"), parentChatName: String(parent.value.parentChatName ?? "megabrain/main") });
  const outboxId = `delivery-${randomUUID()}`;
  const append = appendParentReply(opened.value, dispatchId, { from: "parent", type: "reply", text: parsed.value.text, sessionId }, {
    supersede: parsed.value.supersede,
    outbox: { id: outboxId, targetKind: "child-delivery", target: deliveryTarget(parent.value), payload: { meta: parent.value, fullMessage: childMessage, targetKind: "child-delivery" } },
  });
  if (append.kind !== "ok") return append;
  acknowledgeParentReads(opened.value, dispatchId);
  const summary: SupersedeSummary = append.value.supersedeSummary as SupersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  const notification = await notifyChild(root, parent.value, dispatchId, processAdapter, environment, childMessage, outboxId).catch((error: unknown) => ({ outcome: "failed", reason: error instanceof Error ? `notification failed: ${error.message}` : "notification failed", transport: "failed" as const }));
  let transport = notification.transport ?? "failed";
  let supervisorRetry = false;
  if (transport === "queue") {
    const claim = claimOutbox(opened.value, outboxId, `${process.pid}:${randomUUID()}`, 30);
    if (claim.kind === "ok" && claim.value !== undefined) finishOutbox(opened.value, outboxId, "sent", "Codex queue delivery");
  } else if (transport === "deferred") {
    const scheduled = await startDeliveryWorker(root, dispatchId, outboxId, parent.value, processAdapter);
    transport = "deferred";
    supervisorRetry = scheduled === "failed";
  } else {
    const claim = claimOutbox(opened.value, outboxId, `${process.pid}:${randomUUID()}`, 30);
    if (claim.kind === "ok" && claim.value !== undefined) finishOutbox(opened.value, outboxId, "failed", notification.reason);
  }
  setDeliveryTransport(opened.value, dispatchId, append.value.seq, transport, notification.reason);
  if (state !== "done") {
    const updated = mutateDispatch(opened.value, dispatchId, (current) => ({ ...current, state: "running", updatedAt: new Date().toISOString() }));
    if (updated.kind !== "ok") return updated;
    if (parent.value.runtime === "tmux" && typeof parent.value.tmuxPane === "string") await setTmuxChatPane(parent.value.tmuxPane, String(parent.value.agent ?? "unknown"), String(parent.value.chatName ?? parent.value.branch ?? dispatchId), "running", processAdapter);
  }
  return ok(outputReply(dispatchId, parsed.value.json, notification.outcome === "delivered" ? "typed" : transport === "deferred" || supervisorRetry ? "supervisor" : "not-typed", summary));
}

export async function executeOrchestrateChange(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-change"));
  const parsed = parseParentChangeArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const database = stateDatabase(environment); if (database.kind !== "ok") return failed(database.error, database.exitCode);
  let dispatchId = parsed.value.dispatchId;
  const parent = await requireParent(database.value, dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  dispatchId = parent.value.dispatchId;
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "");
  const stateError = replyStateError(dispatchId, state, true); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const session = caller.id || caller.terminalId || "";
  const meta = parent.value;
  const directionInput = { dispatchId, chatName: String(meta.chatName ?? meta.branch ?? dispatchId), agent: String(meta.agent ?? "unknown"), type: "change", text: parsed.value.text, direction: "child-bound" as const, parentAgent: String(meta.parentAgent ?? "megabrain"), parentChatName: String(meta.parentChatName ?? "megabrain/main") };
  const formatted = formatFullDirection(directionInput, `Stop the approach you were on and follow this instead:\n${parsed.value.text}\n(The same text is available with megabrain check.)`);
  const oversized = meta.runtime === "tmux" && promptByteLength(formatted) > PROMPT_BUDGET_TMUX_BYTES;
  const deliveryText = oversized ? `${dispatchMessageHeader(directionInput)}\nA new direction is queued; run megabrain check to read it.` : formatted;
  const outboxId = `change-delivery-${randomUUID()}`;
  const appended = appendParentReply(database.value, dispatchId, { from: "parent", type: "reply", text: parsed.value.text, sessionId: session }, {
    supersede: true,
    outbox: { id: outboxId, targetKind: "child-delivery", target: deliveryTarget(meta), payload: { meta, dispatchId, targetKind: "child-delivery", fullMessage: deliveryText, pointerOnly: oversized, fullDirection: !oversized } },
  });
  if (appended.kind !== "ok") return appended;
  acknowledgeParentReads(database.value, dispatchId);
  const superseded = appended.value.supersedeSummary as SupersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  const updated = mutateDispatch(database.value, dispatchId, (current) => ({ ...current, state: "running", updatedAt: new Date().toISOString() }));
  if (updated.kind !== "ok") return updated;
  if (parent.value.runtime === "tmux" && typeof parent.value.tmuxPane === "string") await setTmuxChatPane(parent.value.tmuxPane, String(parent.value.agent ?? "unknown"), String(parent.value.chatName ?? parent.value.branch ?? dispatchId), "running", processAdapter);

  const timeoutMs = parsed.value.idleTimeout * 1000;
  const summary = { attempts: 0, idleReached: false, delivered: false, confirmed: false, superseded, oversized };
  const agent = typeof meta.agent === "string" ? meta.agent : "";
  const interrupted = await interruptChange(meta, processAdapter);
  summary.attempts = interrupted ? 1 : 0;
  if (interrupted && !(await agentOwnsForegroundProcess(agent, Number(meta.agentPid), processAdapter))) {
    setDeliveryTransport(database.value, dispatchId, appended.value.seq, "receiver-gone", "receiver-gone");
    return ok(changeOutput(dispatchId, parsed.value.json, { ...summary, reason: "receiver-gone: agent is no longer the terminal's foreground process" }));
  }
  const targetLeaseKey = `delivery-target:${deliveryTarget(meta)}`;
  const targetLeaseHolder = `change-${process.pid}-${randomUUID()}`;
  const targetLease = acquireLease(database.value, targetLeaseKey, targetLeaseHolder, Math.ceil(timeoutMs / 1000) + 30);
  let deliveryResult: Result<string> | undefined;
  if (targetLease.kind === "ok" && targetLease.value) {
    try {
      deliveryResult = await executeDeliveryWorker(
        [outboxId, targetLeaseHolder, targetLeaseKey, String(Date.now() + Math.max(timeoutMs, 1000)), "nested"],
        { ...environment, MEGABRAIN_STATE_DIR: root },
        processAdapter,
      );
    } finally {
      releaseLease(database.value, targetLeaseKey, targetLeaseHolder);
    }
  }
  const deliveredTransport = deliveryResult?.kind === "ok" && /delivery (?:socket|queue|typed|pointer)/.test(deliveryResult.value);
  const composerRecorded = await recordChangeEvent(root, dispatchId, "composer-clear", deliveredTransport ? "central delivery submitted; no foreign text cleared" : "central delivery did not submit the direction", session, environment, processAdapter);
  if (composerRecorded.kind !== "ok") return composerRecorded;
  summary.delivered = deliveredTransport;
  if (summary.delivered && !summary.oversized) setDeliveryTransport(database.value, dispatchId, appended.value.seq, "typed", "full-direction");
  const deliveryError = deliveryResult?.kind === "failed" ? deliveryResult.error : "delivery channel did not report a successful submission";
  const deliveryEvent = await recordChangeEvent(root, dispatchId, "delivery-result", summary.delivered ? `direction submitted${summary.oversized ? " as check pointer because it exceeded 12000 bytes" : ""}` : `direction not submitted: ${deliveryError}`, session, environment, processAdapter);
  if (deliveryEvent.kind !== "ok") return deliveryEvent;
  if (!summary.delivered) return ok(changeOutput(dispatchId, parsed.value.json, { ...summary, reason: `direction remains in the dispatch mailbox; ${deliveryError}` }));
  const confirmationScreen = await readDeliveryScreen(meta, processAdapter);
  summary.confirmed = confirmationScreen.kind === "ok" && classifyLiveness(agent, confirmationScreen.value).status === "working";
  const confirmed = await recordChangeEvent(root, dispatchId, "delivery-confirmation", `agent started working: ${summary.confirmed}`, session, environment, processAdapter);
  if (confirmed.kind !== "ok") return confirmed;
  return ok(changeOutput(dispatchId, parsed.value.json, summary));
}
