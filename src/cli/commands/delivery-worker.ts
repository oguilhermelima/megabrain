import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { acquireLease, claimOutbox, finishNotification, finishOutbox, getDispatch, listDeliveries, listOutbox, releaseLease, setDeliveryTransport, stateDatabase } from "../../adapters/state-db.js";
import { classifyLiveness } from "../../core/liveness.js";
import { deliverWhenIdle, startDeferredDelivery } from "../../core/idle-delivery.js";
import { resolveStateDirectory } from "../../core/state.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getHost, runHostSend } from "../../hosts/index.js";
import { getTmux, sendTmuxPair } from "../../hosts/tmux.js";
import { submitKey } from "../../agents/index.js";
import { deliveryComposer, readDeliveryScreen } from "./delivery-screen.js";

type Meta = Record<string, unknown>;
type WorkerEnvironment = Readonly<Record<string, string | undefined>>;
const MAX_DELIVERY_MS = 10 * 60 * 1000;

async function claudeStatus(meta: Meta, environment: WorkerEnvironment): Promise<"idle" | "busy" | undefined> {
  const pid = Number(meta.agentPid);
  const home = environment.HOME;
  if (meta.agent !== "claude" || !Number.isSafeInteger(pid) || pid <= 0 || !home) return undefined;
  try {
    const value: unknown = JSON.parse(await readFile(resolve(home, ".claude", "sessions", `${pid}.json`), "utf8"));
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.pid !== pid) return undefined;
    return record.status === "idle" ? "idle" : record.status === "busy" || record.status === "not_fully_idle" ? "busy" : undefined;
  } catch {
    return undefined;
  }
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

async function sendTyped(root: string, meta: Meta, text: string, process: ProcessAdapter): Promise<boolean> {
  const agent = String(meta.agent ?? "");
  const submit = submitKey(agent);
  if (submit.kind !== "ok") return false;
  const preflight = async (): Promise<Result<void>> => {
    const screen = await readDeliveryScreen(meta, process);
    if (screen.kind !== "ok") return failed(screen.kind === "failed" ? screen.error : screen.reason);
    if (classifyLiveness(agent, screen.value).status !== "idle" || deliveryComposer(agent, screen.value) !== "") return failed("target is no longer idle with an empty composer");
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
  const target = claimed.value.target;
  const payload = typeof claimed.value.payload === "object" && claimed.value.payload !== null ? claimed.value.payload as Meta : {};
  const dispatch = String(payload.dispatchId ?? claimed.value.dispatchId ?? "");
  const sequence = Number(payload.sequence ?? 0);
  const stored = dispatch === "" ? undefined : getDispatch(database.value, dispatch);
  const persistedMeta = typeof payload.meta === "object" && payload.meta !== null ? payload.meta as Meta : stored?.kind === "ok" && stored.value ? stored.value : {};
  let meta = claimed.value.targetKind === "parent-pointer"
    ? {
      ...persistedMeta,
      runtime: typeof persistedMeta.parentTmuxPane === "string" ? "tmux" : "host",
      tmuxSession: persistedMeta.parentTmuxSession,
      tmuxPane: persistedMeta.parentTmuxPane,
      childHost: persistedMeta.parentHost,
      workspaceId: persistedMeta.parentWorkspaceId,
      terminalId: persistedMeta.parentTerminalId ?? persistedMeta.parentSessionId,
      agent: persistedMeta.parentAgent ?? persistedMeta.agent,
    }
    : persistedMeta;
  if (claimed.value.targetKind === "parent-pointer" && meta.runtime === "tmux" && typeof meta.tmuxSession !== "string") {
    const session = await getTmux().sessionForPane(String(meta.tmuxPane ?? ""), process);
    if (session.kind === "ok") meta = { ...meta, tmuxSession: session.value };
  }
  const text = typeof payload.fullMessage === "string" ? payload.fullMessage : "";
  const pointer = typeof payload.pointer === "string" ? payload.pointer : "mail: megabrain check";
  let transport = "failed";
  let outcome = "failed";
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
        if (screen.kind !== "ok") return "unknown";
        const status = await claudeStatus(meta, environment);
        return (status ?? classifyLiveness(String(meta.agent ?? ""), screen.value).status) === "idle" ? "idle" : "busy";
      },
      composer: async () => {
        const screen = await readDeliveryScreen(meta, process);
        return screen.kind === "ok" ? deliveryComposer(String(meta.agent ?? ""), screen.value) : undefined;
      },
      clear: async () => clearOwnComposer(root, meta, process),
      send: async () => sendTyped(root, meta, text, process),
      isRead: async () => readWasPulled(root, dispatch, sequence),
      record: async (result) => { outcome = result; },
      });
    } catch {
      result = "failed";
    }
    outcome = result;
    transport = result === "delivered" ? payload.pointerOnly === true ? "pointer" : "typed" : result === "cancelled" ? "checked" : "failed";
  }
  setDeliveryTransport(database.value, dispatch, sequence, transport, payload.fullDirection === true && transport === "typed" ? "full-direction" : undefined);
  const finished = claimed.value.targetKind === "parent-pointer"
    ? finishNotification(database.value, outboxId, transport === "failed" ? "failed" : transport === "deferred" ? "suppressed" : "sent", { dispatchId: dispatch, pointer, outcome, reason: `deferred delivery ${outcome}` })
    : finishOutbox(database.value, outboxId, transport === "failed" ? "failed" : transport === "deferred" ? "suppressed" : "sent", `deferred delivery ${outcome}`);
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
