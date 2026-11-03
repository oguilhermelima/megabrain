import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { normalizeDispatchState, parseParentChangeArgs, parseParentReplyArgs, replyStateError, type SupersedeSummary } from "../../core/parent-reply.js";
import { classifyLiveness } from "../../core/liveness.js";
import { resolveCaller, appendMessage, type QueueEnvironment } from "./queue-write.js";
import { getOutbox, getOutboxPeerVerification, listDeliveries, type OutboxDetails } from "../../adapters/state-db.js";
import { deliveryTarget } from "./delivery-worker.js";
import { randomUUID } from "node:crypto";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { readDeliveryScreen } from "./delivery-screen.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { readOnlyStateDatabase, getDispatch, listDispatches } from "../../adapters/state-db.js";
import type { DatabaseHandle } from "../../db/db.js";
import { PROMPT_BUDGET_TMUX_BYTES, promptByteLength } from "../../core/prompt-budget.js";
import { composerReadback } from "../../core/composer-proof.js";
import { dispatchMessageHeader, formatDispatchMessage, formatFullDirection } from "../../core/chat-message-format.js";
import { setTmuxChatPane } from "../../core/chat-pane.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";
import { callStateOwner } from "../../db/state-owner.js";
import { interruptKey } from "../../agents/index.js";
import { agentOwnsForegroundProcess } from "../../core/terminal-process.js";
import { withNextOrchestrationStep } from "../../core/orchestration-next.js";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function changeOutput(dispatch: string, json: boolean, value: {
  attempts: number;
  interrupted: boolean;
  idleReached: boolean;
  delivered: boolean;
  confirmed: boolean;
  superseded: SupersedeSummary;
  oversized: boolean;
  reason?: string;
}): string {
  if (json) {
    const receipt = { dispatchId: dispatch, queueChanged: true, interrupted: value.interrupted, status: value.delivered ? value.confirmed ? "delivered" : "delivered-unconfirmed" : "queued", attempts: value.attempts, idleReached: value.idleReached, delivered: value.delivered, confirmed: value.confirmed, supersededQueued: value.superseded.queued, supersededDelivered: value.superseded.delivered, deliveredSequences: value.superseded.deliveredSequences, oversized: value.oversized, ...(value.reason === undefined ? {} : { reason: value.reason }) };
    return `${JSON.stringify(withNextOrchestrationStep("change", receipt, receipt), null, 2)}\n`;
  }
  return `changed: ${dispatch}\nattempts: ${value.attempts}\nidle reached: ${value.idleReached}\ndelivered: ${value.delivered ? value.confirmed ? "yes (confirmed)" : "yes (unconfirmed)" : "no"}\nsuperseded queued: ${value.superseded.queued}\nsuperseded delivered: ${value.superseded.delivered}\n${value.oversized ? "direction exceeded the tmux limit; sent a megabrain check pointer\n" : ""}${value.reason === undefined ? "" : `${value.reason}\n`}`;
}

async function recordChangeEvent(root: string, dispatch: string, type: string, text: string, session: string, env: QueueEnvironment, process: ProcessAdapter): Promise<Result<void>> {
  const appended = await appendMessage(root, dispatch, "parent", type, text, session, env, process);
  return appended.kind === "ok" ? ok(undefined) : appended;
}

async function interruptChangeReceiver(meta: JsonRecord, screen: string, process: ProcessAdapter): Promise<boolean> {
  const key = interruptKey(String(meta.agent ?? ""), screen);
  if (key.kind !== "ok") return false;
  if (meta.runtime === "tmux") return (await getTmux().sendKey(String(meta.tmuxPane ?? ""), key.value, process)).kind === "ok";
  const host = String(meta.childHost ?? "");
  const provider = getHost(host);
  const request = provider?.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? ""), text: key.value === "Escape" ? "\u001b" : "\u0003", enter: false });
  return request?.kind === "ok" && (await runHostSend(host, process, request.value)).kind === "ok";
}

async function requireParent(database: DatabaseHandle, dispatch: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<JsonRecord & { dispatchId: string }>> {
  const current = await resolveCaller(environment, processAdapter);
  const resolved = resolveParentDispatchId(database, dispatch);
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

type ReplyDeliveryResult = Readonly<{ status: "delivered"; channel: string }> | Readonly<{ status: "queued-for-check" }> | Readonly<{ status: "failed"; reason: string }>;

function replyDeliveryResult(database: DatabaseHandle, dispatchId: string, sequence: number, outbox: OutboxDetails): ReplyDeliveryResult {
  const deliveries = listDeliveries(database, dispatchId);
  const delivery = deliveries.kind === "ok" ? deliveries.value.find((item) => Array.isArray(item.messageSeqs) && item.messageSeqs.includes(sequence)) : undefined;
  if (outbox.status === "failed" && delivery === undefined) return { status: "failed", reason: outbox.detail ?? "delivery worker failed without a reason" };
  if (outbox.status === "failed" && delivery?.status !== "outstanding") return { status: "failed", reason: outbox.detail ?? "delivery worker failed without a reason" };
  const transport = String(delivery?.transport ?? "");
  if (transport === "typed" || transport === "queue") return { status: "delivered", channel: transport };
  if (transport === "socket") return { status: "delivered", channel: "peer-socket" };
  if (transport === "pointer") return { status: "delivered", channel: "pointer" };
  const peer = getOutboxPeerVerification(database, outbox.id);
  if (peer.kind === "ok" && peer.value !== undefined && ["pending", "delivered"].includes(peer.value.state)) return { status: "delivered", channel: peer.value.channel };
  return { status: "queued-for-check" };
}

function outputReply(dispatch: string, json: boolean, summary: SupersedeSummary, delivery: ReplyDeliveryResult): string {
  const nudge = delivery.status === "delivered" ? delivery.channel : delivery.status === "failed" ? "failed" : "not-typed";
  if (json) {
    const receipt = { dispatchId: dispatch, status: "queued", nudge, delivery, supersededQueued: summary.queued, supersededDelivered: summary.delivered, deliveredSequences: summary.deliveredSequences };
    return `${JSON.stringify(withNextOrchestrationStep("reply", { delivery: delivery.status }, receipt), null, 2)}\n`;
  }
  const deliveryLine = delivery.status === "delivered"
    ? `delivery: delivered via ${delivery.channel}\n`
    : delivery.status === "failed"
      ? `delivery: failed — ${delivery.reason}\n`
      : "delivery: queued for the child's next check\n";
  return `queued: ${dispatch}\n${deliveryLine}${summary.queued > 0 || summary.delivered > 0 ? `superseded queued: ${summary.queued}\nsuperseded delivered: ${summary.delivered}\n` : ""}`;
}

export async function executeOrchestrateReply(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-reply"));
  const parsed = parseParentReplyArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const opened = readOnlyStateDatabase(environment); if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  let dispatchId = parsed.value.dispatchId;
  const parent = await requireParent(opened.value, dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  dispatchId = parent.value.dispatchId;
  // The shell normalizes a persisted "stalled"/"timeout" state to "running" on every meta read
  // (megabrain_dispatch_meta_normalize), before the reply's own state check ever runs — so it,
  // and the "state !== done" guard below that decides whether to resume the dispatch, both see
  // the normalized value, never the raw legacy one.
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "", parent.value);
  const stateError = replyStateError(dispatchId, state, false); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const sessionId = caller.id || caller.terminalId || "";
  const childMessage = formatDispatchMessage({ dispatchId: dispatchId, chatName: String(parent.value.chatName ?? parent.value.branch ?? dispatchId), agent: String(parent.value.agent ?? "unknown"), type: "reply", text: parsed.value.text, direction: "child-bound", parentAgent: String(parent.value.parentAgent ?? "megabrain"), parentChatName: String(parent.value.parentChatName ?? "megabrain/main") });
  const outboxId = `delivery-${randomUUID()}`;
  let append: { seq: number; supersedeSummary?: SupersedeSummary };
  try {
    append = await callStateOwner(root, { operation: "append-parent-reply", dispatchId, message: { from: "parent", type: "reply", text: parsed.value.text, sessionId }, options: {
      supersede: parsed.value.supersede,
      outbox: { id: outboxId, targetKind: "child-delivery", target: deliveryTarget(parent.value), payload: { meta: parent.value, fullMessage: childMessage, targetKind: "child-delivery" } },
    } }) as typeof append;
  } catch (cause: unknown) { return failed(`state owner reply write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const summary: SupersedeSummary = append.supersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  if (state !== "done") {
    await callStateOwner(root, { operation: "dispatch-patch", dispatchId, patch: { state: "running", updatedAt: new Date().toISOString() } });
    if (parent.value.runtime === "tmux" && typeof parent.value.tmuxPane === "string") await setTmuxChatPane(parent.value.tmuxPane, String(parent.value.agent ?? "unknown"), String(parent.value.chatName ?? parent.value.branch ?? dispatchId), "running", processAdapter);
  }
  const deliveryDeadline = Date.now() + 1_000;
  let delivery: ReplyDeliveryResult = { status: "queued-for-check" };
  while (true) {
    const itemResult = getOutbox(opened.value, outboxId);
    const item = itemResult.kind === "ok" ? itemResult.value : undefined;
    if (item !== undefined && item.status !== "pending" && item.status !== "sending") {
      delivery = replyDeliveryResult(opened.value, dispatchId, append.seq, item);
      break;
    }
    if (Date.now() >= deliveryDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, deliveryDeadline - Date.now())));
  }
  return ok(outputReply(dispatchId, parsed.value.json, summary, delivery));
}

export async function executeOrchestrateChange(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-change"));
  const parsed = parseParentChangeArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const database = readOnlyStateDatabase(environment); if (database.kind !== "ok") return failed(database.error, database.exitCode);
  let dispatchId = parsed.value.dispatchId;
  const parent = await requireParent(database.value, dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  dispatchId = parent.value.dispatchId;
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "", parent.value);
  const stateError = replyStateError(dispatchId, state, true); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const session = caller.id || caller.terminalId || "";
  const meta = parent.value;
  const directionInput = { dispatchId, chatName: String(meta.chatName ?? meta.branch ?? dispatchId), agent: String(meta.agent ?? "unknown"), type: "change", text: parsed.value.text, direction: "child-bound" as const, parentAgent: String(meta.parentAgent ?? "megabrain"), parentChatName: String(meta.parentChatName ?? "megabrain/main") };
  const agent = typeof meta.agent === "string" ? meta.agent : "";
  const initialScreen = await readDeliveryScreen(meta, processAdapter);
  const initialText = initialScreen.kind === "ok" ? initialScreen.value : "";
  const initialDraft = composerReadback(agent, initialText).region?.trim();
  const hasForeignDraft = meta.runtime === "tmux" && initialDraft !== undefined && initialDraft !== "" && initialDraft !== "Ask Codex to do anything";
  const shouldInterrupt = meta.runtime === "host" && meta.childHost === "orca";
  let interrupted = shouldInterrupt && await interruptChangeReceiver(meta, initialText, processAdapter);
  if (interrupted && meta.runtime === "host" && meta.childHost === "orca" && !(await agentOwnsForegroundProcess(agent, Number(meta.agentPid), processAdapter))) {
    return ok(changeOutput(dispatchId, parsed.value.json, { attempts: 0, interrupted: true, idleReached: false, delivered: false, confirmed: false, superseded: { queued: 0, delivered: 0, deliveredSequences: [] }, oversized: false, reason: "receiver-gone: agent is no longer the terminal's foreground process" }));
  }
  const formatted = formatFullDirection(directionInput, `Stop the approach you were on and follow this instead:\n${parsed.value.text}\n(The same text is available with megabrain check.)`);
  const oversized = meta.runtime === "tmux" && promptByteLength(formatted) > PROMPT_BUDGET_TMUX_BYTES;
  const deliveryText = oversized ? `${dispatchMessageHeader(directionInput)}\nA new direction is queued; run megabrain check to read it.` : formatted;
  const outboxId = `change-delivery-${randomUUID()}`;
  let appended: { seq: number; supersedeSummary?: SupersedeSummary };
  try {
    appended = await callStateOwner(root, { operation: "append-parent-reply", dispatchId, message: { from: "parent", type: "reply", text: parsed.value.text, sessionId: session }, options: {
      supersede: true,
      outbox: { id: outboxId, targetKind: "child-delivery", target: deliveryTarget(meta), payload: { meta, dispatchId, targetKind: "child-delivery", fullMessage: deliveryText, pointerOnly: oversized, fullDirection: !oversized } },
    } }) as typeof appended;
  } catch (cause: unknown) { return failed(`state owner change write failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const superseded = appended.supersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  await callStateOwner(root, { operation: "dispatch-patch", dispatchId, patch: { state: "running", updatedAt: new Date().toISOString() } });
  if (parent.value.runtime === "tmux" && typeof parent.value.tmuxPane === "string") await setTmuxChatPane(parent.value.tmuxPane, String(parent.value.agent ?? "unknown"), String(parent.value.chatName ?? parent.value.branch ?? dispatchId), "running", processAdapter);

  const timeoutMs = parsed.value.idleTimeout * 1000;
  const summary = { attempts: 0, interrupted, idleReached: false, delivered: false, confirmed: false, superseded, oversized };
  await callStateOwner(root, { operation: "resume-outbox", id: outboxId });
  const deliveryDeadline = Date.now() + Math.max(timeoutMs, 1000);
  let outboxItem: OutboxDetails | undefined;
  while (Date.now() < deliveryDeadline) {
    const listed = getOutbox(database.value, outboxId);
    if (listed.kind === "ok") {
      outboxItem = listed.value;
      if (outboxItem !== undefined && outboxItem.status !== "pending" && outboxItem.status !== "sending") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const deliveryRows = listDeliveries(database.value, dispatchId);
  const deliveredTransport = deliveryRows.kind === "ok" && deliveryRows.value.some((delivery) => Array.isArray(delivery.messageSeqs) && delivery.messageSeqs.includes(appended.seq) && ["socket", "queue", "typed", "pointer", "ack-verifying"].includes(String(delivery.transport)));
  const composerRecorded = await recordChangeEvent(root, dispatchId, "composer-clear", deliveredTransport ? "central delivery submitted; no foreign text cleared" : "central delivery did not submit the direction", session, environment, processAdapter);
  if (composerRecorded.kind !== "ok") return composerRecorded;
  summary.delivered = deliveredTransport;
  summary.attempts = outboxItem?.attempts ?? 0;
  if (summary.delivered && hasForeignDraft && !interrupted) {
    interrupted = await interruptChangeReceiver(meta, initialText, processAdapter);
    summary.interrupted = interrupted;
  }
  const deliveryError = outboxItem?.detail ?? "delivery channel did not report a successful submission";
  const deliveryEvent = await recordChangeEvent(root, dispatchId, "delivery-result", summary.delivered ? `direction submitted${summary.oversized ? " as check pointer because it exceeded 12000 bytes" : ""}` : `direction not submitted: ${deliveryError}`, session, environment, processAdapter);
  if (deliveryEvent.kind !== "ok") return deliveryEvent;
  if (!summary.delivered) return ok(changeOutput(dispatchId, parsed.value.json, { ...summary, reason: `direction remains in the dispatch mailbox; ${deliveryError}` }));
  const confirmationScreen = await readDeliveryScreen(meta, processAdapter);
  summary.confirmed = confirmationScreen.kind === "ok" && classifyLiveness(agent, confirmationScreen.value).status === "working";
  const confirmed = await recordChangeEvent(root, dispatchId, "delivery-confirmation", `agent started working: ${summary.confirmed}`, session, environment, processAdapter);
  if (confirmed.kind !== "ok") return confirmed;
  return ok(changeOutput(dispatchId, parsed.value.json, summary));
}
