import { acknowledgeDelivery } from "../../core/ack.js";
import { addSupersedeSummary, supersedeDelivery, type SupersedeSummary } from "../../core/parent-reply.js";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { insertDelivery, listDeliveries as queryDeliveries, toDelivery, type DeliveryRecord } from "../../db/queries/deliveries.js";
import { insertMessage, listMessages as queryMessages, toMessage, type MessageRecord } from "../../db/queries/messages.js";
import { decode, encode, object, type DatabaseAdapter } from "../../db/queries/types.js";
import { toOutbox, type OutboxRecord } from "../../db/queries/outbox-leases.js";
import type { DatabaseHandle } from "../../db/db.js";
import { read, write } from "./shared.js";

export type OutboxInput = Readonly<{ id: string; dispatchId?: string | null; targetKind: string; target: string; payload: unknown }>;
export type OutboxDetails = OutboxRecord & Readonly<{ leaseHolder: string | null; detail: string | null }>;
export type AppendMessageOptions = Readonly<{ outbox?: OutboxInput }>;
export type AppendParentReplyOptions = Readonly<{ supersede: boolean; outbox?: OutboxInput }>;

function findMessageByKey(db: DatabaseAdapter, key: string): MessageRecord | undefined {
  const row = db.query<{ dispatch_id: string; seq: number; from: string; type: string; text: string; body: string | null; session_id: string | null; created_at: string; idempotency_key: string | null; extra: string }>("SELECT * FROM messages WHERE idempotency_key = ?").get(key);
  return row === null ? undefined : toMessage(row);
}

function nextMessageSequence(db: DatabaseAdapter, dispatchId: string): number {
  return (db.query<{ seq: number | null }>("SELECT max(seq) AS seq FROM messages WHERE dispatch_id = ?").get(dispatchId)?.seq ?? 0) + 1;
}

export function appendMessage(handle: DatabaseHandle, dispatchId: string, message: Readonly<Record<string, unknown>>, options: AppendMessageOptions = {}): Result<MessageRecord> {
  return write(handle, ({ db }) => {
    const key = typeof message.idempotencyKey === "string" && message.idempotencyKey !== "" ? message.idempotencyKey : undefined;
    if (key !== undefined) {
      const existing = findMessageByKey(db, key);
      if (existing !== undefined) return existing;
    }
    const assigned = {
      ...message,
      seq: nextMessageSequence(db, dispatchId),
      createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    };
    insertMessage(db, dispatchId, assigned);
    if (options.outbox !== undefined) enqueueOutboxValue(db, { ...options.outbox, dispatchId }, new Date().toISOString());
    return queryMessages(db, dispatchId).at(-1) as MessageRecord;
  });
}

export function appendParentReply(handle: DatabaseHandle, dispatchId: string, message: Readonly<Record<string, unknown>>, options: AppendParentReplyOptions): Result<MessageRecord> {
  return write(handle, ({ db }) => {
    const now = typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString();
    let summary: SupersedeSummary = { queued: 0, delivered: 0, deliveredSequences: [] };
    if (options.supersede) {
      const deliveries = queryDeliveries(db, dispatchId);
      const messages = queryMessages(db, dispatchId);
      for (const delivery of deliveries) {
        const sequences = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : [];
        if (sequences.length === 0 || !sequences.every((seq) => messages.some((item) => item.seq === seq && item.from === "parent" && item.type === "reply"))) continue;
        const decision = supersedeDelivery(String(delivery.status), typeof delivery.consumer === "string" ? delivery.consumer : null, sequences, delivery.superseded === true);
        if (decision.queued === 0 && decision.delivered === 0) continue;
        const extraRow = db.query<{ extra: string }>("SELECT extra FROM deliveries WHERE id = ?").get(delivery.id);
        const extra = extraRow === null ? {} : object(decode<unknown>(extraRow.extra));
        db.run("UPDATE deliveries SET status = ?, updated_at = ?, extra = ? WHERE id = ?", [
          decision.queued > 0 ? "superseded" : delivery.status,
          now,
          encode({ ...extra, superseded: true, supersededAt: now }),
          delivery.id,
        ]);
        summary = addSupersedeSummary(summary, decision);
      }
    }

    const append = (value: Readonly<Record<string, unknown>>): MessageRecord => {
      const assigned = { ...value, seq: nextMessageSequence(db, dispatchId), createdAt: typeof value.createdAt === "string" ? value.createdAt : now };
      insertMessage(db, dispatchId, assigned);
      const row = queryMessages(db, dispatchId).at(-1);
      if (row === undefined) throw new Error("parent reply insert was not visible");
      const deliveryId = `delivery-${now.replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
      insertDelivery(db, { id: deliveryId, dispatchId, recipient: "child", messageSeqs: [row.seq], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      return row;
    };

    if (summary.delivered > 0) append({ from: "parent", type: "withdrawal", text: `withdrawn parent direction message sequence(s): ${summary.deliveredSequences.join(", ")}`, sessionId: "" });
    const reply = append({ ...message, from: "parent", type: "reply", text: message.text, sessionId: message.sessionId ?? "" });
    if (options.outbox !== undefined) enqueueOutboxValue(db, { ...options.outbox, dispatchId }, now);
    return { ...reply, supersedeSummary: summary };
  });
}

export function listMessages(handle: DatabaseHandle, dispatchId: string): Result<MessageRecord[]> {
  return read(handle, ({ db }) => queryMessages(db, dispatchId));
}

export function createDelivery(handle: DatabaseHandle, delivery: Readonly<Record<string, unknown>>): Result<DeliveryRecord> {
  return write(handle, ({ db }) => {
    const now = new Date().toISOString();
    const complete = { ...delivery, createdAt: typeof delivery.createdAt === "string" ? delivery.createdAt : now, updatedAt: typeof delivery.updatedAt === "string" ? delivery.updatedAt : now };
    insertDelivery(db, complete);
    const row = db.query<Parameters<typeof toDelivery>[0]>("SELECT * FROM deliveries WHERE id = ?").get(String(delivery.id));
    if (row === null) throw new Error("delivery insert was not visible");
    return toDelivery(row);
  });
}

export function listDeliveries(handle: DatabaseHandle, dispatchId: string): Result<DeliveryRecord[]> {
  return read(handle, ({ db }) => queryDeliveries(db, dispatchId));
}

export function claimDelivery(handle: DatabaseHandle, id: string, consumer: string, generation: number): Result<DeliveryRecord | undefined> {
  return write(handle, ({ db }) => {
    const row = db.query<Parameters<typeof toDelivery>[0]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (row === null) return undefined;
    const current = toDelivery(row);
    if (current.status !== "outstanding" && current.status !== "superseded") return current;
    // core/check.ts:66-74 excludes deliveries claimed by another consumer and only calls a same-consumer, same-generation claim a replay.
    if (current.consumer !== undefined && current.consumer !== null && current.consumer !== consumer) return undefined;
    if (current.consumer === null || current.consumer === undefined) {
      // check.ts:174-188 and orchestrate-parent.ts:147-150 claim an unowned delivery for the resolved consumer and generation.
      const now = new Date().toISOString();
      db.run("UPDATE deliveries SET consumer = ?, generation = ?, updated_at = ? WHERE id = ? AND consumer IS NULL", [consumer, generation, now, id]);
    }
    const claimed = db.query<Parameters<typeof toDelivery>[0]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    return claimed === null ? undefined : toDelivery(claimed);
  });
}

export function ackDelivery(handle: DatabaseHandle, id: string, consumer: string, generation: number): Result<{ duplicate: boolean }> {
  const result = write(handle, ({ db }) => {
    const row = db.query<Parameters<typeof toDelivery>[0]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (row === null) return { kind: "refused" as const, result: failed(`delivery ${id} refused: delivery is unknown`) };
    const delivery = toDelivery(row);
    // core/ack.ts:4-22 defines duplicate acknowledged acks, accepted statuses, ownership, generation and fenced refusal.
    const decision = acknowledgeDelivery(delivery.status, String(delivery.consumer ?? ""), String(delivery.consumerGeneration ?? 0), consumer, generation, id);
    if (decision.kind !== "ok") return { kind: "refused" as const, result: decision };
    if (!decision.value.duplicate) {
      const now = new Date().toISOString();
      db.run("UPDATE deliveries SET status = 'acknowledged', acknowledged_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
    }
    return { kind: "accepted" as const, value: decision.value };
  });
  if (result.kind !== "ok") return result;
  return result.value.kind === "accepted" ? ok(result.value.value) : result.value.result;
}

export function fenceDelivery(handle: DatabaseHandle, id: string, consumer: string, generation: number): Result<DeliveryRecord | undefined> {
  return write(handle, ({ db }) => {
    const row = db.query<Parameters<typeof toDelivery>[0]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (row === null) return undefined;
    const delivery = toDelivery(row);
    // core/check.ts:66-70 admits outstanding or full-mode superseded rows; orchestrate-parent.ts:138-150 skips foreign consumers and fences a same-consumer stale generation.
    if ((delivery.status !== "outstanding" && delivery.status !== "superseded") || delivery.consumer !== consumer || delivery.consumerGeneration === generation) return delivery;
    const now = new Date().toISOString();
    db.run("UPDATE deliveries SET status = 'fenced', fenced_at = ?, updated_at = ? WHERE id = ? AND status IN ('outstanding', 'superseded')", [now, now, id]);
    const fenced = db.query<Parameters<typeof toDelivery>[0]>("SELECT * FROM deliveries WHERE id = ?").get(id);
    return fenced === null ? undefined : toDelivery(fenced);
  });
}

export type WaiterRecord = Readonly<{ dispatchId: string; pid: number; parentSessionId: string | null; parentHost: string | null; createdAt: string }>;
type WaiterRow = Readonly<{ dispatch_id: string; pid: number; parent_session_id: string | null; parent_host: string | null; created_at: string }>;

function waiterRecord(row: WaiterRow): WaiterRecord {
  return { dispatchId: row.dispatch_id, pid: row.pid, parentSessionId: row.parent_session_id, parentHost: row.parent_host, createdAt: row.created_at };
}

export function getWaiter(handle: DatabaseHandle, dispatchId: string): Result<WaiterRecord | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<WaiterRow>("SELECT * FROM waiters WHERE dispatch_id = ?").get(dispatchId);
    return row === null ? undefined : waiterRecord(row);
  });
}

export function putWaiter(handle: DatabaseHandle, waiter: WaiterRecord): Result<void> {
  return write(handle, ({ db }) => {
    db.run("INSERT INTO waiters (dispatch_id, pid, parent_session_id, parent_host, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(dispatch_id) DO UPDATE SET pid = excluded.pid, parent_session_id = excluded.parent_session_id, parent_host = excluded.parent_host, created_at = excluded.created_at", [waiter.dispatchId, waiter.pid, waiter.parentSessionId, waiter.parentHost, waiter.createdAt]);
  });
}

export function deleteWaiter(handle: DatabaseHandle, dispatchId: string): Result<boolean> {
  return write(handle, ({ db }) => db.run("DELETE FROM waiters WHERE dispatch_id = ?", [dispatchId]).changes > 0);
}

export type NudgeRecord = Readonly<{ id: number; dispatchId: string; pointer: string; outcome: string; reason: string; createdAt: string }>;
type NudgeRow = Readonly<{ id: number; dispatch_id: string; pointer: string; outcome: string; reason: string; created_at: string }>;
const nudgeRecord = (row: NudgeRow): NudgeRecord => ({ id: row.id, dispatchId: row.dispatch_id, pointer: row.pointer, outcome: row.outcome, reason: row.reason, createdAt: row.created_at });

export function appendNudge(db: DatabaseAdapter, dispatchId: string, pointer: string, outcome: string, reason: string, createdAt = new Date().toISOString()): Result<void> {
  try {
    const cleanReason = reason.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "unspecified";
    db.run("INSERT INTO nudge_events (dispatch_id, pointer, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?)", [dispatchId, pointer, outcome, cleanReason, createdAt]);
    return ok(undefined);
  } catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
}

export function listNudges(handle: DatabaseHandle, dispatchId: string): Result<NudgeRecord[]> {
  return read(handle, ({ db }) => db.query<NudgeRow>("SELECT * FROM nudge_events WHERE dispatch_id = ? ORDER BY id").all(dispatchId).map(nudgeRecord));
}

export function nudgeCursor(handle: DatabaseHandle, dispatchId: string): Result<number> {
  return read(handle, ({ db }) => db.query<{ cursor: number | null }>("SELECT max(id) AS cursor FROM nudge_events WHERE dispatch_id = ?").get(dispatchId)?.cursor ?? 0);
}

function outboxRow(db: DatabaseAdapter, id: string): OutboxDetails | undefined {
  const row = db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE id = ?").get(id);
  return row === null ? undefined : { ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail };
}

function enqueueOutboxValue(db: DatabaseAdapter, input: OutboxInput, now: string): void {
  if (input.id === "" || input.targetKind === "" || input.target === "") throw new TypeError("outbox requires id, targetKind and target");
  db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at, lease_holder, detail) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL, NULL)", [input.id, input.dispatchId ?? null, input.targetKind, input.target, encode(input.payload), now, now]);
}

// Accepts the adapter from a caller-owned withWrite callback; it does not open or commit a transaction.
export function enqueueOutbox(db: DatabaseAdapter, input: OutboxInput): Result<void> {
  try {
    enqueueOutboxValue(db, input, new Date().toISOString());
    return ok(undefined);
  } catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
}

export function listOutbox(handle: DatabaseHandle): Result<OutboxDetails[]> {
  return read(handle, ({ db }) => db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox ORDER BY created_at, id").all().map((row) => ({ ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail })));
}

export function claimOutbox(handle: DatabaseHandle, id: string, holder: string, leaseSeconds: number): Result<OutboxDetails | undefined> {
  if (holder === "") return failed("outbox holder must be non-empty");
  if (!Number.isFinite(leaseSeconds)) return failed("outbox lease seconds must be finite");
  const now = new Date();
  const nowText = now.toISOString();
  const leaseUntil = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
  return write(handle, ({ db }) => {
    const current = outboxRow(db, id);
    if (current === undefined) return undefined;
    if (current.status !== "pending" && !(current.status === "sending" && current.leaseUntil !== null && current.leaseUntil <= nowText)) return undefined;
    db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1, lease_until = ?, lease_holder = ?, updated_at = ? WHERE id = ?", [leaseUntil, holder, nowText, id]);
    return outboxRow(db, id);
  });
}

export function finishOutbox(handle: DatabaseHandle, id: string, status: "sent" | "failed" | "suppressed", detail: string | null = null): Result<void> {
  const now = new Date().toISOString();
  const result = write(handle, ({ db }) => {
    const current = outboxRow(db, id);
    if (current === undefined) return { kind: "missing" as const };
    if (current.status !== "sending") return { kind: "invalid_state" as const, current: current.status };
    db.run("UPDATE outbox SET status = ?, detail = ?, lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE id = ? AND status = 'sending'", [status, detail, now, id]);
    return { kind: "finished" as const };
  });
  if (result.kind !== "ok") return result;
  if (result.value.kind === "missing") return failed(`outbox item not found: ${id}`);
  if (result.value.kind === "invalid_state") return failed(`outbox item ${id} cannot finish from status ${result.value.current}`);
  return ok(undefined);
}

export type LeaseRecord = Readonly<{ key: string; holder: string; expiresAt: string }>;

export function acquireLease(handle: DatabaseHandle, key: string, holder: string, seconds: number): Result<boolean> {
  if (key === "" || holder === "") return failed("lease key and holder must be non-empty");
  if (!Number.isFinite(seconds)) return failed("lease seconds must be finite");
  const now = new Date();
  const nowText = now.toISOString();
  const expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  return write(handle, ({ db }) => db.run("INSERT INTO leases (key, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE leases.expires_at <= ?", [key, holder, expiresAt, nowText]).changes > 0);
}

export function releaseLease(handle: DatabaseHandle, key: string, holder: string): Result<boolean> {
  return write(handle, ({ db }) => db.run("DELETE FROM leases WHERE key = ? AND holder = ?", [key, holder]).changes > 0);
}
