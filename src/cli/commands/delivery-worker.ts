import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { acquireLease, claimOutbox, finishNotification, finishOutbox, getDispatch, listDeliveries, listOutbox, mutateDispatch, releaseLease, renewOutboxLease, setDeliveryTransport, stateDatabase } from "../../adapters/state-db.js";
import { claudeSessionPermissionClass, type PeerPermissionClass } from "../../agents/claude-peer.js";
import { resolveClaudeSession } from "../../agents/claude-session.js";
import { createDecisionLog } from "../../core/delivery-decision-log.js";
import { classifyLiveness } from "../../core/liveness.js";
import { composerReadback } from "../../core/composer-proof.js";
import { CLAUDE_PEER_CHANNEL, deliverThroughClaudePeer, senderPermissionClass, type PeerDeliveryOutcome } from "../../core/claude-peer-delivery.js";
import { formatOneLine } from "../../core/chat-message-format.js";
import { deliverThroughGrokLeader, GROK_LEADER_CHANNEL } from "../../core/grok-leader-delivery.js";
import { AGY_LS_CHANNEL, deliverThroughAgyLanguageServer } from "../../core/agy-ls-delivery.js";
import { agyParentKey } from "../../agents/agy-ls.js";
import { deliverWhenIdle, startDeferredDelivery } from "../../core/idle-delivery.js";
import { resolveStateDirectory } from "../../core/state.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { submitKey } from "../../agents/index.js";
import { deliveryComposer, deliveryHasKeystrokeDialog, readDeliveryScreen } from "./delivery-screen.js";

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
      const executable = globalThis.process.argv[1] ?? "megabrain";
      const started = await process.startDetached(executable, ["__delivery-worker", outboxId, owner, leaseKey, String(deadline)]);
      return started.kind === "ok";
    },
    async (_key, owner) => { releaseLease(database.value, leaseKey, owner); },
  );
  return result;
}

// The permission class attested for the sender. A parent notice comes from a child megabrain
// launched, so its class is read from that launch line. A reply comes from the parent, whose class
// is the mode its own transcript last recorded; it is attested only when it matches the child's,
// since a mismatch is held for review and a reply should then be typed instead.
async function peerSenderMode(targetKind: string, meta: Meta, home: string): Promise<PeerPermissionClass | undefined> {
  if (targetKind === "parent-pointer") return typeof meta.agent === "string" ? senderPermissionClass(meta.agent) : undefined;
  if (targetKind !== "child-delivery" || meta.parentAgent !== "claude" || typeof meta.parentAgentSessionId !== "string") return undefined;
  const parent = await claudeSessionPermissionClass(home, meta.parentAgentSessionId);
  return parent !== undefined && parent === senderPermissionClass("claude") ? parent : undefined;
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
  root: string,
  meta: Meta,
  text: string,
  environment: WorkerEnvironment,
  process: ProcessAdapter,
  adoptStatus?: (status: ClaudeStatus | undefined, proof: string, screenStatus: "idle" | "busy" | "unknown") => Promise<void>,
  fail: (reason: string) => void = () => undefined,
  recordReadback: (readback: Readonly<{ region?: string; orcaDraft?: string }>) => void = () => undefined,
  ignoreDraft = false,
): Promise<boolean> {
  const agent = String(meta.agent ?? "");
  const host = String(meta.childHost ?? "");
  const submit = submitKey(agent);
  if (submit.kind !== "ok") { fail(submit.error); return false; }
  let raceReadback: Readonly<{ region?: string; orcaDraft?: string }> | undefined;
  const preflight = async (): Promise<Result<void>> => {
    const screen = await readDeliveryScreen(meta, process);
    if (screen.kind !== "ok") return failed(screen.kind === "failed" ? screen.error : screen.reason);
    const status = await claudeStatus(meta, environment);
    const typed = deliveryComposer(agent, screen.value);
    const dialog = deliveryHasKeystrokeDialog(agent, screen.value);
    const screenStatus = deliveryStatus(classifyLiveness(agent, screen.value).status);
    const observed = status?.pid !== undefined && status.status !== "unknown" ? status.status : screenStatus;
    await adoptStatus?.(status, status?.pid === undefined ? "screen" : "claude-session", observed);
    if (dialog || (typed !== "" && !ignoreDraft)) return failed(dialog ? "target is showing a keystroke dialog" : "target composer is occupied");
    return ok(undefined);
  };
  if (meta.runtime === "tmux") {
    const sent = await sendTmuxPair(root, String(meta.tmuxPane ?? ""), text, submit.value, {}, process, false, preflight);
    if (sent.kind !== "ok") fail(sent.error);
    return sent.kind === "ok";
  }
  const provider = getHost(host);
  if (provider === undefined) { fail(`unknown host ${host}`); return false; }
  const screen = await preflight();
  if (screen.kind !== "ok") { fail(`preflight: ${screen.error}`); return false; }
  const target = { workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? "") };
  const call = provider.send({ ...target, text: host === "orca" ? formatOneLine(text) : text, enter: true });
  if (call.kind !== "ok") { fail(`${host} send command: ${call.error}`); return false; }
  const sent = await runHostSend(host, process, call.value);
  if (sent.kind === "ok") {
    if (host === "orca") {
      try {
        const screen = await readDeliveryScreen(meta, process);
        if (screen.kind === "ok") {
          const observed = composerReadback(agent, screen.value);
          recordReadback({
            ...(observed.region === undefined ? {} : { region: observed.region.slice(0, 300) }),
            ...(observed.orcaDraft === undefined ? {} : { orcaDraft: observed.orcaDraft.slice(0, 300) }),
          });
        }
      } catch {
        // Post-submit read-back is diagnostic only; it cannot undo a successful send.
      }
    }
    return true;
  }
  const detail = (sent.kind === "failed" ? sent.stdout ?? "" : "").trim().slice(0, 300);
  fail(`${host} send: ${sent.error}${detail === "" ? "" : ` | ${detail}`}`);
  return false;
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
  const text = typeof payload.fullMessage === "string" ? payload.fullMessage : "";
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
  const renewLeases = async (): Promise<void> => {
    if (!nested) {
      const lease = acquireLease(database.value, leaseKey, holder, DELIVERY_LEASE_SECONDS);
      if (lease.kind !== "ok" || !lease.value) throw new Error("delivery target lease was lost");
    }
    const outboxLease = renewOutboxLease(database.value, outboxId, holder, DELIVERY_LEASE_SECONDS);
    if (outboxLease.kind !== "ok" || !outboxLease.value) throw new Error("outbox lease was lost");
  };
  // A Claude target takes the message through its peer socket: no composer, no draft to wait on,
  // no idle wait. Typing stays as the fallback whenever the socket is unavailable, marked broken,
  // or drops it.
  let peer: PeerDeliveryOutcome | Readonly<{ kind: "aborted" }> | undefined;
  let peerChannel = CLAUDE_PEER_CHANNEL;
  const home = environment.HOME;
  const senderMode = home === undefined ? undefined : await peerSenderMode(targetKind, persistedMeta, home);
  if ((targetKind === "parent-pointer" || senderMode !== undefined) && meta.agent === "claude" && home && text !== "" && dispatch !== "" && sequence > 0 && typeof meta.agentSessionId === "string") {
    const idleDrop = Number(environment.MEGABRAIN_PEER_IDLE_DROP_MS);
    try {
      peer = await deliverThroughClaudePeer({
        database: database.value,
        home,
        pid: Number(meta.agentPid),
        sessionId: meta.agentSessionId,
        text,
        deadline,
        ...(senderMode === undefined ? {} : { senderMode }),
        ...(Number.isFinite(idleDrop) && idleDrop > 0 ? { idleDropMs: idleDrop } : {}),
        isRead: async () => readWasPulled(root, dispatch, sequence),
        renew: renewLeases,
      });
    } catch {
      // Only a lost lease throws here; another worker owns the target now, so typing would duplicate.
      peer = { kind: "aborted" };
    }
    peerChannel = CLAUDE_PEER_CHANNEL;
  }
  // A Grok child started with its own leader, or a Grok parent running under one, takes the message
  // straight into its session queue.
  const direct = targetKind === "child-delivery" || targetKind === "parent-pointer";
  if (direct && meta.agent === "grok" && typeof meta.grokLeaderSocket === "string" && typeof meta.grokSessionId === "string" && text !== "" && dispatch !== "" && sequence > 0) {
    peer = await deliverThroughGrokLeader({ database: database.value, socketPath: meta.grokLeaderSocket, sessionId: meta.grokSessionId, text });
    peerChannel = GROK_LEADER_CHANNEL;
  }
  // An agy child that reported its language server, or an agy parent that spawned from one of its
  // tool shells, takes the message into its conversation queue.
  if (peer === undefined && direct && meta.agent === "agy" && text !== "" && dispatch !== "" && sequence > 0) {
    const pollMs = Number(environment.MEGABRAIN_AGY_POLL_MS);
    try {
      const agy = await deliverThroughAgyLanguageServer({
        database: database.value,
        stateRoot: root,
        endpointKey: targetKind === "parent-pointer" ? agyParentKey(dispatch) : dispatch,
        text,
        deadline,
        ...(Number.isFinite(pollMs) && pollMs > 0 ? { pollMs } : {}),
        isRead: async () => readWasPulled(root, dispatch, sequence),
        renew: renewLeases,
      });
      if (agy !== undefined) { peer = agy; peerChannel = AGY_LS_CHANNEL; }
    } catch {
      // Only a lost lease throws here; another worker owns the target now, so typing would duplicate.
      peer = { kind: "aborted" };
    }
  }
  // A fallback is logged on the typing attempts that follow, as peerFallback.
  if (peer !== undefined && (peer.kind === "delivered" || peer.kind === "read")) {
    await decisionLog.record({
      dispatchId: dispatch,
      outboxId,
      channel: peerChannel,
      decision: peer.kind === "delivered" ? "peer-delivered" : "cancelled",
      ...(peer.kind === "delivered" ? { msgId: peer.msgId } : {}),
    });
  }
  const peerFallback = peer?.kind === "fallback" ? peer.reason : undefined;
  const unsupportedHost = meta.runtime === "host" && meta.childHost === "superset";
  if (peer?.kind === "delivered") {
    outcome = "delivered";
    transport = "socket";
  } else if (peer?.kind === "read") {
    outcome = "cancelled";
    transport = "checked";
  } else if (peer?.kind === "aborted") {
    outcome = "failed";
    transport = "failed";
  } else if (unsupportedHost) {
    outcome = "failed";
    transport = "deferred";
  } else if (text !== "" && dispatch !== "" && sequence > 0) {
    let result: Awaited<ReturnType<typeof deliverWhenIdle>>;
    try {
      result = await deliverWhenIdle({
      timeoutMs: Math.max(0, deadline - Date.now()),
      allowBusy: targetKind === "parent-pointer",
      ignoreDraft: targetKind === "parent-pointer",
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
        const agent = String(meta.agent ?? "");
        const typed = screen.kind === "ok" && !deliveryHasKeystrokeDialog(agent, screen.value) ? deliveryComposer(agent, screen.value) : undefined;
        return typed;
      },
      clear: async () => clearOwnComposer(root, meta, process),
      send: async () => sendTyped(root, meta, text, environment, process, async (status, proof, fallbackStatus) => {
        adoptClaudePid(status);
        const sessionProven = status?.pid !== undefined;
        proofSource = proof;
        proofReason = status?.reason;
        statusRead = sessionProven && status.status !== "unknown" ? status.status : fallbackStatus;
        statusUpdatedAtRead = status?.statusUpdatedAt;
      }, (reason) => { sendError = reason; }, (readback) => { composerReadbackAfterSubmit = readback; }, targetKind === "parent-pointer"),
      sendError: () => sendError,
      isRead: async () => readWasPulled(root, dispatch, sequence),
      giveUp: () => screenDownSince !== undefined && Date.now() - screenDownSince >= giveUpAfterMs,
      renew: renewLeases,
      attempt: async (details) => {
        lastDecision = details.decision;
        const entry = {
          dispatchId: dispatch,
          outboxId,
          proofSource,
          status: statusRead,
          statusUpdatedAt: statusUpdatedAtRead ?? null,
          composer: details.composer,
          decision: details.decision,
          ...(proofReason === undefined ? {} : { proofReason }),
          ...(details.reason === undefined ? {} : { reason: details.reason }),
          ...(peerFallback === undefined ? {} : { peerFallback }),
          ...(details.decision === "send" && composerReadbackAfterSubmit !== undefined ? { composerReadback: composerReadbackAfterSubmit } : {}),
        };
        await decisionLog.record(entry);
      },
      record: async (result) => { outcome = result; },
      });
    } catch {
      result = "failed";
    }
    outcome = result;
    transport = result === "delivered" ? payload.pointerOnly === true ? "pointer" : "typed" : result === "cancelled" ? "checked" : "failed";
  }
  const unavailable = outcome === "unavailable";
  const reason = unsupportedHost ? "superset-unverifiable-composer" : unavailable ? `proof-unavailable: ${screenError}` : outcome === "failed" && lastDecision === "wait-composer" ? "composer-occupied" : outcome === "failed" && lastDecision === "send-failed" && sendError !== undefined ? `send-failed: ${sendError}` : `deferred delivery ${outcome}`;
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
