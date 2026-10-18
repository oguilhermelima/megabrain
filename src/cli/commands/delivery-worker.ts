import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { acquireLease, claimOutbox, finishNotification, finishOutbox, finishOutboxPeerVerification, getDispatch, getOutboxPeerVerification, listDeliveries, listOutbox, markOutboxPeerSent, mutateDispatch, recordChannelResult, releaseLease, requeueOutboxPeerFallback, setDeliveryTransport, stateDatabase } from "../../adapters/state-db.js";
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
import { deliverImmediately, startDeferredDelivery } from "../../core/idle-delivery.js";
import { deliverOperatorText } from "../../core/session-send.js";
import { sendSessionMessage, type SessionSendChannel } from "../../core/session-send.js";
import { deliverCodexQueue, findCodexProcessByThread } from "../../core/codex-delivery.js";
import { resolveStateDirectory } from "../../core/state.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux } from "../../hosts/tmux.js";
import { deliveryComposer, readDeliveryScreen } from "./delivery-screen.js";
import { selfInvocation } from "../../core/self-invocation.js";
import { startSupervisorWorker } from "./supervise.js";

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
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return "failed";
  const target = deliveryTarget(meta);
  const holder = `${globalThis.process.pid}-${randomUUID()}`;
  const leaseKey = `delivery-target:${target}`;
  // Keep waiting without a deadline; the live worker renews this short lease while it waits.
  const deadline = Number.MAX_SAFE_INTEGER;
  const result = await startDeferredDelivery(
    target,
    holder,
    async (key, owner) => {
      const acquired = acquireLease(database.value, `delivery-target:${key}`, owner, DELIVERY_LEASE_SECONDS);
      return acquired.kind === "ok" && acquired.value;
    },
    async (owner) => {
      const worker = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["__delivery-worker", outboxId, owner, leaseKey, String(deadline)]);
      const started = await process.startDetached(worker.command, worker.args);
      return started.kind === "ok";
    },
    async (_key, owner) => { releaseLease(database.value, leaseKey, owner); },
  );
  return result;
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
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
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

export async function executeDeliveryWorker(args: readonly string[], environment: WorkerEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  const [outboxId, holder, leaseKey, deadlineValue, nestedValue] = args;
  if (!outboxId || !holder || !leaseKey || !deadlineValue) return failed("delivery worker requires outbox id, holder, lease key, and deadline", 2);
  const deadline = Number(deadlineValue);
  const nested = nestedValue === "nested";
  if (!Number.isSafeInteger(deadline)) return failed("delivery worker deadline is invalid", 2);
  const root = resolveStateDirectory(environment);
  if (!existsSync(resolve(root, "megabrain.db"))) return ok("delivery source state was removed\n");
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const claimed = claimOutbox(database.value, outboxId, holder, DELIVERY_LEASE_SECONDS);
  if (claimed.kind !== "ok" || claimed.value === undefined) {
    if (!nested) releaseLease(database.value, leaseKey, holder);
    return claimed.kind === "ok" ? ok("delivery already claimed\n") : claimed;
  }
  const targetKind = claimed.value.targetKind;
  const target = claimed.value.target;
  const payload = typeof claimed.value.payload === "object" && claimed.value.payload !== null ? claimed.value.payload as Meta : {};
  const dispatch = String(payload.dispatchId ?? claimed.value.dispatchId ?? "");
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
  const pointer = typeof payload.pointer === "string" ? payload.pointer : "mail: megabrain check";
  let proofSource = "screen";
  let statusRead: "idle" | "busy" | "unknown" = "unknown";
  let statusUpdatedAtRead: number | undefined;
  let proofReason: string | undefined;
  let transport = "failed";
  let outcome = "failed";
  let lastDecision: string | undefined;
  let sendError: string | undefined;
  let composerReadbackAfterSubmit: Readonly<{ region?: string; orcaDraft?: string }> | undefined;
  let screenDownSince: number | undefined;
  let screenError = "";
  const unavailableMs = Number(environment.MEGABRAIN_PROOF_UNAVAILABLE_MS);
  const giveUpAfterMs = Number.isFinite(unavailableMs) && unavailableMs > 0 ? unavailableMs : PROOF_UNAVAILABLE_MS;
  const decisionLog = createDecisionLog(root);
  const adoptClaudePid = (status: ClaudeStatus | undefined): void => {
    if (status?.pid === undefined || status.pid === Number(meta.agentPid)) return;
    const field = targetKind === "parent-pointer" ? "parentAgentPid" : "agentPid";
    mutateDispatch(database.value, dispatch, () => ({ [field]: status.pid }));
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
    if (localParent || text === "" || dispatch === "" || sequence < 1) return false;
    let result: Awaited<ReturnType<typeof deliverImmediately>>;
    try {
      result = await deliverImmediately({
        timeoutMs: Math.max(0, deadline - Date.now()),
        initialDelayMs: 500,
        maxDelayMs: 10_000,
        ownDraft: text,
        inspect: async () => {
          const screen = await readDeliveryScreen(meta, process);
          const status = await claudeStatus(meta, environment);
          adoptClaudePid(status);
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
    return result === "delivered" ? true : result === "cancelled" ? { delivered: false, stop: true } : false;
  };
  const sent = await sendSessionMessage({
    caller: targetKind === "child-delivery" ? "reply" : "parent-notice",
    messageId: outboxId,
    target: { agent: String(meta.agent ?? "unknown"), id: `${root}:${dispatch}:${String(meta.agentSessionId ?? threadId ?? meta.tmuxPane ?? meta.terminalId ?? target)}` },
    text,
    channels: {
      "peer-socket": async () => {
        if (choice?.kind !== "socket" || home === undefined || text === "" || dispatch === "" || sequence < 1 || typeof meta.agentSessionId !== "string") return false;
        try {
          peer = await deliverThroughClaudePeer({
            database: database.value, home, pid: Number(meta.agentPid), sessionId: meta.agentSessionId, text,
            ...(choice.senderMode === undefined ? {} : { senderMode: choice.senderMode }),
            isRead: async () => readWasPulled(root, dispatch, sequence),
            onAccepted: async (record) => {
              const saved = markOutboxPeerSent(database.value, outboxId, holder, { ...record, state: "pending" });
              if (saved.kind !== "ok" || !saved.value) return;
              const verifier = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["__peer-verify", outboxId]);
              await process.startDetached(verifier.command, verifier.args);
              await startSupervisorWorker(root, environment, process);
            },
          });
        } catch { peer = { kind: "aborted" }; }
        peerChannel = CLAUDE_PEER_CHANNEL;
        if (peer.kind === "accepted") { outcome = "verifying"; transport = "peer-verifying"; return true; }
        if (peer.kind === "delivered") { outcome = "delivered"; transport = "socket"; return true; }
        if (peer.kind === "read") { outcome = "cancelled"; transport = "checked"; return { delivered: false, stop: true }; }
        if (peer.kind === "aborted") return { delivered: false, stop: true, detail: "delivery lease was lost; refusing to risk a duplicate typed send" };
        return false;
      },
      "leader-socket": async () => {
        if (!direct || meta.agent !== "grok" || typeof meta.grokLeaderSocket !== "string" || typeof meta.grokSessionId !== "string" || text === "") return false;
        peer = await deliverThroughGrokLeader({ database: database.value, socketPath: meta.grokLeaderSocket, sessionId: meta.grokSessionId, text });
        peerChannel = GROK_LEADER_CHANNEL;
        if (peer.kind !== "delivered") return false;
        outcome = "delivered"; transport = "socket"; return true;
      },
      "agy-language-server": async () => {
        if (!direct || meta.agent !== "agy" || text === "" || dispatch === "" || sequence < 1) return false;
        try {
          peer = await deliverThroughAgyLanguageServer({
            database: database.value, stateRoot: root, endpointKey: targetKind === "parent-pointer" ? agyParentKey(dispatch) : dispatch,
            text, isRead: async () => readWasPulled(root, dispatch, sequence),
          });
        } catch { peer = { kind: "aborted" }; }
        peerChannel = AGY_LS_CHANNEL;
        if (peer?.kind === "delivered") { outcome = "delivered"; transport = "socket"; return true; }
        if (peer?.kind === "read") { outcome = "cancelled"; transport = "checked"; return { delivered: false, stop: true }; }
        return false;
      },
      "codex-queue": async () => {
        if (typeof threadId !== "string" || threadId === "" || text === "") return false;
        const found = await findCodexProcessByThread(threadId, process);
        if (!("pid" in found)) { peer = { kind: "fallback", reason: found.reason }; return false; }
        const queued = await deliverCodexQueue(threadId, found.pid, text, process);
        if (queued.kind !== "queued") { peer = { kind: "fallback", reason: queued.reason }; return false; }
        outcome = "delivered"; transport = "queue"; return true;
      },
      typed,
    },
    recordChannel: async (channel: SessionSendChannel) => {
      if (channel === "typed" || channel === "codex-queue") recordChannelResult(database.value, { agent: String(meta.agent ?? "unknown"), channel, agentVersion: "unknown", ok: true });
    },
  });
  if (peer !== undefined && (peer.kind === "delivered" || peer.kind === "accepted" || peer.kind === "read")) {
    await decisionLog.record({ dispatchId: dispatch, outboxId, channel: peerChannel, decision: peer.kind === "read" ? "cancelled" : peer.kind === "accepted" ? "peer-verifying" : "peer-delivered", ...(peer.kind === "read" ? {} : { msgId: peer.msgId }) });
  }
  const peerFallback = peerFallbackReason();
  if (!sent.delivered && outcome !== "cancelled") outcome = "failed";
  const unavailable = outcome === "unavailable";
  const untypable = localParent && peer?.kind !== "delivered" && peer?.kind !== "accepted" && peer?.kind !== "read" && peer?.kind !== "aborted";
  const reason = untypable ? `local parent has no terminal to type into; the Stop hook and orchestrate watch surface it${peerFallback === undefined ? "" : ` (${peerFallback})`}` : unavailable ? `proof-unavailable: ${screenError}` : outcome === "failed" && lastDecision === "send-failed" && sendError !== undefined ? `send-failed: ${sendError}` : `deferred delivery ${outcome}`;
  setDeliveryTransport(database.value, dispatch, sequence, transport, unavailable ? "proof-unavailable" : payload.fullDirection === true && transport === "typed" ? "full-direction" : undefined);
  const finished = claimed.value.targetKind === "parent-pointer"
    ? finishNotification(database.value, outboxId, transport === "failed" ? "failed" : transport === "deferred" ? "suppressed" : "sent", { dispatchId: dispatch, pointer, outcome, reason })
    : finishOutbox(database.value, outboxId, transport === "failed" ? "failed" : transport === "deferred" ? "suppressed" : "sent", reason);
  if (!nested) {
    const quietDeadline = Math.min(deadline, Date.now() + 1000);
    while (Date.now() < quietDeadline) {
      const pending = listOutbox(database.value);
      if (pending.kind !== "ok") break;
      const next = pending.value.find((item) => item.target === target && item.status === "pending");
      if (next !== undefined) {
        await executeDeliveryWorker([next.id, holder, leaseKey, String(deadline), "nested"], environment, process);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    releaseLease(database.value, leaseKey, holder);
  }
  return finished.kind === "ok" ? ok(`delivery ${transport}\n`) : finished;
}

export async function executePeerVerificationWorker(args: readonly string[], environment: WorkerEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  const [outboxId] = args;
  if (!outboxId) return failed("peer verification worker requires an outbox id", 2);
  const root = resolveStateDirectory(environment);
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const saved = getOutboxPeerVerification(database.value, outboxId);
  if (saved.kind !== "ok" || saved.value === undefined || saved.value.state !== "pending") return ok("peer verification is already settled\n");
  const rows = listOutbox(database.value);
  if (rows.kind !== "ok") return rows;
  const outbox = rows.value.find((item) => item.id === outboxId);
  if (outbox === undefined || outbox.dispatchId === null) return failed(`peer verification outbox item not found: ${outboxId}`);
  const payload = typeof outbox.payload === "object" && outbox.payload !== null ? outbox.payload as Meta : {};
  const dispatch = String(payload.dispatchId ?? outbox.dispatchId);
  const sequence = Number(payload.sequence ?? 0);
  const meta = typeof payload.meta === "object" && payload.meta !== null ? payload.meta as Meta : {};
  const home = environment.HOME ?? "";
  const sessionId = String(meta.agentSessionId ?? meta.parentAgentSessionId ?? "");
  const pid = Number(meta.agentPid ?? meta.parentAgentPid ?? 0);
  const deliveries = listDeliveries(database.value, dispatch);
  if (deliveries.kind !== "ok") return deliveries;
  const delivery = deliveries.value.find((item) => Array.isArray(item.messageSeqs) && item.messageSeqs.includes(sequence));
  if (delivery === undefined) return failed(`peer verification delivery row not found for ${outboxId}`);
  const verifierLeaseKey = `peer-verification:${outboxId}`;
  const verifierHolder = `${globalThis.process.pid}-${randomUUID()}`;
  const verifierLease = acquireLease(database.value, verifierLeaseKey, verifierHolder, 90);
  if (verifierLease.kind !== "ok" || !verifierLease.value) return ok("peer verification is already running\n");
  try {
  const result = await verifyClaudePeerConsumption({
    heartbeat: async () => { acquireLease(database.value, verifierLeaseKey, verifierHolder, 90); },
    acknowledged: async () => {
      const current = listDeliveries(database.value, dispatch);
      return current.kind === "ok" && current.value.some((item) => item.id === delivery.id && item.status === "acknowledged");
    },
    status: async () => {
      const current = await resolveClaudeSession(home, pid, sessionId);
      return current === undefined ? "ended" : current.status === "idle" ? "idle" : "busy";
    },
    scan: async () => (await scanTranscript(saved.value!.transcript, saved.value!.transcriptOffset, saved.value!.messageId)).seen,
    sleep: async (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    fallback: async () => {
      recordChannelResult(database.value, { agent: "claude", channel: CLAUDE_PEER_CHANNEL, agentVersion: saved.value!.agentVersion, ok: false, error: `peer message ${saved.value!.messageId} was not acknowledged or consumed`, now: Date.now() });
      const queued = requeueOutboxPeerFallback(database.value, outboxId);
      if (queued.kind !== "ok" || !queued.value) return;
      const retryMeta = { ...meta, ...payload, targetKind: outbox.targetKind, dispatchId: dispatch };
      await startDeliveryWorker(root, dispatch, outboxId, retryMeta, process);
    },
  });
  if (result === "delivered") {
    recordChannelResult(database.value, { agent: "claude", channel: CLAUDE_PEER_CHANNEL, agentVersion: saved.value.agentVersion, ok: true });
    finishOutboxPeerVerification(database.value, outboxId, "delivered");
    setDeliveryTransport(database.value, dispatch, sequence, "socket");
  }
  return ok(`peer verification ${result}\n`);
  } finally {
    releaseLease(database.value, verifierLeaseKey, verifierHolder);
  }
}
