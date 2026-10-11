import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { acquireLease, claimOutbox, finishNotification, finishOutbox, getDispatch, listDeliveries, listOutbox, mutateDispatch, releaseLease, setDeliveryTransport, stateDatabase } from "../../adapters/state-db.js";
import { resolveClaudeSession } from "../../agents/claude-session.js";
import { createDecisionLog } from "../../core/delivery-decision-log.js";
import { classifyLiveness } from "../../core/liveness.js";
import { deliverWhenIdle, startDeferredDelivery } from "../../core/idle-delivery.js";
import { resolveStateDirectory } from "../../core/state.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { submitKey } from "../../agents/index.js";
import { deliveryComposer, ghostTracker, readDeliveryScreen, type GhostTracker } from "./delivery-screen.js";

type Meta = Record<string, unknown>;
type WorkerEnvironment = Readonly<Record<string, string | undefined>>;
const MAX_DELIVERY_MS = 10 * 60 * 1000;
const GHOST_STATIC_MS = 30_000;
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
  const deadline = Date.now() + MAX_DELIVERY_MS;
  const result = await startDeferredDelivery(
    target,
    holder,
    async (key, owner) => {
      const acquired = acquireLease(database.value, `delivery-target:${key}`, owner, Math.ceil(MAX_DELIVERY_MS / 1000) + 30);
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
  expectedClaudeStatus?: Readonly<{ pid: number; statusUpdatedAt: number }>,
  adoptStatus?: (status: ClaudeStatus | undefined, proof: string, screenStatus: "idle" | "busy" | "unknown") => Promise<void>,
  ghost?: GhostTracker,
): Promise<boolean> {
  const agent = String(meta.agent ?? "");
  const submit = submitKey(agent);
  if (submit.kind !== "ok") return false;
  const preflight = async (): Promise<Result<void>> => {
    const screen = await readDeliveryScreen(meta, process);
    if (screen.kind !== "ok") return failed(screen.kind === "failed" ? screen.error : screen.reason);
    const screenStatus = deliveryStatus(classifyLiveness(agent, screen.value).status);
    const status = await claudeStatus(meta, environment);
    const typed = deliveryComposer(agent, screen.value);
    const composer = ghost === undefined ? typed : ghost.observe(typed, status?.statusUpdatedAt);
    const observed = status?.pid !== undefined && status.status !== "unknown" ? status.status : screenStatus;
    await adoptStatus?.(status, status?.pid === undefined ? "screen" : "claude-session", observed);
    const ghostIdle = ghost?.assumed() === true && typed !== "" && screenStatus === "unknown" && observed === "idle";
    if ((screenStatus !== "idle" && !ghostIdle) || composer !== "") return failed("target is no longer idle with an empty composer");
    if (status?.pid !== undefined && status.status !== "idle") return failed("Claude session is no longer idle");
    if (status?.pid !== undefined && status.statusUpdatedAt === undefined) return failed("Claude session status has no freshness timestamp");
    if (expectedClaudeStatus !== undefined) {
      if (status?.status !== "idle" || status.pid !== expectedClaudeStatus.pid || status.statusUpdatedAt !== expectedClaudeStatus.statusUpdatedAt) return failed("Claude session status changed after the idle check");
    }
    return ok(undefined);
  };
  if (meta.runtime === "tmux") {
    const sent = await sendTmuxPair(root, String(meta.tmuxPane ?? ""), text, submit.value, {}, process, false, preflight);
    return sent.kind === "ok";
  }
  const host = String(meta.childHost ?? "");
  const provider = getHost(host);
  if (provider === undefined) return false;
  const screen = await preflight();
  if (screen.kind !== "ok") return false;
  const call = provider.send({ workspaceId: typeof meta.workspaceId === "string" ? meta.workspaceId : null, terminalId: String(meta.terminalId ?? ""), text, enter: true });
  if (call.kind !== "ok") return false;
  return (await runHostSend(host, process, call.value)).kind === "ok";
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
  const claimed = claimOutbox(database.value, outboxId, holder, Math.ceil(MAX_DELIVERY_MS / 1000) + 30);
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
    }
    : persistedMeta;
  if (targetKind === "parent-pointer" && meta.runtime === "tmux" && typeof meta.tmuxSession !== "string") {
    const session = await getTmux().sessionForPane(String(meta.tmuxPane ?? ""), process);
    if (session.kind === "ok") meta = { ...meta, tmuxSession: session.value };
  }
  const text = typeof payload.fullMessage === "string" ? payload.fullMessage : "";
  const pointer = typeof payload.pointer === "string" ? payload.pointer : "mail: megabrain check";
  let checkedClaudeStatus: { pid: number; statusUpdatedAt: number } | undefined;
  let proofSource = "screen";
  let statusRead: "idle" | "busy" | "unknown" = "unknown";
  let statusUpdatedAtRead: number | undefined;
  let proofReason: string | undefined;
  let transport = "failed";
  let outcome = "failed";
  let lastDecision: string | undefined;
  let screenDownSince: number | undefined;
  let screenError = "";
  const unavailableMs = Number(environment.MEGABRAIN_PROOF_UNAVAILABLE_MS);
  const giveUpAfterMs = Number.isFinite(unavailableMs) && unavailableMs > 0 ? unavailableMs : PROOF_UNAVAILABLE_MS;
  const staticMs = Number(environment.MEGABRAIN_GHOST_STATIC_MS);
  const ghost = meta.runtime === "tmux" ? undefined : ghostTracker(Number.isFinite(staticMs) && staticMs > 0 ? staticMs : GHOST_STATIC_MS);
  const decisionLog = createDecisionLog(root);
  const adoptClaudePid = (status: ClaudeStatus | undefined): void => {
    if (status?.pid === undefined || status.pid === Number(meta.agentPid)) return;
    const field = targetKind === "parent-pointer" ? "parentAgentPid" : "agentPid";
    mutateDispatch(database.value, dispatch, () => ({ [field]: status.pid }));
    meta = { ...meta, agentPid: status.pid };
  };
  if (text !== "" && dispatch !== "" && sequence > 0) {
    let result: Awaited<ReturnType<typeof deliverWhenIdle>>;
    try {
      result = await deliverWhenIdle({
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
          checkedClaudeStatus = undefined;
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
        if (observed !== "idle") ghost?.reset();
        checkedClaudeStatus = status?.status === "idle" && status.pid !== undefined && status.statusUpdatedAt !== undefined
          ? { pid: status.pid, statusUpdatedAt: status.statusUpdatedAt }
          : undefined;
        return observed;
      },
      composer: async () => {
        const screen = await readDeliveryScreen(meta, process);
        const typed = screen.kind === "ok" ? deliveryComposer(String(meta.agent ?? ""), screen.value) : undefined;
        return ghost === undefined ? typed : ghost.observe(typed, statusUpdatedAtRead);
      },
      clear: async () => clearOwnComposer(root, meta, process),
      send: async () => sendTyped(root, meta, text, environment, process, checkedClaudeStatus, async (status, proof, fallbackStatus) => {
        adoptClaudePid(status);
        const sessionProven = status?.pid !== undefined;
        proofSource = proof;
        proofReason = status?.reason;
        statusRead = sessionProven && status.status !== "unknown" ? status.status : fallbackStatus;
        statusUpdatedAtRead = status?.statusUpdatedAt;
      }, ghost),
      isRead: async () => readWasPulled(root, dispatch, sequence),
      giveUp: () => screenDownSince !== undefined && Date.now() - screenDownSince >= giveUpAfterMs,
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
          ...(details.decision === "send" && ghost?.assumed() === true ? { reason: "ghost-assumed-static" } : {}),
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
  const reason = unavailable ? `proof-unavailable: ${screenError}` : outcome === "failed" && lastDecision === "wait-composer" ? "composer-occupied" : `deferred delivery ${outcome}`;
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
