import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { finishOutboxPeerVerification, getDispatch, getOutboxPeerVerification, listDeliveries, listOutbox, markOutboxPeerSent, requeueOutboxPeerFallback, readOnlyStateDatabase } from "../../adapters/state-db.js";
import { claudeSessionPermissionClass, scanTranscript } from "../../agents/claude-peer.js";
import { resolveClaudeSession } from "../../agents/claude-session.js";
import { createDecisionLog } from "../../core/delivery-decision-log.js";
import { classifyLiveness } from "../../core/liveness.js";
import { composerReadback } from "../../core/composer-proof.js";
import { choosePeerChannel, CLAUDE_PEER_CHANNEL, deliverThroughClaudePeer, senderPermissionClass, verifyClaudePeerConsumption, type PeerChannelChoice, type PeerDeliveryOutcome } from "../../core/claude-peer-delivery.js";
import { formatDeliveryAcknowledgment, formatOneLine } from "../../core/chat-message-format.js";
import { deliverThroughGrokLeader, GROK_LEADER_CHANNEL } from "../../core/grok-leader-delivery.js";
import { AGY_LS_CHANNEL, deliverThroughAgyLanguageServer } from "../../core/agy-ls-delivery.js";
import { agyParentKey } from "../../agents/agy-ls.js";
import { deliverImmediately } from "../../core/idle-delivery.js";
import { deliverOperatorText } from "../../core/session-send.js";
import { sendSessionMessage, type SessionSendChannel } from "../../core/session-send.js";
import { deliverCodexQueue, findCodexProcessByThread } from "../../core/codex-delivery.js";
import { resolveStateDirectory } from "../../core/state.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { deliveryComposer, readDeliveryScreen } from "./delivery-screen.js";
import { startSupervisorWorker } from "./supervise.js";
import { agentOwnsForegroundProcess } from "../../core/terminal-process.js";
import { callStateOwner } from "../../db/state-owner.js";
import { recordChannelResultThroughOwner } from "../../db/state-owner.js";
import type { DatabaseHandle } from "../../db/db.js";

type Meta = Record<string, unknown>;
type WorkerEnvironment = Readonly<Record<string, string | undefined>>;
const DELIVERY_LEASE_SECONDS = 90;
const PROOF_UNAVAILABLE_MS = 2 * 60 * 1000;
const deliveryStatus = (status: ReturnType<typeof classifyLiveness>["status"]): "idle" | "busy" | "unknown" =>
  status === "idle" ? "idle" : status === "unknown" ? "unknown" : "busy";

type ClaudeStatus = Readonly<{ status: "idle" | "busy" | "unknown"; pid?: number; statusUpdatedAt?: number; reason?: string }>;

async function claudeStatus(meta: Meta, environment: WorkerEnvironment): Promise<ClaudeStatus | undefined> {
  const pid = Number(meta.agentPid);
  const sessionId = typeof meta.agentSessionId === "string" ? meta.agentSessionId : "";
  const home = environment.HOME;
  if (meta.agent !== "claude") return undefined;
  if (!home || sessionId === "") return { status: "unknown", reason: "Claude session identity is unavailable" };
  const session = await resolveClaudeSession(home, pid, sessionId);
  return session ?? { status: "unknown", reason: "no session file matched the recorded Claude session id" };
}

export function deliveryTarget(meta: Meta): string {
  if (meta.targetKind === "parent-pointer") {
    if (typeof meta.parentTmuxPane === "string" && meta.parentTmuxPane !== "") return `tmux:${String(meta.parentTmuxSession ?? "")}:${meta.parentTmuxPane}`;
    return `${String(meta.parentHost ?? "")}:${String(meta.parentTerminalId ?? meta.parentSessionId ?? "")}`;
  }
  return meta.runtime === "tmux"
    ? `tmux:${String(meta.tmuxSessionId ?? meta.tmuxSession ?? "")}:${String(meta.tmuxPane ?? "")}`
    : `${String(meta.childHost ?? "")}:${String(meta.terminalId ?? "")}`;
}

export async function startDeliveryWorker(root: string, dispatch: string, outboxId: string, meta: Meta, process: ProcessAdapter): Promise<"started" | "already-running" | "failed"> {
  void dispatch; void meta; void process;
  try {
    const result = await callStateOwner(root, { operation: "resume-outbox", id: outboxId }) as { scheduled?: boolean };
    return result.scheduled === true ? "started" : "already-running";
  } catch { return "failed"; }
}

// The channel to a Claude target, chosen from both permission classes before anything is sent. A
// Claude session's class is the mode its transcript last recorded, so a child or parent that left
// bypass is seen as it is; a child megabrain launched falls back to its launch line, and any other
// agent's class is unknown, never guessed.
async function peerChannelChoice(targetKind: string, meta: Meta, home: string): Promise<PeerChannelChoice | undefined> {
  const sessionClass = async (agent: unknown, sessionId: unknown) =>
    agent === "claude" && typeof sessionId === "string" ? claudeSessionPermissionClass(home, sessionId) : undefined;
  const launchClass = (agent: unknown) => typeof agent === "string" ? senderPermissionClass(agent) : undefined;
  if (targetKind === "parent-pointer") {
    const sender = await sessionClass(meta.agent, meta.agentSessionId) ?? launchClass(meta.agent);
    return choosePeerChannel(sender, await sessionClass(meta.parentAgent ?? meta.agent, meta.parentAgentSessionId));
  }
  if (targetKind !== "child-delivery") return undefined;
  const receiver = await sessionClass(meta.agent, meta.agentSessionId) ?? launchClass(meta.agent);
  return choosePeerChannel(await sessionClass(meta.parentAgent, meta.parentAgentSessionId), receiver);
}

async function readWasPulled(root: string, dispatch: string, sequence: number): Promise<boolean> {
  if (!existsSync(resolve(root, "megabrain.db"))) return true;
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return false;
  const deliveries = listDeliveries(database.value, dispatch);
  if (deliveries.kind !== "ok") return false;
  const row = deliveries.value.find((delivery) => Array.isArray(delivery.messageSeqs) && delivery.messageSeqs.includes(sequence));
  return row !== undefined && (row.status === "acknowledged" || row.status === "fenced" || row.transport === "checked");
}

async function sendTyped(
  meta: Meta,
  text: string,
  process: ProcessAdapter,
  fail: (reason: string) => void = () => undefined,
  recordReadback: (readback: Readonly<{ region?: string; orcaDraft?: string }>) => void = () => undefined,
): Promise<boolean> {
  const agent = String(meta.agent ?? "");
  const host = String(meta.childHost ?? "");
  const sent = await deliverOperatorText({
    agent, text,
    read: async () => {
      const screen = await readDeliveryScreen(meta, process);
      if (screen.kind !== "ok") return undefined;
      const observed = composerReadback(agent, screen.value);
      if (host === "orca") recordReadback({
        ...(observed.region === undefined ? {} : { region: observed.region.slice(0, 300) }),
        ...(observed.orcaDraft === undefined ? {} : { orcaDraft: observed.orcaDraft.slice(0, 300) }),
      });
      return screen.value;
    },
    send: async (value, enter) => {
      if (meta.runtime === "tmux") {
        if (value !== "") {
          const pasted = await getTmux().pasteText(String(meta.tmuxPane ?? ""), value, process, String(meta.tmuxSession ?? meta.tmuxSessionId ?? "") || undefined);
          if (pasted.kind !== "ok") return pasted.error;
        }
        if (enter) {
          const submitted = await getTmux().sendKey(String(meta.tmuxPane ?? ""), "Enter", process, String(meta.tmuxSession ?? meta.tmuxSessionId ?? "") || undefined);
          if (submitted.kind !== "ok") return submitted.error;
        }
        return "ok";
      }
      const provider = getHost(host);
      if (provider === undefined) return `unknown host ${host}`;
      const call = provider.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? ""), text: host === "orca" ? formatOneLine(value) : value, enter });
      if (call.kind !== "ok") return call.kind === "failed" ? call.error : call.reason;
      const result = await runHostSend(host, process, call.value);
      return result.kind === "ok" ? "ok" : result.kind === "failed" ? result.error : result.reason;
    },
  });
  if (!sent.delivered) { fail(sent.detail ?? "typed submit could not be verified"); return false; }
  return true;
}

async function clearOwnComposer(root: string, meta: Meta, process: ProcessAdapter): Promise<boolean> {
  if (meta.runtime === "tmux") return (await getTmux().sendKey(String(meta.tmuxPane ?? ""), "C-u", process)).kind === "ok";
  const host = String(meta.childHost ?? "");
  const provider = getHost(host);
  if (provider === undefined) return false;
  const call = provider.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? ""), text: "\u0015", enter: false });
  if (call.kind !== "ok") return false;
  return (await runHostSend(host, process, call.value)).kind === "ok";
}

export async function executeDeliveryWorker(args: readonly string[], environment: WorkerEnvironment, process: ProcessAdapter, ownerHandle?: DatabaseHandle): Promise<Result<string>> {
  const [outboxId, holder, leaseKey, deadlineValue, nestedValue] = args;
  if (!outboxId || !holder || !leaseKey || !deadlineValue) return failed("delivery worker requires outbox id, holder, lease key, and deadline", 2);
  const deadline = Number(deadlineValue);
  const nested = nestedValue === "nested";
  if (!Number.isSafeInteger(deadline)) return failed("delivery worker deadline is invalid", 2);
  const root = resolveStateDirectory(environment);
  if (!existsSync(resolve(root, "megabrain.db"))) return ok("delivery source state was removed\n");
  if (ownerHandle === undefined) return failed("delivery workers must run inside the state owner");
  const database = { kind: "ok" as const, value: ownerHandle };
  try { await callStateOwner(root, { operation: "settle-closed-parent-backlog" }); }
  catch (cause: unknown) { return failed(`state owner could not settle closed deliveries: ${cause instanceof Error ? cause.message : String(cause)}`); }
  let claimedValue: { targetKind: string; target: string; payload: unknown; dispatchId?: string | null } | undefined;
  try { claimedValue = await callStateOwner(root, { operation: "claim-outbox", id: outboxId, holder, leaseSeconds: DELIVERY_LEASE_SECONDS }) as typeof claimedValue; }
  catch (cause: unknown) { return failed(`state owner could not claim delivery: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (claimedValue === undefined) {
    if (!nested) await callStateOwner(root, { operation: "release-lease", key: leaseKey, holder }).catch(() => undefined);
    return ok("delivery already claimed\n");
  }
  let outboxLeaseLost = false;
  let renewalInFlight = false;
  const leaseHeartbeat = setInterval(() => {
    if (renewalInFlight || outboxLeaseLost) return;
    renewalInFlight = true;
    void callStateOwner(root, { operation: "renew-outbox", id: outboxId, holder, leaseSeconds: DELIVERY_LEASE_SECONDS })
      .then((renewed) => { if (renewed !== true) outboxLeaseLost = true; })
      .catch(() => { outboxLeaseLost = true; })
      .finally(() => { renewalInFlight = false; });
  }, DELIVERY_LEASE_SECONDS * 1000 / 3);
  leaseHeartbeat.unref();
  const outboxLeaseActive = (): boolean => !outboxLeaseLost;
  const targetKind = claimedValue.targetKind;
  const target = claimedValue.target;
  const payload = typeof claimedValue.payload === "object" && claimedValue.payload !== null ? claimedValue.payload as Meta : {};
  const dispatch = String(payload.dispatchId ?? claimedValue.dispatchId ?? "");
  const sequence = Number(payload.sequence ?? 0);
  const stored = dispatch === "" ? undefined : getDispatch(database.value, dispatch);
  const snapshotMeta = typeof payload.meta === "object" && payload.meta !== null ? payload.meta as Meta : {};
  const persistedMeta = { ...snapshotMeta, ...(stored?.kind === "ok" && stored.value ? stored.value : {}) };
  let meta = targetKind === "parent-pointer"
    ? {
      ...persistedMeta,
      runtime: typeof persistedMeta.parentTmuxPane === "string" ? "tmux" : "host",
      tmuxSession: persistedMeta.parentTmuxSession,
      tmuxPane: persistedMeta.parentTmuxPane,
      childHost: persistedMeta.parentHost,
      workspaceId: persistedMeta.parentWorkspaceId,
      terminalId: persistedMeta.parentTerminalId ?? persistedMeta.parentSessionId,
      agent: persistedMeta.parentAgent ?? persistedMeta.agent,
      agentPid: persistedMeta.parentAgentPid,
      agentSessionId: persistedMeta.parentAgentSessionId,
      grokLeaderSocket: persistedMeta.parentGrokLeaderSocket,
      grokSessionId: persistedMeta.parentGrokSessionId,
    }
    : persistedMeta;
  if (targetKind === "parent-pointer" && meta.runtime === "tmux" && typeof meta.tmuxSession !== "string") {
    const session = await getTmux().sessionForPane(String(meta.tmuxPane ?? ""), process);
    if (session.kind === "ok") meta = { ...meta, tmuxSession: session.value };
  }
  const rawText = typeof payload.fullMessage === "string" ? payload.fullMessage : "";
  const deliveryRows = dispatch === "" ? undefined : listDeliveries(database.value, dispatch);
  const delivery = deliveryRows?.kind === "ok" ? deliveryRows.value.find((row) => Array.isArray(row.messageSeqs) && row.messageSeqs.includes(sequence)) : undefined;
  const recipient = delivery?.recipient === "child" ? "child" : delivery === undefined ? undefined : "parent";
  const ackInstruction = delivery === undefined || recipient === undefined ? "" : `\n${formatDeliveryAcknowledgment(dispatch, delivery.id, recipient)}`;
  const text = `${rawText}${ackInstruction}`;
  const priorVerification = getOutboxPeerVerification(database.value, outboxId);
  const fallbackOnly = priorVerification.kind === "ok" && priorVerification.value?.state === "fallback-queued";
  const queueVerification = async (channel: string, messageId: string, agentVersion: string, transcript?: string, transcriptOffset?: number): Promise<void> => {
    if (!outboxLeaseActive()) return;
    const saved = markOutboxPeerSent(database.value, outboxId, holder, {
      state: "pending", messageId, agent: String(meta.agent ?? "unknown"), channel, agentVersion,
      acceptedAt: Date.now(), ...(transcript === undefined ? {} : { transcript, transcriptOffset }),
    });
    if (saved.kind !== "ok" || !saved.value) return;
    await callStateOwner(root, { operation: "resume-verification", id: outboxId });
    void startSupervisorWorker(root, environment, process).catch(() => undefined);
  };
  const pointer = typeof payload.pointer === "string" ? payload.pointer : "mail: megabrain check";
  let proofSource = "screen";
  let statusRead: "idle" | "busy" | "unknown" = "unknown";
  let statusUpdatedAtRead: number | undefined;
  let proofReason: string | undefined;
  let transport = "failed";
  let outcome = "failed";
  let receiverGone = false;
  let lastDecision: string | undefined;
  let sendError: string | undefined;
  let composerReadbackAfterSubmit: Readonly<{ region?: string; orcaDraft?: string }> | undefined;
  let screenDownSince: number | undefined;
  let screenError = "";
  const unavailableMs = Number(environment.MEGABRAIN_PROOF_UNAVAILABLE_MS);
  const giveUpAfterMs = Number.isFinite(unavailableMs) && unavailableMs > 0 ? unavailableMs : PROOF_UNAVAILABLE_MS;
  const decisionLog = createDecisionLog(root);
  const adoptClaudePid = async (status: ClaudeStatus | undefined): Promise<void> => {
    if (status?.pid === undefined || status.pid === Number(meta.agentPid)) return;
    const field = targetKind === "parent-pointer" ? "parentAgentPid" : "agentPid";
    await callStateOwner(root, { operation: "dispatch-patch", dispatchId: dispatch, patch: { [field]: status.pid } });
    meta = { ...meta, agentPid: status.pid };
  };
  // Transport order and message-id deduplication belong to the central session sender.
  let peer: PeerDeliveryOutcome | Readonly<{ kind: "aborted" }> | undefined;
  let peerChannel = CLAUDE_PEER_CHANNEL;
  const peerFallbackReason = (): string | undefined => peer?.kind === "fallback" ? peer.reason : undefined;
  const home = environment.HOME;
  const choice = home === undefined || meta.agent !== "claude" ? undefined : await peerChannelChoice(targetKind, persistedMeta, home);
  const direct = targetKind === "child-delivery" || targetKind === "parent-pointer";
  const localParent = targetKind === "parent-pointer" && meta.runtime === "host" && meta.childHost === "local";
  const threadId = targetKind === "parent-pointer" ? persistedMeta.parentAgentThreadId : persistedMeta.agentThreadId;
  const typed = async (): Promise<boolean | Readonly<{ delivered: boolean; stop?: boolean; detail?: string }>> => {
    if (!outboxLeaseActive()) return { delivered: false, stop: true, detail: "delivery lease was lost" };
    if (localParent || text === "" || dispatch === "" || sequence < 1) return false;
    const terminal = targetKind === "parent-pointer"
      ? { host: meta.parentHost, terminalId: meta.parentTerminalId ?? meta.parentSessionId, workspaceId: meta.parentWorkspaceId }
      : { host: meta.childHost, terminalId: meta.terminalId, workspaceId: meta.workspaceId };
    if (!(await agentOwnsForegroundProcess(String(meta.agent ?? ""), Number(meta.agentPid), process, terminal))) {
      receiverGone = true;
      outcome = "receiver-gone";
      transport = "receiver-gone";
      return { delivered: false, stop: true, detail: "receiver-gone: receiver is no longer the terminal's foreground agent process" };
    }
    let result: Awaited<ReturnType<typeof deliverImmediately>>;
    try {
      result = await deliverImmediately({
        timeoutMs: Math.max(0, deadline - Date.now()),
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        ownDraft: meta.childHost === "orca" ? formatOneLine(text) : text,
        inspect: async () => {
          const screen = await readDeliveryScreen(meta, process);
          const status = await claudeStatus(meta, environment);
          await adoptClaudePid(status);
          if (screen.kind !== "ok") {
            screenDownSince ??= Date.now();
            screenError = screen.kind === "failed" ? screen.error : screen.reason;
            const sessionProven = status?.pid !== undefined;
            proofSource = sessionProven ? "claude-session" : "screen-unavailable";
            statusRead = sessionProven && status.status !== "unknown" ? status.status : "unknown";
            statusUpdatedAtRead = status?.statusUpdatedAt;
            proofReason = `terminal screen unavailable: ${screenError}`;
            return statusRead;
          }
          screenDownSince = undefined;
          const screenStatus = deliveryStatus(classifyLiveness(String(meta.agent ?? ""), screen.value).status);
          const sessionProven = status?.pid !== undefined;
          proofSource = sessionProven ? "claude-session" : "screen";
          proofReason = status?.reason;
          const observed = sessionProven && status.status !== "unknown" ? status.status : screenStatus;
          statusRead = observed;
          statusUpdatedAtRead = status?.statusUpdatedAt;
          return observed;
        },
        composer: async () => {
          const screen = await readDeliveryScreen(meta, process);
          return screen.kind === "ok" ? deliveryComposer(String(meta.agent ?? ""), screen.value) : undefined;
        },
        clear: async () => clearOwnComposer(root, meta, process),
        send: async () => sendTyped(meta, text, process, (reason) => { sendError = reason; }, (readback) => { composerReadbackAfterSubmit = readback; }),
        sendError: () => sendError,
        isRead: async () => readWasPulled(root, dispatch, sequence),
        attempt: async (details) => {
          lastDecision = details.decision;
          await decisionLog.record({
            dispatchId: dispatch, outboxId, proofSource, status: statusRead,
            statusUpdatedAt: statusUpdatedAtRead ?? null, composer: details.composer, decision: details.decision,
            ...(proofReason === undefined ? {} : { proofReason }),
            ...(details.reason === undefined ? {} : { reason: details.reason }),
            ...(peerFallbackReason() === undefined ? {} : { peerFallback: peerFallbackReason() }),
            ...(details.decision === "send" && composerReadbackAfterSubmit !== undefined ? { composerReadback: composerReadbackAfterSubmit } : {}),
          });
        },
        record: async (value) => { outcome = value; },
      });
    } catch {
      result = "failed";
    }
    outcome = result;
    transport = result === "delivered" ? payload.pointerOnly === true ? "pointer" : "typed" : result === "cancelled" ? "checked" : "failed";
    if (fallbackOnly && result === "delivered") finishOutboxPeerVerification(database.value, outboxId, "fallback-delivered");
    return result === "delivered" ? true : result === "cancelled" ? { delivered: false, stop: true } : false;
  };
  const sent = await sendSessionMessage({
    caller: targetKind === "child-delivery" ? "reply" : "parent-notice",
    messageId: outboxId,
    target: { agent: String(meta.agent ?? "unknown"), id: `${root}:${dispatch}:${String(meta.agentSessionId ?? threadId ?? meta.tmuxPane ?? meta.terminalId ?? target)}` },
    text,
    channels: {
      "peer-socket": async () => {
        if (!outboxLeaseActive()) return { delivered: false, stop: true, detail: "delivery lease was lost" };
        if (fallbackOnly || choice?.kind !== "socket" || home === undefined || text === "" || dispatch === "" || sequence < 1 || typeof meta.agentSessionId !== "string") return false;
        try {
          peer = await deliverThroughClaudePeer({
            database: database.value, home, pid: Number(meta.agentPid), sessionId: meta.agentSessionId, text,
            ...(choice.senderMode === undefined ? {} : { senderMode: choice.senderMode }),
            isRead: async () => readWasPulled(root, dispatch, sequence),
            onAccepted: async (record) => {
              await queueVerification(CLAUDE_PEER_CHANNEL, record.messageId, record.agentVersion, record.transcript, record.transcriptOffset);
            },
          });
        } catch { peer = { kind: "aborted" }; }
        peerChannel = CLAUDE_PEER_CHANNEL;
        if (peer.kind === "accepted") { outcome = "verifying"; transport = "ack-verifying"; return true; }
        if (peer.kind === "delivered") { outcome = "delivered"; transport = "socket"; return true; }
        if (peer.kind === "read") { outcome = "cancelled"; transport = "checked"; return { delivered: false, stop: true }; }
        if (peer.kind === "aborted") return { delivered: false, stop: true, detail: "delivery lease was lost; refusing to risk a duplicate typed send" };
        return false;
      },
      "leader-socket": async () => {
        if (!outboxLeaseActive()) return { delivered: false, stop: true, detail: "delivery lease was lost" };
        if (fallbackOnly || !direct || meta.agent !== "grok" || typeof meta.grokLeaderSocket !== "string" || typeof meta.grokSessionId !== "string" || text === "") return false;
        peer = await deliverThroughGrokLeader({ database: database.value, socketPath: meta.grokLeaderSocket, sessionId: meta.grokSessionId, text });
        peerChannel = GROK_LEADER_CHANNEL;
        if (peer.kind !== "delivered") return false;
        await queueVerification(GROK_LEADER_CHANNEL, peer.msgId, peer.agentVersion ?? "unknown");
        outcome = "verifying"; transport = "ack-verifying"; return true;
      },
      "agy-language-server": async () => {
        if (!outboxLeaseActive()) return { delivered: false, stop: true, detail: "delivery lease was lost" };
        if (fallbackOnly || !direct || meta.agent !== "agy" || text === "" || dispatch === "" || sequence < 1) return false;
        try {
          peer = await deliverThroughAgyLanguageServer({
            database: database.value, stateRoot: root, endpointKey: targetKind === "parent-pointer" ? agyParentKey(dispatch) : dispatch,
            text, isRead: async () => readWasPulled(root, dispatch, sequence),
          });
        } catch { peer = { kind: "aborted" }; }
        peerChannel = AGY_LS_CHANNEL;
        if (peer?.kind === "delivered") { await queueVerification(AGY_LS_CHANNEL, peer.msgId, peer.agentVersion ?? "unknown"); outcome = "verifying"; transport = "ack-verifying"; return true; }
        if (peer?.kind === "read") { outcome = "cancelled"; transport = "checked"; return { delivered: false, stop: true }; }
        return false;
      },
      "codex-queue": async () => {
        if (!outboxLeaseActive()) return { delivered: false, stop: true, detail: "delivery lease was lost" };
        if (fallbackOnly || typeof threadId !== "string" || threadId === "" || text === "") return false;
        const found = await findCodexProcessByThread(threadId, process);
        if (!("pid" in found)) { peer = { kind: "fallback", reason: found.reason }; return false; }
        const queued = await deliverCodexQueue(threadId, found.pid, text, process);
        if (queued.kind !== "queued") { peer = { kind: "fallback", reason: queued.reason }; return false; }
        await queueVerification("codex-queue", outboxId, "unknown");
        outcome = "verifying"; transport = "ack-verifying"; return true;
      },
      typed,
    },
    recordChannel: async (channel: SessionSendChannel) => {
      if (channel === "typed") await recordChannelResultThroughOwner(root, { agent: String(meta.agent ?? "unknown"), channel, agentVersion: "unknown", ok: true });
    },
  });
  if (!outboxLeaseActive()) {
    clearInterval(leaseHeartbeat);
    console.error(`delivery outbox lease lost: ${outboxId}`);
    return ok("delivery lease lost\n");
  }
  if (peer !== undefined && (peer.kind === "delivered" || peer.kind === "accepted" || peer.kind === "read")) {
    await decisionLog.record({ dispatchId: dispatch, outboxId, channel: peerChannel, decision: peer.kind === "read" ? "cancelled" : peer.kind === "accepted" ? "ack-verifying" : "peer-delivered", ...(peer.kind === "read" ? {} : { msgId: peer.msgId }) });
  }
  const peerFallback = peerFallbackReason();
  if (!sent.delivered && outcome !== "cancelled" && !receiverGone) outcome = "failed";
  const unavailable = outcome === "unavailable";
  const untypable = localParent && peer?.kind !== "delivered" && peer?.kind !== "accepted" && peer?.kind !== "read" && peer?.kind !== "aborted";
  const reason = receiverGone ? "receiver-gone: receiver is no longer the terminal's foreground agent process" : untypable ? `local parent has no terminal to type into; the Stop hook and orchestrate watch surface it${peerFallback === undefined ? "" : ` (${peerFallback})`}` : unavailable ? `proof-unavailable: ${screenError}` : outcome === "failed" && lastDecision === "send-failed" && sendError !== undefined ? `send-failed: ${sendError}` : `deferred delivery ${outcome}`;
  await callStateOwner(root, { operation: "set-delivery-transport", dispatchId: dispatch, sequence, transport, reason: receiverGone ? "receiver-gone" : unavailable ? "proof-unavailable" : payload.fullDirection === true && !["failed", "deferred"].includes(transport) ? "full-direction" : undefined });
  const finished = targetKind === "parent-pointer"
    ? await callStateOwner(root, { operation: "finish-notification", id: outboxId, holder, status: transport === "failed" || receiverGone ? "failed" : transport === "deferred" ? "suppressed" : "sent", event: { dispatchId: dispatch, pointer, outcome, reason } })
    : await callStateOwner(root, { operation: "finish-outbox", id: outboxId, holder, status: transport === "failed" || receiverGone ? "failed" : transport === "deferred" ? "suppressed" : "sent", detail: reason });
  if (finished !== true) {
    clearInterval(leaseHeartbeat);
    console.error(`delivery outbox lease lost before finish: ${outboxId}`);
    return ok("delivery lease lost\n");
  }
  if (!nested) {
    const quietDeadline = Math.min(deadline, Date.now() + 1000);
    while (Date.now() < quietDeadline) {
      const pending = listOutbox(database.value);
      if (pending.kind !== "ok") break;
      const next = pending.value.find((item) => item.target === target && item.status === "pending");
      if (next !== undefined) {
        await executeDeliveryWorker([next.id, holder, leaseKey, String(deadline), "nested"], environment, process, ownerHandle);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await callStateOwner(root, { operation: "release-lease", key: leaseKey, holder }).catch(() => undefined);
  }
  clearInterval(leaseHeartbeat);
  return ok(`delivery ${transport}\n`);
}

export async function executeDeliveryVerificationWorker(args: readonly string[], environment: WorkerEnvironment, process: ProcessAdapter, ownerHandle?: DatabaseHandle): Promise<Result<string>> {
  const [outboxId] = args;
  if (!outboxId) return failed("delivery verification worker requires an outbox id", 2);
  const root = resolveStateDirectory(environment);
  if (ownerHandle === undefined) return failed("delivery verification workers must run inside the state owner");
  const database = { kind: "ok" as const, value: ownerHandle };
  try { await callStateOwner(root, { operation: "settle-closed-parent-backlog" }); }
  catch (cause: unknown) { return failed(`state owner could not settle closed deliveries: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const saved = getOutboxPeerVerification(database.value, outboxId);
  if (saved.kind !== "ok" || saved.value === undefined || saved.value.state !== "pending") return ok("peer verification is already settled\n");
  const rows = listOutbox(database.value);
  if (rows.kind !== "ok") return rows;
  const outbox = rows.value.find((item) => item.id === outboxId);
  if (outbox === undefined || outbox.dispatchId === null) return failed(`delivery verification outbox item not found: ${outboxId}`);
  const payload = typeof outbox.payload === "object" && outbox.payload !== null ? outbox.payload as Meta : {};
  const dispatch = String(payload.dispatchId ?? outbox.dispatchId);
  const sequence = Number(payload.sequence ?? 0);
  const meta = typeof payload.meta === "object" && payload.meta !== null ? payload.meta as Meta : {};
  const home = environment.HOME ?? "";
  const parentTarget = outbox.targetKind === "parent-pointer";
  const receiverAgent = String(parentTarget ? meta.parentAgent ?? meta.agent : meta.agent ?? "unknown");
  const sessionId = String(parentTarget ? meta.parentAgentSessionId ?? "" : meta.agentSessionId ?? "");
  const pid = Number(parentTarget ? meta.parentAgentPid ?? 0 : meta.agentPid ?? 0);
  const deliveries = listDeliveries(database.value, dispatch);
  if (deliveries.kind !== "ok") return deliveries;
  const delivery = deliveries.value.find((item) => Array.isArray(item.messageSeqs) && item.messageSeqs.includes(sequence));
  if (delivery === undefined) return failed(`delivery verification delivery row not found for ${outboxId}`);
  const verifierLeaseKey = `delivery-verification:${outboxId}`;
  const verifierHolder = `${globalThis.process.pid}-${randomUUID()}`;
  const verifierLease = await callStateOwner(root, { operation: "acquire-lease", key: verifierLeaseKey, holder: verifierHolder, seconds: 90 }).catch(() => false) as boolean;
  if (!verifierLease) return ok("peer verification is already running\n");
  try {
  const result = await verifyClaudePeerConsumption({
    heartbeat: async () => await callStateOwner(root, { operation: "acquire-lease", key: verifierLeaseKey, holder: verifierHolder, seconds: 90 }).catch(() => false) as boolean,
    acknowledged: async () => {
      const current = listDeliveries(database.value, dispatch);
      return current.kind === "ok" && current.value.some((item) => item.id === delivery.id && item.status === "acknowledged");
    },
    status: async () => {
      if (receiverAgent !== "claude") return "idle";
      const current = await resolveClaudeSession(home, pid, sessionId);
      return current === undefined ? "ended" : current.status === "idle" ? "idle" : "busy";
    },
    scan: async () => saved.value!.transcript === undefined || saved.value!.transcriptOffset === undefined
      ? undefined
      : (await scanTranscript(saved.value!.transcript, saved.value!.transcriptOffset, saved.value!.messageId)).seen,
    sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    fallback: async () => {
      if (saved.value!.agent === "claude") await recordChannelResultThroughOwner(root, { agent: saved.value!.agent, channel: saved.value!.channel, agentVersion: saved.value!.agentVersion, ok: false, error: `peer message ${saved.value!.messageId} was not acknowledged or consumed`, now: Date.now() });
      const queued = requeueOutboxPeerFallback(database.value, outboxId);
      if (queued.kind !== "ok" || !queued.value) return;
      const retryMeta = { ...meta, ...payload, targetKind: outbox.targetKind, dispatchId: dispatch };
      await startDeliveryWorker(root, dispatch, outboxId, retryMeta, process);
    },
  });
  if (result === "lost") {
    console.error(`delivery verifier lease lost: ${outboxId}`);
    return ok("peer verification lease lost\n");
  }
  if (result === "delivered") {
    if (delivery.recipient === "child" || delivery.recipient === "parent") await callStateOwner(root, { operation: "ack-implicit-delivery", dispatchId: dispatch, deliveryId: delivery.id, recipient: delivery.recipient });
    await recordChannelResultThroughOwner(root, { agent: saved.value.agent, channel: saved.value.channel, agentVersion: saved.value.agentVersion, ok: true });
    finishOutboxPeerVerification(database.value, outboxId, "delivered");
    await callStateOwner(root, { operation: "set-delivery-transport", dispatchId: dispatch, sequence, transport: "acknowledged" });
  }
  return ok(`peer verification ${result}\n`);
  } finally {
    await callStateOwner(root, { operation: "release-lease", key: verifierLeaseKey, holder: verifierHolder }).catch(() => undefined);
  }
}
