import { createConnection, createServer, type Socket } from "node:net";
import { appendFile, chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, readSnapshot, withWrite, type DatabaseHandle } from "./db.js";
import { failed, ok, type Result } from "../core/result.js";
import { selfInvocation } from "../core/self-invocation.js";
import { scrubAgentEnvironment } from "../core/agent-env.js";
import { createProcessAdapter } from "../adapters/proc.js";
import type { ProcessAdapter } from "../adapters/proc.js";
import { insertMessage, listMessages } from "./queries/messages.js";
import { insertDelivery } from "./queries/deliveries.js";
import { encode } from "./queries/types.js";
import { classifyQueueMail, recipientForQueueMessage } from "../core/queue-write.js";
import { formatDispatchMessage } from "../core/chat-message-format.js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ackDelivery as claimAndAckDelivery, acknowledgeImplicitDelivery as acknowledgeMail, acknowledgeImplicitDeliveryInTransaction as acknowledgeMailInTransaction, appendParentReply as appendMailParentReply, cancelQueuedMessage as cancelQueuedMail, claimDelivery as claimOutboxDelivery, claimOutbox as claimMailOutbox, createDelivery as createMailDelivery, deleteWaiter as deleteMailWaiter, fenceDelivery as fenceMailDelivery, finishNotification as finishMailNotification, finishOutbox as finishMailOutbox, listDeliveriesInTransaction as listMailDeliveries, putWaiter as putMailWaiter, setDeliveryTransport as setMailDeliveryTransport, transferLease as transferMailLease } from "../adapters/state/mailbox.js";
import { createDispatch as createDispatchState, mutateDispatch as mutateDispatchState, noDispatchChange } from "../adapters/state/dispatches.js";
import { putInstallModule as putInstallState, deleteInstallModule, mutateInstallModule, putTerminal, deleteTerminal, putTmuxSession, deleteTmuxSession, saveModels, type ModelRegistry } from "../adapters/state/machine.js";
import { recordChannelResult as recordChannelState, type ChannelResult } from "../adapters/state/channels.js";
import { checkDispatchTransition } from "../core/dispatch-states.js";
import { isReceiptFailure } from "../core/spawn-plan.js";
import { setHiddenItem, type HiddenItemKind } from "./queries/hidden-items.js";
import { finishWorktree, insertWorktree, upsertWorktree, type WorktreeRecord } from "./queries/worktrees.js";
import { registerRepository, removeRepository, saveRepositoryPullRequests, type RepositoryRecord } from "./queries/repositories.js";
import { listNativeSessions, replaceNativeSessions } from "./queries/native-sessions.js";
import { nativeSessionFor, removeNativeSession, replaceNativeSession, type NativeSession, type NativeSessionKey } from "../core/native-session.js";
import { ensureAutomaticCutoverOnHandle, markExplicitImport, migrateLegacyStateOnHandle } from "./cutover.js";
import { applyJsonStateImport, type ParsedJsonState } from "./import/json-state.js";
import { settleClosedParentBacklog } from "../core/closed-deliveries.js";
import { ensureStateOwnerSocketDirectory, legacyStateOwnerIsAlive, ownerStateSocketCandidates, ownerStateSocketForClient, processStartIdentity, stateOwnerSocket } from "./state-owner-runtime.js";
import { ownerOperation } from "./state-owner-operations.js";
export { stateOwnerSocket } from "./state-owner-runtime.js";

export type StateOwnerRequest = Readonly<
  { requestId?: string } & (
  | { operation: "setting-write"; key: string; value: string }
  | { operation: "install-state-write"; moduleId: string; value: unknown }
  | { operation: "install-state-remove"; moduleId: string }
  | { operation: "install-hook-state-write"; hookState: Readonly<Record<string, unknown>> }
  | { operation: "terminal-write"; action: "upsert"; record: Readonly<Record<string, unknown>> }
  | { operation: "terminal-write"; action: "remove"; terminalId: string }
  | { operation: "tmux-session-write"; action: "upsert"; record: Readonly<Record<string, unknown>>; stableSessionId: string | null }
  | { operation: "tmux-session-write"; action: "remove"; session: string }
  | { operation: "model-registry-write"; registry: ModelRegistry }
  | { operation: "hidden-item-write"; kind: HiddenItemKind; path: string; hidden: boolean }
  | { operation: "worktree-write"; action: "insert" | "upsert"; worktree: WorktreeRecord }
  | { operation: "worktree-write"; action: "finish"; path: string; finishedAt: string }
  | { operation: "worktree-write"; action: "reopen"; path: string }
  | { operation: "repository-register"; repository: RepositoryRecord }
  | { operation: "repository-remove"; path: string }
  | { operation: "repository-pull-request-cache-write"; path: string; value: string; fetchedAt: number }
  | { operation: "native-session-upsert"; session: NativeSession; expectedSessionId: string | null }
  | { operation: "native-session-remove"; key: NativeSessionKey; sessionId: string }
  | { operation: "project-history-backfill"; markerKey: string; markedAt: string; repositories: readonly RepositoryRecord[] }
  | { operation: "channel-result"; result: ChannelResult }
  | { operation: "resource-samples"; samples: readonly Readonly<{ dispatchId: string; agent: string; rssBytes: number; cpuPercent: number }>[]; now?: number }
  | { operation: "setting-read"; key: string }
  | { operation: "append-message"; dispatchId: string; message: Readonly<Record<string, unknown>>; delivery?: Readonly<Record<string, unknown>>; outbox?: Readonly<{ id: string; targetKind: string; target: string; payload: unknown }> }
  | { operation: "append-queue-message"; dispatchId: string; message: Readonly<{ from: string; type: string; text: string; sessionId: string; createdAt: string; idempotencyKey?: string }>; dispatch: Readonly<Record<string, unknown>>; childReport?: Readonly<{ type: "ask" | "done"; agent?: string; claudeSessionId?: string }> }
  | { operation: "message-read"; dispatchId: string; sequence: number }
  | { operation: "claim-delivery"; id: string; consumer: string; generation: number }
  | { operation: "fence-delivery"; id: string; consumer: string; generation: number }
  | { operation: "ack-delivery"; id: string; consumer: string; generation: number }
  | { operation: "create-delivery"; delivery: Readonly<Record<string, unknown>> }
  | { operation: "ack-implicit-delivery"; dispatchId: string; deliveryId: string; recipient: "child" | "parent"; now?: string; consumer?: string }
  | { operation: "set-delivery-transport"; dispatchId: string; sequence: number; transport: string; reason?: string }
  | { operation: "append-parent-reply"; dispatchId: string; message: Readonly<Record<string, unknown>>; options: Readonly<{ supersede: boolean; outbox?: Readonly<{ id: string; dispatchId?: string | null; targetKind: string; target: string; payload: unknown }> }> }
  | { operation: "cancel-queued-message"; dispatchId: string; itemId: string; reason: string; actor: string }
  | { operation: "put-waiter"; waiter: Readonly<{ dispatchId: string; pid: number; parentSessionId: string | null; parentHost: string | null; createdAt: string }> }
  | { operation: "delete-waiter"; dispatchId: string; pid?: number; createdAt?: string }
  | { operation: "claim-outbox"; id: string; holder: string; leaseSeconds: number }
  | { operation: "renew-outbox"; id: string; holder: string; leaseSeconds: number }
  | { operation: "acquire-lease"; key: string; holder: string; seconds: number }
  | { operation: "release-lease"; key: string; holder: string }
  | { operation: "transfer-lease"; key: string; from: string; to: string }
  | { operation: "finish-outbox"; id: string; holder?: string; status: "sent" | "failed" | "suppressed"; detail?: string | null }
  | { operation: "finish-notification"; id: string; holder: string; status: "sent" | "failed" | "suppressed"; event: Readonly<Record<string, unknown>> }
  | { operation: "resume-outbox"; id: string }
  | { operation: "dispatch-patch"; dispatchId: string; patch: Readonly<Record<string, unknown>>; expectedState?: string | readonly string[] }
  | { operation: "dispatch-prune"; action: "archive" | "delete"; dispatchId: string; archivedAt?: string }
  | { operation: "dispatch-create"; dispatch: Readonly<Record<string, unknown>> }
  | { operation: "child-report"; dispatchId: string; type: "received" | "ask" | "done" | "stalled"; agent?: string; agentThreadId?: string; agentPid?: number; claudeSessionId?: string }
  | { operation: "status" }
  | { operation: "automatic-cutover" }
  | { operation: "manual-migrate" }
  | { operation: "json-state-import"; parsed: ParsedJsonState; replace: boolean }
  | { operation: "resume-verification"; id: string }
  | { operation: "settle-closed-parent-backlog" }
  )
>;
export type StateOwner = { readonly stateDir: string; readonly executablePath: string; readonly handle: DatabaseHandle; readonly server: ReturnType<typeof createServer>; readonly lockPath: string; readonly abortController: AbortController; readonly sockets: Set<Socket>; socketIdentity?: { dev: number; ino: number }; onStopped?: () => void; readonly processAdapter: ProcessAdapter; readonly environment: Readonly<Record<string, string | undefined>>; readonly pendingDeliveries: Set<Promise<void>>; readonly pendingVerifications: Set<Promise<void>>; readonly deliveryChains: Map<string, Promise<void>>; readonly scheduledOutbox: Set<string>; readonly scheduledVerifications: Set<string>; readonly verificationTimers: Map<string, ReturnType<typeof setTimeout>>; readonly requests: Map<string, Promise<Response>>; clients: number; stopped: boolean; idleTimer?: ReturnType<typeof setTimeout>; sweepTimer?: ReturnType<typeof setTimeout>; lifecycleTimer?: ReturnType<typeof setInterval> };
type Response = { ok: true; value: unknown } | { ok: false; error: string };

function ownerLogPath(stateDir: string): string { return join(stateDir, "logs", "state-owner.log"); }
function logOwner(stateDir: string, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  try {
    const path = ownerLogPath(stateDir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields })}\n`, { mode: 0o600 });
  } catch { /* logging must not prevent state recovery */ }
}

export function stateOwnerPid(stateDir: string): string { return join(stateDir, "state-owner", "owner.pid"); }
function stateOwnerLock(stateDir: string): string { return join(stateDir, "state-owner", "owner.lock"); }

function ownsStateOwnerLock(owner: StateOwner): boolean {
  try { return readFileSync(owner.lockPath, "utf8").trim() === String(process.pid); }
  catch { return false; }
}

async function waitForPreviousOwner(stateDir: string): Promise<void> {
  let previousPid = 0;
  try { previousPid = Number(readFileSync(stateOwnerPid(stateDir), "utf8").trim()); } catch { return; }
  if (!Number.isSafeInteger(previousPid) || previousPid <= 0 || previousPid === process.pid) return;
  const expectedDirectory = resolve(stateDir);
  const isPreviousOwner = (): boolean => {
    const command = spawnSync("ps", ["-o", "command=", "-p", String(previousPid)], { encoding: "utf8", timeout: 1_000 });
    if (command.status !== 0 || !/(^|\s)__state-owner(?:\s|$)/.test(command.stdout)) return false;
    const environment = spawnSync("ps", ["eww", "-p", String(previousPid), "-o", "command="], { encoding: "utf8", timeout: 1_000 });
    if (environment.status !== 0) return true;
    const escapedDirectory = expectedDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const directoryPattern = new RegExp(`(?:^|\\s)MEGABRAIN_STATE_OWNER_DIR=${escapedDirectory}(?=\\s|$)`);
    return !/(?:^|\s)MEGABRAIN_STATE_OWNER_DIR=/.test(environment.stdout) || directoryPattern.test(environment.stdout);
  };
  const isPreviousOwnerAlive = (): boolean => {
    try { process.kill(previousPid, 0); }
    catch { return false; }
    return isPreviousOwner();
  };
  const waitUntil = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (isPreviousOwnerAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    return isPreviousOwnerAlive();
  };

  if (!await waitUntil(2_000)) return;
  if (!isPreviousOwnerAlive()) return;
  try { process.kill(previousPid, "SIGTERM"); }
  catch { return; }
  if (!await waitUntil(2_000)) return;
  throw new Error(`previous state owner did not exit after losing its lock (pid ${previousPid})`);
}

export async function inspectStateOwner(stateDir: string): Promise<{ running: false; error?: string } | { running: true; pid: number }> {
  if (!existsSync(ownerStateSocketForClient(stateDir))) return { running: false };
  try {
    const value = await requestOnce(stateDir, { operation: "status" }, 1_000) as { pid?: unknown };
    return typeof value.pid === "number" ? { running: true, pid: value.pid } : { running: false, error: "state owner returned an invalid status" };
  } catch (cause: unknown) {
    const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code?: unknown }).code) : "";
    if (code === "ECONNREFUSED" || (cause instanceof Error && cause.message.includes("did not answer within"))) return { running: false };
    return { running: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function") && "then" in value;
}

function isReadOnlyOwnerRequest(request: StateOwnerRequest): boolean {
  return request.operation === "status" || request.operation === "setting-read" || request.operation === "message-read" || request.operation === "resume-outbox";
}

function ownerRequest(owner: StateOwner, request: StateOwnerRequest): Promise<Response> {
  if (request.operation === "manual-migrate") {
    return (async (): Promise<Response> => {
      try {
        const result = await migrateLegacyStateOnHandle(owner.handle, owner.environment, owner.stateDir);
        return result.kind === "ok" ? { ok: true, value: result.value } : { ok: false, error: result.error };
      } catch (cause: unknown) { return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }; }
    })();
  }
  if (request.operation === "automatic-cutover") {
    const startedAt = Date.now();
    logOwner(owner.stateDir, "cutover-start");
    return ensureAutomaticCutoverOnHandle(owner.handle, owner.environment, owner.stateDir).then((result) => {
      if (result.kind !== "ok") throw new Error(result.error);
      logOwner(owner.stateDir, "cutover-finished", { elapsedMs: Date.now() - startedAt, migrated: result.value.migrated });
      return { ok: true, value: result.value } satisfies Response;
    }).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause.message : String(cause);
      logOwner(owner.stateDir, "cutover-failed", { elapsedMs: Date.now() - startedAt, error });
      return { ok: false, error } satisfies Response;
    });
  }
  if (request.operation === "resume-verification") {
    if (owner.scheduledVerifications.has(request.id)) return Promise.resolve({ ok: true, value: { scheduled: false } });
    owner.scheduledVerifications.add(request.id);
    const timer = setTimeout(() => {
      owner.verificationTimers.delete(request.id);
      const task = import("../cli/commands/delivery-worker.js").then(async ({ executeDeliveryVerificationWorker }) => {
        const result = await executeDeliveryVerificationWorker([request.id], { ...owner.environment, MEGABRAIN_STATE_DIR: owner.stateDir }, owner.processAdapter, owner.handle, owner.abortController.signal);
        if (result.kind !== "ok") throw new Error(result.error);
      }).catch((cause: unknown) => {
        logOwner(owner.stateDir, "peer-verification-failed", { id: request.id, error: cause instanceof Error ? cause.message : String(cause) });
      }).finally(() => {
        owner.pendingVerifications.delete(task);
        owner.scheduledVerifications.delete(request.id);
        scheduleOwnerExit(owner);
      });
      owner.pendingVerifications.add(task);
    }, 100);
    owner.verificationTimers.set(request.id, timer);
    if (owner.idleTimer !== undefined) clearTimeout(owner.idleTimer);
    owner.idleTimer = undefined;
    return Promise.resolve({ ok: true, value: { scheduled: true } });
  }
  if (request.operation === "settle-closed-parent-backlog") {
    const result = settleClosedParentBacklog(owner.handle);
    if (result.kind !== "ok") return Promise.resolve({ ok: false, error: result.error });
    return Promise.resolve({ ok: true, value: { settled: true } });
  }
  const requestId = request.requestId;
  if (typeof requestId !== "string" || requestId === "" || isReadOnlyOwnerRequest(request)) {
    try { return Promise.resolve({ ok: true, value: ownerOperation(owner, request, (id) => subscribeOutbox(owner, id)) }); }
    catch (cause: unknown) { return Promise.resolve({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }); }
  }
  const previous = owner.requests.get(requestId);
  if (previous !== undefined) return previous;
  const requestStartedAt = process.hrtime.bigint();
  let transactionMs = 0;
  logOwner(owner.stateDir, "request-start", { requestId, operation: request.operation });
  const result = Promise.resolve().then(() => {
    const transactionStartedAt = process.hrtime.bigint();
    const committed = withWrite(owner.handle, (db) => {
      const saved = db.query<{ result_json: string }>("SELECT result_json FROM state_owner_requests WHERE request_id = ?").get(requestId);
      if (saved !== null) {
        const decoded = JSON.parse(saved.result_json) as { present?: boolean; value?: unknown };
        return decoded.present === true ? decoded.value : undefined;
      }
      const value = ownerOperation(owner, request, (id) => subscribeOutbox(owner, id));
      if (isThenable(value)) throw new Error("state owner operations must be synchronous");
      const now = new Date().toISOString();
      db.run("INSERT INTO state_owner_requests (request_id, result_json, applied_at) VALUES (?, ?, ?)", [requestId, JSON.stringify({ present: value !== undefined, value: value ?? null }), now]);
      return value;
    });
    transactionMs = Number(process.hrtime.bigint() - transactionStartedAt) / 1_000_000;
    if (committed.kind !== "ok") throw new Error(committed.error);
    const elapsedMs = Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000;
    if (transactionMs >= 100) logOwner(owner.stateDir, "transaction-wait", { requestId, operation: request.operation, elapsedMs: transactionMs });
    const messageType = (request.operation === "append-queue-message" || request.operation === "append-parent-reply") && typeof request.message.type === "string" ? request.message.type : undefined;
    logOwner(owner.stateDir, "request-committed", { requestId, operation: request.operation, messageType, elapsedMs, transactionMs });
    return { ok: true, value: committed.value } satisfies Response;
  }).catch((cause: unknown) => {
    const error = cause instanceof Error ? cause.message : String(cause);
    logOwner(owner.stateDir, /busy|locked/i.test(error) ? "lock-wait-failed" : "request-failed", { requestId, operation: request.operation, elapsedMs: Number(process.hrtime.bigint() - requestStartedAt) / 1_000_000, error });
    return { ok: false, error } satisfies Response;
  });
  owner.requests.set(requestId, result);
  void result.then(() => {
    if (owner.requests.size <= 2_000) return;
    for (const [id, outcome] of owner.requests) {
      if (outcome !== result && owner.requests.size > 1_000) owner.requests.delete(id);
    }
  });
  return result;
}

function accept(owner: StateOwner, socket: Socket): void {
  owner.clients += 1;
  owner.sockets.add(socket);
  socket.once("close", () => { owner.sockets.delete(socket); owner.clients -= 1; scheduleOwnerExit(owner); });
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1_000_000) { socket.destroy(new Error("state owner request is too large")); return; }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void (async () => {
        try {
          const request = JSON.parse(line) as StateOwnerRequest;
          const response = await ownerRequest(owner, request);
          socket.write(`${JSON.stringify(response)}\n`);
        } catch (cause: unknown) {
          const error = cause instanceof Error ? cause.message : String(cause);
          socket.write(`${JSON.stringify({ ok: false, error } satisfies Response)}\n`);
        }
      })();
    }
  });
}

function scheduleOwnerExit(owner: StateOwner): void {
  if (owner.stopped) return;
  if (!existsSync(owner.stateDir)) { void stopStateOwner(owner); return; }
  if (owner.clients > 0 || owner.pendingDeliveries.size > 0 || owner.scheduledVerifications.size > 0 || owner.pendingVerifications.size > 0 || hasPendingOutbox(owner) || owner.idleTimer !== undefined) return;
  const testRunner = process.argv[1]?.endsWith(".test.ts") === true;
  const configuredIdle = Number(owner.environment.MEGABRAIN_STATE_OWNER_IDLE_MS);
  const temporaryState = resolve(owner.stateDir).startsWith(`${resolve(tmpdir())}/`);
  const idleMs = Number.isSafeInteger(configuredIdle) && configuredIdle > 0 ? configuredIdle : temporaryState ? testRunner ? 2_000 : 30_000 : 10 * 60_000;
  owner.idleTimer = setTimeout(() => {
    owner.idleTimer = undefined;
    if (!existsSync(owner.stateDir)) { void stopStateOwner(owner); return; }
    if (!owner.stopped && owner.clients === 0 && owner.pendingDeliveries.size === 0 && owner.scheduledVerifications.size === 0 && owner.pendingVerifications.size === 0 && !hasPendingOutbox(owner)) void stopStateOwner(owner);
    else scheduleOwnerExit(owner);
  }, idleMs);
  owner.idleTimer.unref?.();
}

function subscribeOutbox(owner: StateOwner, outboxId: string): boolean {
  if (owner.scheduledOutbox.has(outboxId)) return false;
  const row = owner.handle.db.query<{ target_kind: string; payload: string; status: string; lease_until: string | null }>("SELECT target_kind, payload, status, lease_until FROM outbox WHERE id = ?").get(outboxId);
  if (row === null) return false;
  if (row.status !== "pending" && !(row.status === "sending" && (row.lease_until === null || row.lease_until <= new Date().toISOString()))) return false;
  owner.scheduledOutbox.add(outboxId);
  let payload: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(row.payload);
    payload = typeof decoded === "object" && decoded !== null && !Array.isArray(decoded) ? decoded as Record<string, unknown> : {};
  } catch { owner.scheduledOutbox.delete(outboxId); return false; }
  const meta = typeof payload.meta === "object" && payload.meta !== null ? payload.meta as Record<string, unknown> : {};
  const target = row.target_kind === "parent-pointer"
    ? typeof meta.parentTmuxPane === "string" ? `tmux:${String(meta.parentTmuxSession ?? "")}:${meta.parentTmuxPane}` : `${String(meta.parentHost ?? "")}:${String(meta.parentTerminalId ?? meta.parentSessionId ?? "")}`
    : meta.runtime === "tmux" ? `tmux:${String(meta.tmuxSessionId ?? meta.tmuxSession ?? "")}:${String(meta.tmuxPane ?? "")}` : `${String(meta.childHost ?? "")}:${String(meta.terminalId ?? "")}`;
  const previous = owner.deliveryChains.get(target) ?? Promise.resolve();
  const task = previous.then(async () => {
    const leaseKey = `delivery-target:${target}`;
    const holder = `state-owner-${process.pid}-${randomUUID()}`;
    try {
      const { executeDeliveryWorker } = await import("../cli/commands/delivery-worker.js");
      const configuredTimeout = Number(owner.environment.MEGABRAIN_DELIVERY_TIMEOUT_MS);
      const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 30_000;
      const result = await executeDeliveryWorker([outboxId, holder, leaseKey, String(Date.now() + timeoutMs), "nested"], { ...owner.environment, MEGABRAIN_STATE_DIR: owner.stateDir }, owner.processAdapter, owner.handle);
      if (result.kind !== "ok") process.stderr.write(`state owner outbox delivery failed (${outboxId}): ${result.error}\n`);
    } catch (cause: unknown) {
      process.stderr.write(`state owner outbox delivery failed (${outboxId}): ${cause instanceof Error ? cause.message : String(cause)}\n`);
    }
  }).catch((cause: unknown) => { process.stderr.write(`state owner outbox subscriber failed (${outboxId}): ${cause instanceof Error ? cause.message : String(cause)}\n`); });
  owner.deliveryChains.set(target, task);
  owner.pendingDeliveries.add(task);
  if (owner.idleTimer !== undefined) clearTimeout(owner.idleTimer);
  owner.idleTimer = undefined;
  void task.finally(() => {
    owner.pendingDeliveries.delete(task);
    owner.scheduledOutbox.delete(outboxId);
    if (owner.deliveryChains.get(target) === task) owner.deliveryChains.delete(target);
    scheduleOwnerExit(owner);
  });
  return true;
}

function hasPendingOutbox(owner: StateOwner): boolean {
  const now = new Date().toISOString();
  return owner.handle.db.query<{ count: number }>("SELECT count(*) AS count FROM outbox WHERE status = 'pending' OR status = 'sending' AND (lease_until IS NULL OR lease_until <= ?)").get(now)?.count !== 0;
}

function scheduleOutboxSweep(owner: StateOwner, delay = 0): void {
  if (owner.sweepTimer !== undefined) return;
  owner.sweepTimer = setTimeout(() => {
    owner.sweepTimer = undefined;
    if (!existsSync(owner.stateDir)) { void stopStateOwner(owner); return; }
    const now = new Date().toISOString();
    const rows = owner.handle.db.query<{ id: string }>("SELECT id FROM outbox WHERE status = 'pending' OR status = 'sending' AND (lease_until IS NULL OR lease_until <= ?) ORDER BY created_at, id").all(now);
    for (const row of rows) subscribeOutbox(owner, row.id);
    scheduleOwnerExit(owner);
  }, delay);
  owner.sweepTimer.unref?.();
}

function stopForLifecycle(owner: StateOwner): void {
  if (owner.environment.MEGABRAIN_STATE_OWNER_TEST_MODE !== "1" || process.argv[1]?.endsWith(".test.ts") === true) {
    void stopStateOwner(owner);
    return;
  }
  const deadline = setTimeout(() => process.exit(0), 1_000);
  void stopStateOwner(owner).finally(() => {
    clearTimeout(deadline);
    process.exit(0);
  });
}

export async function startStateOwner(stateDir: string, processAdapter: ProcessAdapter = createProcessAdapter(), environment: Readonly<Record<string, string | undefined>> = process.env): Promise<StateOwner> {
  if (legacyStateOwnerIsAlive(stateDir)) throw new Error(`state owner is already running on its legacy socket for ${stateDir}`);
  const executablePath = environment.MEGABRAIN_STATE_OWNER_EXECUTABLE ?? (process.argv[1] !== undefined && !process.argv[1].startsWith("/$bunfs/") ? resolve(process.argv[1]) : process.execPath);
  const directory = join(stateDir, "state-owner");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  logOwner(stateDir, "starting", { socket: stateOwnerSocket(stateDir) });
  ensureStateOwnerSocketDirectory();
  const lockPath = stateOwnerLock(stateDir);
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (cause: unknown) {
    let pid = 0;
    const lockDeadline = Date.now() + 1_000;
    while (pid === 0 && Date.now() < lockDeadline) {
      try { pid = Number((await readFile(lockPath, "utf8")).trim()); } catch { /* retry while another starter creates it */ }
      if (pid === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error(`state owner is already running (pid ${pid})`); }
      catch (error) { if (error instanceof Error && error.message.includes("already running")) throw error; }
    }
    try { await unlink(lockPath); } catch { /* retry reports the current lock state */ }
    try { lock = await open(lockPath, "wx", 0o600); }
    catch { throw new Error("state owner is already starting", { cause }); }
  }
  await lock.writeFile(`${process.pid}\n`);
  await lock.close();
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
  if (opened.kind !== "ok") { logOwner(stateDir, "startup-failed", { error: opened.error }); await unlink(lockPath).catch(() => undefined); throw new Error(`state owner could not open the database: ${opened.error}`); }
  const handle = opened.value;
  handle.db.exec("PRAGMA wal_autocheckpoint = 10000");
  const initializedRequests = withWrite(handle, (db) => {
    db.run("CREATE TABLE IF NOT EXISTS state_owner_requests (request_id TEXT PRIMARY KEY, result_json TEXT NOT NULL, applied_at TEXT NOT NULL)");
    db.run("CREATE INDEX IF NOT EXISTS state_owner_requests_applied_at ON state_owner_requests(applied_at)");
    db.run("CREATE INDEX IF NOT EXISTS state_dispatches_created_id ON dispatches(created_at, id)");
    db.run("CREATE INDEX IF NOT EXISTS state_dispatches_active_created_id ON dispatches(archived_at, created_at, id)");
    db.run("CREATE INDEX IF NOT EXISTS state_dispatches_owner_created_id ON dispatches(owner_session_id, created_at, id)");
    db.run("CREATE INDEX IF NOT EXISTS state_dispatches_owner_active_created_id ON dispatches(owner_session_id, archived_at, created_at, id)");
    db.run("CREATE INDEX IF NOT EXISTS state_outbox_created_id ON outbox(created_at, id)");
    db.run("CREATE INDEX IF NOT EXISTS state_outbox_dispatch_created_id ON outbox(dispatch_id, created_at, id)");
    db.run("CREATE INDEX IF NOT EXISTS state_outbox_peer_state_created_id ON outbox(CASE WHEN json_valid(substr(detail, 19)) THEN json_extract(substr(detail, 19), '$.state') END, created_at, id) WHERE detail LIKE 'peer-verification:%'");
    db.run("CREATE INDEX IF NOT EXISTS state_messages_child_activity ON messages(dispatch_id) WHERE \"from\" = 'child' AND type IN ('received', 'ask', 'done')");
    db.run("CREATE INDEX IF NOT EXISTS state_outbox_dispatch_kind_status ON outbox(dispatch_id, target_kind, status)");
    db.run("CREATE INDEX IF NOT EXISTS state_outbox_detail_nocase ON outbox(detail COLLATE NOCASE)");
    db.run("CREATE INDEX IF NOT EXISTS state_outbox_dispatch_kind_detail_status ON outbox(dispatch_id, target_kind, detail COLLATE NOCASE, status)");
    db.run("CREATE INDEX IF NOT EXISTS state_repositories_name_path ON repositories(name COLLATE NOCASE, path)");
    db.run("CREATE INDEX IF NOT EXISTS state_native_sessions_order ON native_sessions(udid, bundle_id)");
    db.run("CREATE INDEX IF NOT EXISTS state_models_order ON models(agent, model)");
    db.run("CREATE INDEX IF NOT EXISTS state_resource_samples_sampled_at ON resource_samples(sampled_at)");
    db.run("DELETE FROM state_owner_requests WHERE applied_at < ?", [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]);
  });
  if (initializedRequests.kind !== "ok") { logOwner(stateDir, "startup-failed", { error: initializedRequests.error }); handle.close(); await unlink(lockPath).catch(() => undefined); throw new Error("state owner could not initialize request results: " + initializedRequests.error); }
  const server = createServer();
    const owner: StateOwner = { stateDir, executablePath, handle, server, lockPath, abortController: new AbortController(), sockets: new Set(), processAdapter, environment, pendingDeliveries: new Set(), pendingVerifications: new Set(), deliveryChains: new Map(), scheduledOutbox: new Set(), scheduledVerifications: new Set(), verificationTimers: new Map(), requests: new Map(), clients: 0, stopped: false };
  // Load the subscriber's transport code before accepting writes, so the first published row
  // does not pay a module-load delay after its transaction commits.
  await import("../cli/commands/delivery-worker.js");
  server.on("connection", (socket) => accept(owner, socket));
  try {
    // The lock proves no live owner can still be using the socket path.
    await waitForPreviousOwner(stateDir);
    await unlink(stateOwnerSocket(stateDir)).catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(stateOwnerSocket(stateDir), () => { server.removeListener("error", reject); resolve(); });
    });
    const socketStat = statSync(stateOwnerSocket(stateDir));
    owner.socketIdentity = { dev: socketStat.dev, ino: socketStat.ino };
    await chmod(stateOwnerSocket(stateDir), 0o600);
    await writeFilePid(stateDir);
    logOwner(stateDir, "ready", { socket: stateOwnerSocket(stateDir) });
    if (environment.MEGABRAIN_STATE_OWNER_TEST_REGISTRY !== undefined) {
      await appendFile(environment.MEGABRAIN_STATE_OWNER_TEST_REGISTRY, `${JSON.stringify({ pid: process.pid, stateDir: resolve(stateDir) })}\n`, { mode: 0o600 });
    }
    owner.lifecycleTimer = setInterval(() => {
      if (!existsSync(owner.stateDir) || !existsSync(owner.handle.path) || !existsSync(owner.executablePath) || !existsSync(stateOwnerSocket(owner.stateDir)) || !ownsStateOwnerLock(owner)) { stopForLifecycle(owner); return; }
      const parentPid = owner.environment.MEGABRAIN_STATE_OWNER_TEST_MODE === "1" ? Number(owner.environment.MEGABRAIN_STATE_OWNER_TEST_PARENT_PID) : 0;
      if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return;
      const parentStart = owner.environment.MEGABRAIN_STATE_OWNER_TEST_PARENT_START;
      const parentGone = parentStart === undefined || parentStart === "" || processStartIdentity(parentPid) !== parentStart;
      if (parentGone && owner.clients === 0) stopForLifecycle(owner);
    }, 1_000);
    owner.lifecycleTimer.unref?.();
    // Give the first client request a chance to cancel or supersede legacy pending rows before
    // startup recovery begins delivering them. New rows are still subscribed in their write.
    scheduleOutboxSweep(owner, 50);
    scheduleOwnerExit(owner);
    return owner;
  } catch (cause: unknown) {
    logOwner(stateDir, "startup-failed", { error: cause instanceof Error ? cause.message : String(cause) });
    handle.close();
    await unlink(lockPath).catch(() => undefined);
    throw cause;
  }
}

async function writeFilePid(stateDir: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(stateOwnerPid(stateDir), `${process.pid}\n`, { mode: 0o600 });
  await chmod(stateOwnerPid(stateDir), 0o600);
}

export async function stopStateOwner(owner: StateOwner): Promise<void> {
  if (owner.stopped) return;
  owner.stopped = true;
  owner.abortController.abort();
  if (owner.idleTimer !== undefined) clearTimeout(owner.idleTimer);
  if (owner.sweepTimer !== undefined) clearTimeout(owner.sweepTimer);
  if (owner.lifecycleTimer !== undefined) clearInterval(owner.lifecycleTimer);
  for (const timer of owner.verificationTimers.values()) clearTimeout(timer);
  owner.verificationTimers.clear();
  owner.scheduledVerifications.clear();
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all([...owner.pendingDeliveries, ...owner.pendingVerifications]),
    new Promise<void>((resolve) => { drainTimer = setTimeout(resolve, 1_000); }),
  ]);
  if (drainTimer !== undefined) clearTimeout(drainTimer);
  for (const socket of owner.sockets) socket.destroy();
  await new Promise<void>((resolve) => owner.server.close(() => resolve()));
  owner.handle.close();
  logOwner(owner.stateDir, "stopped");
  owner.onStopped?.();
  // A replacement may already own these paths. Only the process whose lock is still
  // present may remove the published socket and pid during normal shutdown.
  const ownsLock = ownsStateOwnerLock(owner);
  let ownsSocket = false;
  try {
    const current = statSync(stateOwnerSocket(owner.stateDir));
    ownsSocket = current.dev === owner.socketIdentity?.dev && current.ino === owner.socketIdentity?.ino;
  } catch { /* socket is already gone */ }
  if (ownsSocket) await unlink(stateOwnerSocket(owner.stateDir)).catch(() => undefined);
  if (ownsLock) await Promise.all([unlink(stateOwnerPid(owner.stateDir)).catch(() => undefined), unlink(owner.lockPath).catch(() => undefined)]);
}

function requestOnceAt(socketPath: string, request: StateOwnerRequest, timeoutMs: number): Promise<unknown> {
  if (!existsSync(socketPath)) return Promise.reject(Object.assign(new Error("state owner socket is not present"), { code: "ENOENT" }));
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error(`state owner did not answer within ${timeoutMs} ms`), { code: "ETIMEDOUT" })); }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as Response;
        socket.end();
        if (response.ok) resolve(response.value);
        else reject(new Error(response.error));
      } catch (cause: unknown) { reject(cause); }
    });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function requestOnce(stateDir: string, request: StateOwnerRequest, timeoutMs: number): Promise<unknown> {
  const candidates = ownerStateSocketCandidates(stateDir);
  const sockets = candidates.length === 0 ? [ownerStateSocketForClient(stateDir)] : candidates;
  const trySocket = async (index: number): Promise<unknown> => {
    const socketPath = sockets[index];
    if (socketPath === undefined) throw new Error("state owner socket is not present");
    try { return await requestOnceAt(socketPath, request, timeoutMs); }
    catch (cause: unknown) {
      const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code?: unknown }).code) : "";
      if ((code === "ENOENT" || code === "ECONNREFUSED" || code === "ETIMEDOUT") && index + 1 < sockets.length) return trySocket(index + 1);
      throw cause;
    }
  };
  return trySocket(0);
}

export async function callStateOwner(stateDir: string, request: StateOwnerRequest, timeoutMs = 5_000, startupTimeoutMs = Math.max(timeoutMs, 130_000)): Promise<unknown> {
  const requestWithId = { ...request, requestId: request.requestId ?? randomUUID() } as StateOwnerRequest;
  const retryDeadline = Date.now() + Math.max(1, startupTimeoutMs);
  const processAdapter = createProcessAdapter();
  const temporaryState = resolve(stateDir) === resolve(tmpdir()) || resolve(stateDir).startsWith(`${resolve(tmpdir())}/`);
  const testRunner = process.argv[1]?.endsWith(".test.ts") === true;
  const invocation = testRunner
    ? { command: process.execPath, args: [resolve(dirname(fileURLToPath(import.meta.url)), "../cli/index.ts"), "__state-owner"] }
    : selfInvocation(process.execPath, process.argv, ["__state-owner"]);
  const { MEGABRAIN_DISPATCH_ID: _dispatchId, ...baseEnvironment } = process.env;
  const testMode = testRunner || baseEnvironment.MEGABRAIN_STATE_OWNER_TEST_REGISTRY !== undefined;
  const ownerEnvironment = {
    ...scrubAgentEnvironment(baseEnvironment),
    MEGABRAIN_STATE_OWNER_DIR: stateDir,
    // Old binaries may still hold SQLite's writer lock during an upgrade. Keep
    // the new owner alive long enough for those short transactions to finish.
    MEGABRAIN_DB_BUSY_SECONDS: "120",
    ...(testMode ? {
      MEGABRAIN_STATE_OWNER_TEST_MODE: "1",
      MEGABRAIN_STATE_OWNER_TEST_PARENT_PID: String(testRunner ? process.pid : process.ppid),
      MEGABRAIN_STATE_OWNER_TEST_PARENT_START: processStartIdentity(testRunner ? process.pid : process.ppid) ?? "",
    } : {}),
    ...(temporaryState && baseEnvironment.MEGABRAIN_STATE_OWNER_IDLE_MS === undefined ? { MEGABRAIN_STATE_OWNER_IDLE_MS: testMode ? "2000" : "30000" } : {}),
  };
  let nextStart = Date.now() + 250;
  let restarts = 0;
  let started = false;
  let ownerPid: number | undefined;
  let launchAt = "";
  let lastConnectionError: unknown;
  for (;;) {
    const remaining = retryDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error("state owner did not confirm the request outcome before the retry deadline", { cause: lastConnectionError });
    }
    try {
      return await requestOnce(stateDir, requestWithId, Math.min(timeoutMs, remaining));
    } catch (cause: unknown) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("did not answer within")) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, retryDeadline - Date.now()))));
        continue;
      }
      const code = typeof cause === "object" && cause !== null && "code" in cause ? String((cause as { code?: unknown }).code) : "";
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw cause;
      lastConnectionError = cause;
      if (!started || (Date.now() >= nextStart && restarts < 5)) {
        const startingFirst = !started;
        if (startingFirst) launchAt = new Date(Date.now() - 1000).toISOString();
        const result = await processAdapter.startDetached(invocation.command, invocation.args, { env: ownerEnvironment });
        if (!started) {
          if (result.kind !== "ok") throw new Error(`state owner could not start: ${result.error ?? "detached process failed"}`, { cause });
          ownerPid = result.value.pid;
          started = true;
        } else if (result.kind === "ok") restarts += 1;
        nextStart = Date.now() + 500;
      }
      if (started && ownerPid !== undefined) {
        let alive = true;
        try { process.kill(ownerPid, 0); } catch { alive = false; }
        if (!alive) {
          try {
            const lines = (await readFile(ownerLogPath(stateDir), "utf8")).trim().split("\n").reverse();
            const failure = lines.map((line) => { try { return JSON.parse(line) as { at?: string; event?: string; error?: string }; } catch { return {}; } })
              .find((entry) => entry.at !== undefined && entry.at >= launchAt && entry.event === "startup-failed");
            if (failure?.error) throw new Error(`state owner failed to start: ${failure.error}`, { cause });
          } catch (logError: unknown) {
            if (logError instanceof Error && logError.message.startsWith("state owner failed to start:")) throw logError;
          }
          ownerPid = undefined;
          started = false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function recordChannelResultThroughOwner(stateDir: string, result: ChannelResult): Promise<void> {
  await callStateOwner(stateDir, { operation: "channel-result", result });
}

export function stateOwnerResult<T>(value: unknown): Result<T> { return ok(value as T); }
export function stateOwnerFailure(message: string): Result<never> { return failed(message); }
