import { createConnection, createServer, type Socket } from "node:net";
import { appendFile, chmod, mkdir, open, readFile, unlink } from "node:fs/promises";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
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
import { getMessage, insertMessage, listMessages } from "./queries/messages.js";
import { insertDelivery } from "./queries/deliveries.js";
import { encode } from "./queries/types.js";
import { classifyQueueMail, recipientForQueueMessage } from "../core/queue-write.js";
import { formatDispatchMessage } from "../core/chat-message-format.js";
import { randomUUID } from "node:crypto";
import { acquireLease as acquireMailLease, ackDelivery as claimAndAckDelivery, acknowledgeImplicitDelivery as acknowledgeMail, acknowledgeImplicitDeliveryInTransaction as acknowledgeMailInTransaction, appendParentReply as appendMailParentReply, cancelQueuedMessage as cancelQueuedMail, claimDelivery as claimOutboxDelivery, claimOutbox as claimMailOutbox, createDelivery as createMailDelivery, deleteWaiter as deleteMailWaiter, fenceDelivery as fenceMailDelivery, finishNotification as finishMailNotification, finishOutbox as finishMailOutbox, listDeliveriesInTransaction as listMailDeliveries, putWaiter as putMailWaiter, releaseLease as releaseMailLease, renewOutboxLease as renewMailOutboxLease, setDeliveryTransport as setMailDeliveryTransport, transferLease as transferMailLease } from "../adapters/state/mailbox.js";
import { createDispatch as createDispatchState, mutateDispatch as mutateDispatchState, noDispatchChange } from "../adapters/state/dispatches.js";
import { putInstallModule as putInstallState, deleteInstallModule, mutateInstallModule, putTerminal, deleteTerminal, putTmuxSession, deleteTmuxSession, saveModels, type ModelRegistry } from "../adapters/state/machine.js";
import { recordChannelResult as recordChannelState, type ChannelResult } from "../adapters/state/channels.js";
import { checkDispatchTransition } from "../core/dispatch-states.js";
import { isReceiptFailure } from "../core/spawn-plan.js";
import { setHiddenItem, type HiddenItemKind } from "./queries/hidden-items.js";
import { finishWorktree, insertWorktree, upsertWorktree, type WorktreeRecord } from "./queries/worktrees.js";
import { registerRepository, removeRepository, saveRepositoryPullRequests, type RepositoryRecord } from "./queries/repositories.js";
import { type NativeSession, type NativeSessionKey } from "../core/native-session.js";
import { ensureAutomaticCutoverOnHandle, markExplicitImport, migrateLegacyStateOnHandle } from "./cutover.js";
import { applyJsonStateImport, type ParsedJsonState } from "./import/json-state.js";
import { settleClosedParentBacklog } from "../core/closed-deliveries.js";
import { stateOwnerSocket } from "./state-owner-runtime.js";

import type { StateOwner, StateOwnerRequest } from "./state-owner.js";

type ChildReport = Readonly<{ type: "received" | "ask" | "done" | "stalled"; agent?: string; agentThreadId?: string; agentPid?: number; claudeSessionId?: string }>;

function applyChildReport(owner: Pick<StateOwner, "handle">, dispatchId: string, request: ChildReport): void {
  let refusal: string | undefined;
  const updated = mutateDispatchState(owner.handle, dispatchId, (current) => {
    const recovering = current.state === "failed" && isReceiptFailure(current.reason);
    const state = recovering ? "running" : typeof current.state === "string" ? current.state : "running";
    const processState = typeof current.processState === "string" ? current.processState : "running";
    const nextState = request.type === "ask" ? "waiting_for_reply" : request.type === "done" ? "done" : state === "spawning" ? "running" : state;
    const nextProcess = request.type === "done" ? "succeeded" : processState === "starting" || processState === "start-unproven" ? "running" : processState;
    if (request.type === "done") {
      const transition = checkDispatchTransition("dispatch", state, nextState);
      if (transition.kind !== "ok") { refusal = transition.error; return noDispatchChange; }
    }
    return {
      state: nextState, processState: nextProcess, updatedAt: new Date().toISOString(),
      ...(request.agentThreadId === undefined ? {} : { agentThreadId: request.agentThreadId }),
      ...(request.agentPid === undefined ? {} : { agentPid: request.agentPid }),
      ...(request.type === "received" && request.agentPid === undefined && request.agentThreadId !== undefined ? { agentPid: null } : {}),
      ...(request.type === "received" && request.agent === "claude" && request.claudeSessionId !== undefined ? { agentSessionId: request.claudeSessionId } : {}),
      ...(request.type === "received" ? { promptReceipt: "received", promptState: "confirmed" } : {}),
      ...(recovering ? { reason: null, recoveredFrom: current.reason } : {}),
      ...(current.receiptMissing === undefined || current.receiptMissing === null ? {} : { receiptMissing: null }),
    };
  });
  if (refusal !== undefined) throw new Error(refusal);
  if (updated.kind !== "ok") throw new Error(updated.error);
}

export function ownerOperation(owner: Pick<StateOwner, "handle" | "stateDir">, request: StateOwnerRequest, scheduleOutbox: (id: string) => boolean): unknown {
  if (request.operation === "status") return { pid: process.pid, stateDir: owner.stateDir };
  if (request.operation === "dispatch-create") {
    const result = createDispatchState(owner.handle, request.dispatch);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "install-state-write") {
    const result = putInstallState(owner.handle, request.moduleId, request.value);
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "install-state-remove") {
    const result = deleteInstallModule(owner.handle, request.moduleId);
    if (result.kind !== "ok") throw new Error(result.error);
    return { removed: result.value };
  }
  if (request.operation === "install-hook-state-write") {
    const result = mutateInstallModule(owner.handle, "orchestration-hooks", (value) => {
      const state = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { ...state, hookConfigs: request.hookState };
    });
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "terminal-write") {
    const result = request.action === "upsert"
      ? putTerminal(owner.handle, request.record)
      : deleteTerminal(owner.handle, request.terminalId);
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "tmux-session-write") {
    const result = request.action === "upsert"
      ? putTmuxSession(owner.handle, request.record, request.stableSessionId)
      : deleteTmuxSession(owner.handle, request.session);
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "model-registry-write") {
    const result = saveModels(owner.handle, request.registry);
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "hidden-item-write") {
    const result = withWrite(owner.handle, (db) => setHiddenItem(db, request.kind, request.path, request.hidden));
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "worktree-write") {
    const result = withWrite(owner.handle, (db) => {
      if (request.action === "finish") return { updated: finishWorktree(db, request.path, request.finishedAt) };
      if (request.action === "reopen") return { updated: db.run("UPDATE worktrees SET finished_at = NULL WHERE path = ? AND finished_at IS NOT NULL", [request.path]).changes > 0 };
      if (request.action === "insert") insertWorktree(db, request.worktree);
      else upsertWorktree(db, request.worktree);
      return { written: true };
    });
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "repository-register") {
    const result = withWrite(owner.handle, (db) => registerRepository(db, request.repository));
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "repository-remove") {
    const result = withWrite(owner.handle, (db) => removeRepository(db, request.path));
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value ?? null;
  }
  if (request.operation === "native-session-upsert") {
    const result = withWrite(owner.handle, (db) => {
      const current = db.query<{ session_id: string }>("SELECT session_id FROM native_sessions WHERE udid = ? AND bundle_id = ?").get(request.session.udid, request.session.bundleId);
      if ((current?.session_id ?? null) !== request.expectedSessionId) return false;
      db.run("INSERT INTO native_sessions (udid, bundle_id, session_id) VALUES (?, ?, ?) ON CONFLICT (udid, bundle_id) DO UPDATE SET session_id = excluded.session_id", [request.session.udid, request.session.bundleId, request.session.sessionId]);
      return true;
    });
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "native-session-remove") {
    const result = withWrite(owner.handle, (db) => db.run("DELETE FROM native_sessions WHERE udid = ? AND bundle_id = ? AND session_id = ?", [request.key.udid, request.key.bundleId, request.sessionId]).changes === 1);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "repository-pull-request-cache-write") {
    const result = withWrite(owner.handle, (db) => saveRepositoryPullRequests(db, request.path, request.value, request.fetchedAt));
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: true };
  }
  if (request.operation === "project-history-backfill") {
    const result = withWrite(owner.handle, (db) => {
      if (db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(request.markerKey) !== null) return true;
      for (const repository of request.repositories) registerRepository(db, repository);
      db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", [request.markerKey, request.markedAt, request.markedAt]);
      return true;
    });
    if (result.kind !== "ok") throw new Error(result.error);
    return { written: result.value };
  }
  if (request.operation === "channel-result") {
    const result = recordChannelState(owner.handle, request.result);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "resource-samples") {
    const samples = request.samples.filter((sample) => typeof sample.dispatchId === "string" && /^[A-Za-z0-9._-]+$/.test(sample.dispatchId) &&
      typeof sample.agent === "string" && sample.agent !== "" && Number.isSafeInteger(sample.rssBytes) && sample.rssBytes >= 0 &&
      Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0);
    const now = request.now ?? Date.now();
    const result = withWrite(owner.handle, (db) => {
      db.run("DELETE FROM resource_samples WHERE sampled_at < ?", [now - 24 * 60 * 60 * 1000]);
      for (const sample of samples) db.run("INSERT INTO resource_samples (dispatch_id, agent, sampled_at, rss_bytes, cpu_percent) VALUES (?, ?, ?, ?, ?)", [sample.dispatchId, sample.agent, now, sample.rssBytes, sample.cpuPercent]);
      return samples.length;
    });
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "json-state-import") {
    const result = withWrite(owner.handle, (db) => {
      const report = applyJsonStateImport(db, request.parsed, request.replace);
      if (report.malformed.length === 0 && report.conflicts.length === 0) {
        const marked = markExplicitImport(owner.handle, report.imported);
        if (marked.kind !== "ok") throw new Error(marked.error);
      }
      return report;
    });
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "resume-outbox") return { scheduled: scheduleOutbox(request.id) };
  if (request.operation === "dispatch-patch") {
    if (request.patch.dispatchId !== undefined && request.patch.dispatchId !== request.dispatchId) throw new Error("dispatch patch cannot change dispatchId");
    let refusal: string | undefined;
    let matched = true;
    const updated = mutateDispatchState(owner.handle, request.dispatchId, (current) => {
      if (request.expectedState !== undefined && !(Array.isArray(request.expectedState) ? request.expectedState.includes(current.state) : current.state === request.expectedState)) { matched = false; return noDispatchChange; }
      if (typeof request.patch.state === "string" && request.patch.state !== current.state) {
        const transition = checkDispatchTransition("dispatch", current.state, request.patch.state);
        if (transition.kind !== "ok") { refusal = transition.error; return noDispatchChange; }
      }
      return { ...current, ...request.patch, updatedAt: request.patch.updatedAt ?? new Date().toISOString() };
    });
    if (refusal !== undefined) throw new Error(refusal);
    if (updated.kind !== "ok") throw new Error(updated.error);
    return matched ? updated.value : { updated: false };
  }
  if (request.operation === "dispatch-prune") {
    const result = withWrite(owner.handle, (db) => request.action === "archive"
      ? db.run("UPDATE dispatches SET archived_at = COALESCE(archived_at, ?) WHERE id = ?", [request.archivedAt ?? new Date().toISOString(), request.dispatchId]).changes > 0
      : db.run("DELETE FROM dispatches WHERE id = ?", [request.dispatchId]).changes > 0);
    if (result.kind !== "ok") throw new Error(result.error);
    return { changed: result.value };
  }
  if (request.operation === "child-report") {
    applyChildReport(owner, request.dispatchId, request);
    return undefined;
  }
  if (request.operation === "claim-delivery") {
    const result = claimOutboxDelivery(owner.handle, request.id, request.consumer, request.generation);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "fence-delivery") {
    const result = fenceMailDelivery(owner.handle, request.id, request.consumer, request.generation);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "ack-delivery") {
    const result = claimAndAckDelivery(owner.handle, request.id, request.consumer, request.generation);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "create-delivery") {
    const result = createMailDelivery(owner.handle, request.delivery);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "ack-implicit-delivery") {
    const result = acknowledgeMail(owner.handle, request.dispatchId, request.deliveryId, request.recipient, request.now);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "set-delivery-transport") {
    const result = setMailDeliveryTransport(owner.handle, request.dispatchId, request.sequence, request.transport, request.reason);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "append-parent-reply") {
    const result = appendMailParentReply(owner.handle, request.dispatchId, request.message, request.options);
    if (result.kind !== "ok") throw new Error(result.error);
    if (request.options.outbox !== undefined) scheduleOutbox(request.options.outbox.id);
    return result.value;
  }
  if (request.operation === "cancel-queued-message") {
    const result = cancelQueuedMail(owner.handle, request.dispatchId, request.itemId, request.reason, request.actor);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "put-waiter") {
    const result = putMailWaiter(owner.handle, request.waiter);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "delete-waiter") {
    const result = deleteMailWaiter(owner.handle, request.dispatchId);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "claim-outbox") {
    const result = claimMailOutbox(owner.handle, request.id, request.holder, request.leaseSeconds);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "renew-outbox") {
    const result = renewMailOutboxLease(owner.handle, request.id, request.holder, request.leaseSeconds);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "acquire-lease") {
    const result = acquireMailLease(owner.handle, request.key, request.holder, request.seconds);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "release-lease") {
    const result = releaseMailLease(owner.handle, request.key, request.holder);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "transfer-lease") {
    const result = transferMailLease(owner.handle, request.key, request.from, request.to);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "finish-outbox") {
    const result = finishMailOutbox(owner.handle, request.id, request.status, request.detail);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "finish-notification") {
    const result = finishMailNotification(owner.handle, request.id, request.status, request.event as Parameters<typeof finishMailNotification>[3]);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "message-read") {
    const result = readSnapshot(owner.handle, (db) => getMessage(db, request.dispatchId, request.sequence) ?? null);
    if (result.kind !== "ok") throw new Error(result.error);
    return result.value;
  }
  if (request.operation === "setting-read") {
    const row = owner.handle.db.query<{ value: string }>("SELECT value FROM settings WHERE key = ?").get(request.key);
    return { value: row?.value ?? null };
  }
  if (request.operation === "append-message") {
    const result = withWrite(owner.handle, (db) => {
      const sequence = (db.query<{ seq: number | null }>("SELECT max(seq) AS seq FROM messages WHERE dispatch_id = ?").get(request.dispatchId)?.seq ?? 0) + 1;
      const message = { ...request.message, seq: sequence, createdAt: typeof request.message.createdAt === "string" ? request.message.createdAt : new Date().toISOString() };
      insertMessage(db, request.dispatchId, message);
      if (request.delivery !== undefined) {
        const now = new Date().toISOString();
        insertDelivery(db, { ...request.delivery, dispatchId: request.dispatchId, messageSeqs: [sequence], createdAt: typeof request.delivery.createdAt === "string" ? request.delivery.createdAt : now, updatedAt: typeof request.delivery.updatedAt === "string" ? request.delivery.updatedAt : now });
      }
      if (request.outbox !== undefined) {
        const now = new Date().toISOString();
        db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at, lease_holder, detail) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL, NULL)", [request.outbox.id, request.dispatchId, request.outbox.targetKind, request.outbox.target, encode(request.outbox.payload), now, now]);
      }
      return { sequence };
    });
    if (result.kind !== "ok") throw new Error(result.error);
    if (request.outbox !== undefined) scheduleOutbox(request.outbox.id);
    return result.value;
  }
  if (request.operation === "append-queue-message") {
    const result = withWrite(owner.handle, (db) => {
      if (request.childReport !== undefined) applyChildReport(owner, request.dispatchId, request.childReport);
      const priorDone = db.query<{ found: number }>("SELECT 1 AS found FROM messages WHERE dispatch_id = ? AND \"from\" = 'child' AND type = 'done' AND text = ? LIMIT 1").get(request.dispatchId, request.message.text) !== null;
      const classification = classifyQueueMail(request.message.from, request.message.type, priorDone);
      const recipient = recipientForQueueMessage(request.message.from, request.message.type, priorDone);
      const sequence = (db.query<{ seq: number | null }>("SELECT max(seq) AS seq FROM messages WHERE dispatch_id = ?").get(request.dispatchId)?.seq ?? 0) + 1;
      insertMessage(db, request.dispatchId, { ...request.message, seq: sequence });
      if (request.message.from === "child") {
        for (const delivery of listMailDeliveries(db, request.dispatchId)) {
          const sequences = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : [];
          if (delivery.recipient === "child" && sequences.some((value) => value < sequence) && (delivery.transport === "checked" || delivery.transportReason === "full-direction")) {
            acknowledgeMailInTransaction(db, request.dispatchId, String(delivery.id), "child", request.message.createdAt);
          }
        }
      }
      const now = request.message.createdAt;
      const deliveryId = recipient === undefined ? undefined : `delivery-${now.replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
      if (deliveryId !== undefined) insertDelivery(db, { id: deliveryId, dispatchId: request.dispatchId, recipient, messageSeqs: [sequence], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      const outboxId = recipient === "parent" && classification === "actionable" ? `parent-pointer-${randomUUID()}` : undefined;
      if (outboxId !== undefined) {
        const dispatch = request.dispatch;
        const pointer = `mail: megabrain orchestrate watch ${request.dispatchId}`;
        const fullMessage = formatDispatchMessage({ dispatchId: request.dispatchId, chatName: String(dispatch.chatName ?? dispatch.branch ?? request.dispatchId), agent: String(dispatch.agent ?? "unknown"), type: request.message.type, text: request.message.text, direction: "parent-bound" });
        const payload = { meta: dispatch, dispatchId: request.dispatchId, targetKind: "parent-pointer", sequence, pointer, fullDirection: true, fullMessage };
        db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at, lease_holder, detail) VALUES (?, ?, 'parent-pointer', ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL, NULL)", [outboxId, request.dispatchId, typeof dispatch.parentSessionId === "string" ? dispatch.parentSessionId : request.dispatchId, encode(payload), now, now]);
      }
      return { sequence, outboxId, deliveryId };
    });
    if (result.kind !== "ok") throw new Error(result.error);
    if (result.value.outboxId !== undefined) scheduleOutbox(result.value.outboxId);
    return result.value;
  }
  if (request.operation !== "setting-write") throw new Error(`unsupported state owner operation: ${(request as { operation: string }).operation}`);
  const result = withWrite(owner.handle, (db) => {
    db.run("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", [request.key, request.value, new Date().toISOString()]);
    return { written: true };
  });
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

