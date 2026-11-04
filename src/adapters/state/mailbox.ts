import { acknowledgeDelivery } from "../../core/ack.js";
import { addSupersedeSummary, supersedeDelivery, type SupersedeSummary } from "../../core/parent-reply.js";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { insertDelivery, listDeliveries as queryDeliveries, toDelivery, type DeliveryRecord } from "../../db/queries/deliveries.js";
import { getMessage as queryMessage, insertMessage, listMessages as queryMessages, toMessage, type MessageRecord } from "../../db/queries/messages.js";
import { decode, encode, object, type DatabaseAdapter } from "../../db/queries/types.js";
import { listLeases as queryLeases, toOutbox, type LeaseRecord as QueryLeaseRecord, type OutboxRecord } from "../../db/queries/outbox-leases.js";
import type { DatabaseHandle } from "../../db/db.js";
import { read, write } from "./shared.js";

export type OutboxInput = Readonly<{ id: string; dispatchId?: string | null; targetKind: string; target: string; payload: unknown }>;
export type OutboxDetails = OutboxRecord & Readonly<{ leaseHolder: string | null; detail: string | null }>;
export type OutboxCursor = Readonly<{ createdAt: string; id: string }>;
export type OutboxDetailsPage = Readonly<{ rows: OutboxDetails[]; nextCursor?: OutboxCursor }>;
export type DeliveryInput = Readonly<Record<string, unknown>>;
export type NudgeInput = Readonly<{ dispatchId: string; pointer: string; outcome: string; reason: string; createdAt?: string }>;
export type AppendMessageEffects = Readonly<{ delivery?: DeliveryInput; outbox?: OutboxInput }>;
export type AppendMessageOptions = AppendMessageEffects & Readonly<{ derive?: (previous: readonly MessageRecord[]) => AppendMessageEffects }>;
export type AppendParentReplyOptions = Readonly<{ supersede: boolean; outbox?: OutboxInput }>;

export function acknowledgeImplicitDelivery(handle: DatabaseHandle, dispatchId: string, deliveryId: string, recipient: "child" | "parent", now = new Date().toISOString(), consumer?: string): Result<boolean> {
  return write(handle, ({ db }) => acknowledgeImplicitDeliveryInTransaction(db, dispatchId, deliveryId, recipient, now, consumer));
}

export function acknowledgeImplicitDeliveryInTransaction(db: DatabaseAdapter, dispatchId: string, deliveryId: string, recipient: "child" | "parent", now = new Date().toISOString(), consumer?: string): boolean {
  const delivery = queryDeliveries(db, dispatchId).find((item) => item.id === deliveryId);
  if (delivery === undefined || delivery.recipient !== recipient || !["outstanding", "superseded"].includes(delivery.status)) return false;
  const changed = db.run("UPDATE deliveries SET status = 'acknowledged', acknowledged_at = ?, updated_at = ?, consumer = COALESCE(consumer, ?) WHERE id = ? AND status IN ('outstanding', 'superseded')", [now, now, consumer ?? null, deliveryId]).changes > 0;
  if (changed) finishAcknowledgedOutbox(db, delivery, recipient, now);
  return changed;
}

function finishAcknowledgedOutbox(db: DatabaseAdapter, delivery: DeliveryRecord, recipient: "child" | "parent", now: string): void {
  const kind = recipient === "child" ? "child-delivery" : "parent-pointer";
  const sequences = new Set(Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : []);
  if (sequences.size === 0) return;
  const rows = db.query<{ id: string; payload: string }>("SELECT id, payload FROM outbox WHERE dispatch_id = ? AND target_kind = ? AND status IN ('pending', 'sending')").all(delivery.dispatchId, kind);
  for (const row of rows) {
    let payload: unknown;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    if (typeof payload !== "object" || payload === null || !("sequence" in payload)) continue;
    const sequence = (payload as { sequence?: unknown }).sequence;
    if (typeof sequence !== "number" || !sequences.has(sequence)) continue;
    db.run("UPDATE outbox SET status = 'sent', detail = 'receiver acknowledged', lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'sending')", [now, row.id]);
  }
}

function findMessageByKey(db: DatabaseAdapter, key: string): MessageRecord | undefined {
  const row = db.query<{ dispatch_id: string; seq: number; from: string; type: string; text: string; body: string | null; session_id: string | null; created_at: string; idempotency_key: string | null; extra: string }>("SELECT * FROM messages WHERE idempotency_key = ?").get(key);
  return row === null ? undefined : toMessage(row);
}

function nextMessageSequence(db: DatabaseAdapter, dispatchId: string): number {
  return (db.query<{ seq: number | null }>("SELECT max(seq) AS seq FROM messages WHERE dispatch_id = ?").get(dispatchId)?.seq ?? 0) + 1;
}

export function appendMessage(handle: DatabaseHandle, dispatchId: string, message: Readonly<Record<string, unknown>>, options: AppendMessageOptions = {}): Result<MessageRecord> {
  const appended = write(handle, ({ db }) => {
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
    const previous = options.derive === undefined ? [] : queryMessages(db, dispatchId);
    insertMessage(db, dispatchId, assigned);
    const derived = options.derive?.(previous) ?? {};
    const delivery = options.delivery ?? derived.delivery;
    const outbox = options.outbox ?? derived.outbox;
    if (delivery !== undefined) {
      const now = new Date().toISOString();
      insertDelivery(db, {
        ...delivery,
        dispatchId,
        messageSeqs: [assigned.seq],
        createdAt: typeof delivery.createdAt === "string" ? delivery.createdAt : now,
        updatedAt: typeof delivery.updatedAt === "string" ? delivery.updatedAt : now,
      });
    }
    if (outbox !== undefined) enqueueOutboxValue(db, { ...outbox, dispatchId }, new Date().toISOString());
    const inserted = queryMessage(db, dispatchId, assigned.seq);
    if (inserted === undefined) throw new Error("appended message was not visible");
    return inserted;
  });
  return appended;
}

export function appendParentReply(handle: DatabaseHandle, dispatchId: string, message: Readonly<Record<string, unknown>>, options: AppendParentReplyOptions): Result<MessageRecord> {
  return write(handle, ({ db }) => {
    const now = typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString();
    const messages = queryMessages(db, dispatchId);
    for (const delivery of queryDeliveries(db, dispatchId)) {
      if (delivery.recipient !== "parent" || delivery.status !== "outstanding" || !Array.isArray(delivery.messageSeqs)) continue;
      if (!delivery.messageSeqs.some((sequence) => messages.some((item) => item.seq === sequence && item.from === "child" && item.type === "ask"))) continue;
      acknowledgeImplicitDeliveryInTransaction(db, dispatchId, delivery.id, "parent", now);
    }
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
      if (value.type === "reply") {
        const deliveryId = `delivery-${now.replace(/[-:.TZ]/g, "")}-${process.pid}-${randomUUID().slice(0, 8)}`;
        insertDelivery(db, { id: deliveryId, dispatchId, recipient: "child", messageSeqs: [row.seq], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null });
      }
      return row;
    };

    if (summary.delivered > 0) append({ from: "parent", type: "withdrawal", text: `withdrawn parent direction message sequence(s): ${summary.deliveredSequences.join(", ")}`, sessionId: "" });
    const reply = append({ ...message, from: "parent", type: "reply", text: message.text, sessionId: message.sessionId ?? "" });
    if (options.outbox !== undefined) {
      const payload = object(options.outbox.payload);
      enqueueOutboxValue(db, { ...options.outbox, dispatchId, payload: { ...payload, dispatchId, sequence: reply.seq } }, now);
    }
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

export function listDeliveriesInTransaction(db: DatabaseAdapter, dispatchId: string): DeliveryRecord[] {
  return queryDeliveries(db, dispatchId);
}

export function cancelQueuedMessage(handle: DatabaseHandle, dispatchId: string, itemId: string, reason: string, actor: string): Result<void> {
  const result = write(handle, ({ db }) => {
    const deliveries = queryDeliveries(db, dispatchId);
    const messages = queryMessages(db, dispatchId);
    const outboxRows = db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>(
      "SELECT * FROM outbox WHERE dispatch_id = ?",
    ).all(dispatchId).map(toOutbox);
    let delivery = deliveries.find((item) => item.id === itemId);
    let outbox = outboxRows.find((item) => item.id === itemId);
    if (delivery === undefined && outbox === undefined) return { kind: "refused" as const, message: `queued item ${itemId} not found` };

    if (delivery === undefined && outbox !== undefined) {
      const payload = object(outbox.payload);
      const sequence = typeof payload.sequence === "number" ? payload.sequence : undefined;
      if (sequence !== undefined) delivery = deliveries.find((item) => Array.isArray(item.messageSeqs) && item.messageSeqs.includes(sequence));
    }
    if (delivery !== undefined) {
      if (delivery.status === "acknowledged") return { kind: "refused" as const, message: `queued item ${itemId} was already read` };
      if (delivery.status !== "outstanding" && delivery.status !== "superseded") return { kind: "refused" as const, message: `queued item ${itemId} cannot be cancelled from state ${delivery.status}` };
      const sequence = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.find((value): value is number => typeof value === "number") : undefined;
      const message = messages.find((item) => item.seq === sequence);
      if (message === undefined || message.from !== "parent" || message.type !== "reply") return { kind: "refused" as const, message: `queued item ${itemId} is not a parent message` };
      if (outbox === undefined) {
        outbox = outboxRows.find((item) => {
          const payload = object(item.payload);
          return item.targetKind === "child-delivery" && payload.sequence === sequence;
        });
      }
      if (outbox?.status === "sent") return { kind: "refused" as const, message: `queued item ${itemId} was already sent` };
      if (outbox?.status === "sending") return { kind: "refused" as const, message: `queued item ${itemId} is currently being delivered` };
      const now = new Date().toISOString();
      const updated = db.run("UPDATE deliveries SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('outstanding', 'superseded')", [now, delivery.id]);
      if (updated.changes !== 1) return { kind: "refused" as const, message: `queued item ${itemId} changed while it was being cancelled` };
      if (outbox !== undefined && ["pending", "failed", "suppressed"].includes(outbox.status)) {
        db.run("UPDATE outbox SET status = 'cancelled', lease_until = NULL, lease_holder = NULL, updated_at = ?, detail = ? WHERE id = ? AND status IN ('pending', 'failed', 'suppressed')", [now, reason, outbox.id]);
      }
      const seq = nextMessageSequence(db, dispatchId);
      insertMessage(db, dispatchId, { seq, from: "parent", type: "cancel", text: reason, sessionId: actor, createdAt: now, cancelledItemId: itemId });
      return { kind: "cancelled" as const };
    }

    if (outbox === undefined || !["pending", "failed", "suppressed"].includes(outbox.status)) {
      return { kind: "refused" as const, message: `queued item ${itemId} cannot be cancelled from state ${outbox?.status ?? "unknown"}` };
    }
    const now = new Date().toISOString();
    db.run("UPDATE outbox SET status = 'cancelled', lease_until = NULL, lease_holder = NULL, updated_at = ?, detail = ? WHERE id = ?", [now, reason, outbox.id]);
    const seq = nextMessageSequence(db, dispatchId);
    insertMessage(db, dispatchId, { seq, from: "parent", type: "cancel", text: reason, sessionId: actor, createdAt: now, cancelledItemId: itemId });
    return { kind: "cancelled" as const };
  });
  if (result.kind !== "ok") return result;
  return result.value.kind === "cancelled" ? ok(undefined) : failed(result.value.message);
}

export function setDeliveryTransport(handle: DatabaseHandle, dispatchId: string, sequence: number, transport: string, reason?: string, channel?: string): Result<void> {
  return write(handle, ({ db }) => {
    const row = db.query<{ id: string; extra: string }>("SELECT id, extra FROM deliveries WHERE dispatch_id = ? AND message_seq = ?").get(dispatchId, sequence);
    if (row === null) return;
    const transportAt = new Date().toISOString();
    const transportChannel = channel ?? (reason === "peer-socket-verified" || reason === "peer-socket-pending" ? "peer-socket" : undefined);
    db.run("UPDATE deliveries SET extra = ? WHERE id = ?", [encode({ ...object(decode<unknown>(row.extra)), transport, transportAt, ...(reason === undefined ? {} : { transportReason: reason }), ...(transportChannel === undefined ? {} : { transportChannel }) }), row.id]);
  });
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
      if (delivery.recipient === "child" || delivery.recipient === "parent") finishAcknowledgedOutbox(db, delivery, delivery.recipient, now);
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

export function deleteWaiter(handle: DatabaseHandle, dispatchId: string, pid?: number, createdAt?: string): Result<boolean> {
  return write(handle, ({ db }) => pid === undefined
    ? db.run("DELETE FROM waiters WHERE dispatch_id = ?", [dispatchId]).changes > 0
    : db.run("DELETE FROM waiters WHERE dispatch_id = ? AND pid = ? AND created_at = ?", [dispatchId, pid, createdAt ?? ""]).changes > 0);
}

export type NudgeRecord = Readonly<{ id: number; dispatchId: string; pointer: string; outcome: string; reason: string; createdAt: string }>;
type NudgeRow = Readonly<{ id: number; dispatch_id: string; pointer: string; outcome: string; reason: string; created_at: string }>;
const nudgeRecord = (row: NudgeRow): NudgeRecord => ({ id: row.id, dispatchId: row.dispatch_id, pointer: row.pointer, outcome: row.outcome, reason: row.reason, createdAt: row.created_at });
const NUDGE_RETENTION_PER_DISPATCH = 1_000;

export function appendNudge(db: DatabaseAdapter, dispatchId: string, pointer: string, outcome: string, reason: string, createdAt = new Date().toISOString()): Result<void> {
  try {
    const cleanReason = reason.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "unspecified";
    db.run("INSERT INTO nudge_events (dispatch_id, pointer, outcome, reason, created_at) VALUES (?, ?, ?, ?, ?)", [dispatchId, pointer, outcome, cleanReason, createdAt]);
    const retained = db.query<{ id: number }>("SELECT id FROM nudge_events WHERE dispatch_id = ? ORDER BY id DESC LIMIT 1000").all(dispatchId);
    const oldestRetained = retained.at(-1);
    if (oldestRetained !== undefined && retained.length === NUDGE_RETENTION_PER_DISPATCH) {
      db.run("DELETE FROM nudge_events WHERE dispatch_id = ? AND id < ?", [dispatchId, oldestRetained.id]);
    }
    return ok(undefined);
  } catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
}

export function listNudges(handle: DatabaseHandle, dispatchId: string): Result<NudgeRecord[]> {
  return read(handle, ({ db }) => db.query<NudgeRow>("SELECT * FROM nudge_events WHERE dispatch_id = ? ORDER BY id LIMIT 1000").all(dispatchId).map(nudgeRecord));
}

export function nudgeCursor(handle: DatabaseHandle, dispatchId: string): Result<number> {
  return read(handle, ({ db }) => db.query<{ cursor: number | null }>("SELECT id AS cursor FROM nudge_events WHERE dispatch_id = ? ORDER BY id DESC LIMIT 1").get(dispatchId)?.cursor ?? 0);
}

function outboxRow(db: DatabaseAdapter, id: string): OutboxDetails | undefined {
  const row = db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE id = ?").get(id);
  return row === null ? undefined : { ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail };
}

export function getOutbox(handle: DatabaseHandle, id: string): Result<OutboxDetails | undefined> {
  return read(handle, ({ db }) => outboxRow(db, id));
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
  return read(handle, ({ db }) => {
    const records: OutboxDetails[] = [];
    let cursor: { createdAt: string; id: string } | undefined;
    for (;;) {
      const rows = cursor === undefined
        ? db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox ORDER BY created_at, id LIMIT 100").all()
        : db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at, id LIMIT 100").all(cursor.createdAt, cursor.createdAt, cursor.id);
      records.push(...rows.map((row) => ({ ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail })));
      const last = rows.at(-1);
      if (rows.length < 100 || last === undefined) return records;
      cursor = { createdAt: last.created_at, id: last.id };
    }
  });
}

export function listOutboxPage(handle: DatabaseHandle, options: Readonly<{ dispatchId?: string; after?: OutboxCursor; limit?: number }> = {}): Result<OutboxDetailsPage> {
  const requestedLimit = options.limit ?? 100;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, Math.trunc(requestedLimit))) : 100;
  return read(handle, ({ db }) => {
    const cursor = options.after;
    const rows = options.dispatchId === undefined
      ? cursor === undefined
        ? db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox ORDER BY created_at, id LIMIT ?").all(limit + 1)
        : db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at, id LIMIT ?").all(cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
      : cursor === undefined
        ? db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE dispatch_id = ? ORDER BY created_at, id LIMIT ?").all(options.dispatchId, limit + 1)
        : db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE dispatch_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?").all(options.dispatchId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1);
    const pageRows = rows.slice(0, limit);
    const records = pageRows.map((row) => ({ ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail }));
    const last = pageRows.at(-1);
    return {
      rows: records,
      ...(rows.length > limit && last !== undefined ? { nextCursor: { createdAt: last.created_at, id: last.id } } : {}),
    };
  });
}

export const closedParentOutboxDispatchIdsSql =
  "SELECT dispatch_id FROM outbox WHERE target_kind = 'parent-pointer' AND status IN ('pending', 'sending') AND dispatch_id IS NOT NULL " +
  "UNION SELECT dispatch_id FROM outbox WHERE target_kind = 'parent-pointer' AND status = 'sent' AND dispatch_id IS NOT NULL " +
  "AND detail LIKE 'peer-verification:%' AND CASE WHEN json_valid(substr(detail, 19)) THEN json_extract(substr(detail, 19), '$.state') END IN ('pending', 'fallback-queued')";

export const openOutboxSql =
  "SELECT * FROM outbox WHERE status IN ('pending', 'sending') AND dispatch_id IS NOT NULL AND created_at <= ? ORDER BY created_at, id";

export function listClosedParentOutboxDispatchIds(handle: DatabaseHandle): Result<string[]> {
  return read(handle, ({ db }) => db.query<{ dispatch_id: string }>(closedParentOutboxDispatchIdsSql).all().map((row) => row.dispatch_id));
}

export function listOpenOutbox(handle: DatabaseHandle, createdBefore: string): Result<OutboxDetails[]> {
  return read(handle, ({ db }) => db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>(openOutboxSql)
    .all(createdBefore).map((row) => ({ ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail })));
}

export type PendingPeerVerification = Readonly<{ id: string; dispatchId: string | null; status: string; record: PeerVerificationRecord }>;
export type PendingPeerVerificationPage = Readonly<{ rows: readonly PendingPeerVerification[]; nextCursor?: OutboxCursor }>;

export function listPendingOutboxPeerVerifications(handle: DatabaseHandle, options: Readonly<{ after?: OutboxCursor; limit?: number }> = {}): Result<PendingPeerVerificationPage> {
  const requestedLimit = options.limit ?? 100;
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(1000, Math.trunc(requestedLimit))) : 100;
  return read(handle, ({ db }) => {
    const cursor = options.after;
    const query = cursor === undefined
      ? db.query<{ id: string; dispatch_id: string | null; status: string; detail: string | null; created_at: string }>("SELECT id, dispatch_id, status, detail, created_at FROM outbox WHERE status = 'sent' AND detail LIKE ? AND CASE WHEN json_valid(substr(detail, 19)) THEN json_extract(substr(detail, 19), '$.state') END = 'pending' ORDER BY created_at, id LIMIT ?")
      : db.query<{ id: string; dispatch_id: string | null; status: string; detail: string | null; created_at: string }>("SELECT id, dispatch_id, status, detail, created_at FROM outbox WHERE status = 'sent' AND detail LIKE ? AND CASE WHEN json_valid(substr(detail, 19)) THEN json_extract(substr(detail, 19), '$.state') END = 'pending' AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT ?");
    const rows = cursor === undefined
      ? query.all(`${peerStatePrefix}%`, limit + 1)
      : query.all(`${peerStatePrefix}%`, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1);
    const pageRows = rows.slice(0, limit);
    const records = pageRows.flatMap((row) => {
      const record = peerState(row.detail);
      return record?.state === "pending" ? [{ id: row.id, dispatchId: row.dispatch_id, status: row.status, record }] : [];
    });
    const last = pageRows.at(-1);
    return {
      rows: records,
      ...(rows.length > limit && last !== undefined ? { nextCursor: { createdAt: last.created_at, id: last.id } } : {}),
    };
  });
}

export function listOutboxForDispatch(handle: DatabaseHandle, dispatchId: string): Result<OutboxDetails[]> {
  return read(handle, ({ db }) => {
    const records: OutboxDetails[] = [];
    let cursor: { createdAt: string; id: string } | undefined;
    for (;;) {
      const rows = cursor === undefined
        ? db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE dispatch_id = ? ORDER BY created_at, id LIMIT 100").all(dispatchId)
        : db.query<Parameters<typeof toOutbox>[0] & Readonly<{ lease_holder: string | null; detail: string | null }>>("SELECT * FROM outbox WHERE dispatch_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at, id LIMIT 100").all(dispatchId, cursor.createdAt, cursor.createdAt, cursor.id);
      records.push(...rows.map((row) => ({ ...toOutbox(row), leaseHolder: row.lease_holder, detail: row.detail })));
      const last = rows.at(-1);
      if (rows.length < 100 || last === undefined) return records;
      cursor = { createdAt: last.created_at, id: last.id };
    }
  });
}

export function getQueuedDispatchId(handle: DatabaseHandle, itemId: string): Result<string | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<{ dispatch_id: string | null }>("SELECT dispatch_id FROM deliveries WHERE id = ? UNION ALL SELECT dispatch_id FROM outbox WHERE id = ? LIMIT 1").get(itemId, itemId);
    return row?.dispatch_id ?? undefined;
  });
}

export function listChildAnsweredDispatches(handle: DatabaseHandle, dispatchIds: readonly string[]): Result<ReadonlySet<string>> {
  return read(handle, ({ db }) => {
    const answered = new Set<string>();
    const unique = [...new Set(dispatchIds)].filter((dispatchId) => dispatchId !== "");
    for (let offset = 0; offset < unique.length; offset += 500) {
      const batch = unique.slice(offset, offset + 500);
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(", ");
      const rows = db.query<{ dispatch_id: string }>(`SELECT DISTINCT dispatch_id FROM messages WHERE dispatch_id IN (${placeholders}) AND "from" = 'child' AND type IN ('received', 'ask', 'done') ORDER BY dispatch_id LIMIT ?`).all(...batch, 500);
      for (const row of rows) answered.add(row.dispatch_id);
    }
    return answered;
  });
}

export function listLeases(handle: DatabaseHandle): Result<QueryLeaseRecord[]> {
  return read(handle, ({ db }) => queryLeases(db));
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
    const abandoned = current.status === "sending" && current.leaseHolder !== null && leaseHolderIsAlive(current.leaseHolder) === false;
    const expired = current.status === "sending" && current.leaseUntil !== null && current.leaseUntil <= nowText;
    if (current.status !== "pending" && !abandoned && !expired) return undefined;
    db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1, lease_until = ?, lease_holder = ?, updated_at = ? WHERE id = ?", [leaseUntil, holder, nowText, id]);
    return outboxRow(db, id);
  });
}

export function renewOutboxLease(handle: DatabaseHandle, id: string, holder: string, leaseSeconds: number): Result<boolean> {
  if (holder === "") return failed("outbox holder must be non-empty");
  if (!Number.isFinite(leaseSeconds)) return failed("outbox lease seconds must be finite");
  const now = new Date();
  return write(handle, ({ db }) => db.run(
    "UPDATE outbox SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND lease_holder = ? AND lease_until > ?",
    [new Date(now.getTime() + leaseSeconds * 1000).toISOString(), now.toISOString(), id, holder, now.toISOString()],
  ).changes > 0);
}

export type PeerVerificationRecord = Readonly<{
  state: "pending" | "fallback-queued" | "delivered" | "fallback-delivered" | "superseded";
  messageId: string;
  agent: string;
  channel: string;
  transcript?: string;
  transcriptOffset?: number;
  agentVersion: string;
  acceptedAt: number;
  resumeAttempts?: number;
  nextResumeAt?: number;
}>;
const peerStatePrefix = "peer-verification:";

function peerState(detail: string | null): PeerVerificationRecord | undefined {
  if (detail === null || !detail.startsWith(peerStatePrefix)) return undefined;
  try {
    const value = JSON.parse(detail.slice(peerStatePrefix.length)) as Partial<PeerVerificationRecord>;
    const agent = value.agent ?? "claude";
    const channel = value.channel ?? "peer-socket";
    return typeof value.messageId === "string" && typeof agent === "string" && typeof channel === "string" &&
      typeof value.state === "string" && typeof value.agentVersion === "string" && Number.isSafeInteger(value.acceptedAt) &&
      (value.transcript === undefined || (typeof value.transcript === "string" && Number.isSafeInteger(value.transcriptOffset)))
      ? { ...value, agent, channel } as PeerVerificationRecord : undefined;
  } catch { return undefined; }
}

export function getOutboxPeerVerification(handle: DatabaseHandle, id: string): Result<PeerVerificationRecord | undefined> {
  return read(handle, ({ db }) => peerState(db.query<{ detail: string | null }>("SELECT detail FROM outbox WHERE id = ?").get(id)?.detail ?? null));
}

export function listOutboxPeerVerifications(handle: DatabaseHandle): Result<readonly Readonly<{ id: string; dispatchId: string | null; status: string; record: PeerVerificationRecord }>[]> {
  return read(handle, ({ db }) => db.query<{ id: string; dispatch_id: string | null; status: string; detail: string | null }>("SELECT id, dispatch_id, status, detail FROM outbox WHERE detail LIKE ?").all(`${peerStatePrefix}%`).flatMap((row) => {
    const record = peerState(row.detail);
    return record === undefined ? [] : [{ id: row.id, dispatchId: row.dispatch_id, status: row.status, record }];
  }));
}

export function markOutboxPeerSent(handle: DatabaseHandle, id: string, holder: string, record: PeerVerificationRecord): Result<boolean> {
  if (id === "" || holder === "" || record.messageId === "" || record.agent === "" || record.channel === "") return failed("outbox and delivery verification details are invalid");
  const now = new Date().toISOString();
  return write(handle, ({ db }) => db.run(
    "UPDATE outbox SET detail = ?, updated_at = ? WHERE id = ? AND status = 'sending' AND lease_holder = ?",
    [`${peerStatePrefix}${JSON.stringify(record)}`, now, id, holder],
  ).changes > 0);
}

export function finishOutboxPeerVerification(handle: DatabaseHandle, id: string, state: PeerVerificationRecord["state"]): Result<boolean> {
  const now = new Date().toISOString();
  return write(handle, ({ db }) => {
    const row = db.query<{ detail: string | null }>("SELECT detail FROM outbox WHERE id = ?").get(id);
    const current = peerState(row?.detail ?? null);
    if (current === undefined) return false;
    db.run("UPDATE outbox SET detail = ?, updated_at = ? WHERE id = ?", [`${peerStatePrefix}${JSON.stringify({ ...current, state, resumeAttempts: 0, nextResumeAt: undefined })}`, now, id]);
    return true;
  });
}

export function schedulePeerVerificationResume(handle: DatabaseHandle, id: string, now = Date.now()): Result<Readonly<{ scheduled: boolean; attempt: number; nextEligibleAt: number }>> {
  return write(handle, ({ db }) => {
    const row = db.query<{ detail: string | null; status: string }>("SELECT detail, status FROM outbox WHERE id = ?").get(id);
    const current = peerState(row?.detail ?? null);
    if (current === undefined || current.state !== "pending" || row?.status !== "sent") return { scheduled: false, attempt: current?.resumeAttempts ?? 0, nextEligibleAt: current?.nextResumeAt ?? now };
    const attempt = current.resumeAttempts ?? 0;
    if (current.nextResumeAt !== undefined && now < current.nextResumeAt) return { scheduled: false, attempt, nextEligibleAt: current.nextResumeAt };
    const nextAttempt = attempt + 1;
    const delay = Math.min(6 * 60 * 60 * 1000, 5 * 60 * 1000 * 2 ** attempt);
    const nextEligibleAt = now + delay;
    db.run("UPDATE outbox SET detail = ?, updated_at = ? WHERE id = ? AND status = 'sent'", [`${peerStatePrefix}${JSON.stringify({ ...current, resumeAttempts: nextAttempt, nextResumeAt: nextEligibleAt })}`, new Date(now).toISOString(), id]);
    return { scheduled: true, attempt: nextAttempt, nextEligibleAt };
  });
}

export function supersedeClosedParentDeliveries(handle: DatabaseHandle, dispatchId: string, reason: string): Result<void> {
  if (dispatchId === "" || reason === "") return failed("closed delivery settlement requires a dispatch and reason");
  const now = new Date().toISOString();
  return write(handle, ({ db }) => {
    db.run("UPDATE deliveries SET status = 'superseded', updated_at = ? WHERE dispatch_id = ? AND json_extract(extra, '$.recipient') = 'parent' AND status = 'outstanding'", [now, dispatchId]);
    db.run("UPDATE outbox SET status = 'suppressed', detail = ?, lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE dispatch_id = ? AND target_kind = 'parent-pointer' AND status IN ('pending', 'sending')", [reason, now, dispatchId]);
    const verifications = db.query<{ id: string; detail: string | null }>("SELECT id, detail FROM outbox WHERE dispatch_id = ? AND target_kind = 'parent-pointer' AND detail LIKE ? AND status = 'sent'").all(dispatchId, `${peerStatePrefix}%`);
    for (const item of verifications) {
      const current = peerState(item.detail);
      if (current?.state === "pending" || current?.state === "fallback-queued") {
        db.run("UPDATE outbox SET detail = ?, updated_at = ? WHERE id = ? AND status = 'sent'", [`${peerStatePrefix}${JSON.stringify({ ...current, state: "superseded" })}`, now, item.id]);
      }
    }
  });
}

export function requeueOutboxPeerFallback(handle: DatabaseHandle, id: string): Result<boolean> {
  const now = new Date().toISOString();
  return write(handle, ({ db }) => {
    const row = db.query<{ detail: string | null; status: string }>("SELECT detail, status FROM outbox WHERE id = ?").get(id);
    const current = peerState(row?.detail ?? null);
    if (current === undefined || current.state !== "pending" || row?.status !== "sent") return false;
    db.run("UPDATE outbox SET status = 'pending', detail = ?, lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE id = ? AND status = 'sent'", [
      `${peerStatePrefix}${JSON.stringify({ ...current, state: "fallback-queued" })}`, now, id,
    ]);
    return true;
  });
}

export function retryFailedChildOutbox(handle: DatabaseHandle, id: string, reason: string): Result<boolean> {
  const now = new Date().toISOString();
  const cleanReason = reason.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || "scheduled retry";
  return write(handle, ({ db }) => {
    const row = db.query<{ target_kind: string; status: string; detail: string | null; payload: string }>("SELECT target_kind, status, detail, payload FROM outbox WHERE id = ?").get(id);
    if (row === null || row.target_kind !== "child-delivery" || row.status !== "failed") return false;
    const detail = `retry reason: ${cleanReason}; previous failure: ${row.detail ?? "unspecified"}`;
    const payload = object(decode<unknown>(row.payload));
    const previousRetry = object(payload.retryState);
    const retryState = {
      nextRetryAt: Date.now() + 30_000,
      idleRetryUsed: cleanReason.includes("pane idle") || previousRetry.idleRetryUsed === true,
    };
    return db.run("UPDATE outbox SET status = 'pending', detail = ?, payload = ?, lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE id = ? AND status = 'failed'", [detail, encode({ ...payload, retryState }), now, id]).changes > 0;
  });
}

export function finishOutbox(handle: DatabaseHandle, id: string, status: "sent" | "failed" | "suppressed", detail: string | null = null, holder?: string): Result<boolean> {
  if (holder === "") return failed("outbox holder must be non-empty");
  const now = new Date().toISOString();
  return write(handle, ({ db }) => {
    const current = outboxRow(db, id);
    if (current === undefined) throw new Error(`outbox item not found: ${id}`);
    if (holder === undefined || current.status !== "sending" || current.leaseHolder !== holder || current.leaseUntil === null || current.leaseUntil <= now) return false;
    const keepPeerState = peerState(current.detail) !== undefined && status === "sent";
    return db.run("UPDATE outbox SET status = ?, detail = ?, lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE id = ? AND status = 'sending' AND lease_holder = ? AND lease_until > ?", [status, keepPeerState ? current.detail : detail, now, id, holder, now]).changes > 0;
  });
}

export function finishNotification(handle: DatabaseHandle, id: string, holder: string, status: "sent" | "failed" | "suppressed", event: NudgeInput): Result<boolean> {
  if (holder === "") return failed("outbox holder must be non-empty");
  const now = new Date().toISOString();
  const result = write(handle, ({ db }) => {
    const current = outboxRow(db, id);
    if (current === undefined) return { kind: "missing" as const };
    if (current.status !== "sending" || current.leaseHolder !== holder || current.leaseUntil === null || current.leaseUntil <= now) return { kind: "stale" as const };
    if (current.dispatchId !== event.dispatchId) throw new Error("notification event dispatch does not match outbox item");
    const keepPeerState = peerState(current.detail) !== undefined && status === "sent";
    const updated = db.run("UPDATE outbox SET status = ?, detail = ?, lease_until = NULL, lease_holder = NULL, updated_at = ? WHERE id = ? AND status = 'sending' AND lease_holder = ? AND lease_until > ?", [status, keepPeerState ? current.detail : event.reason, now, id, holder, now]);
    if (updated.changes === 0) return { kind: "stale" as const };
    const appended = appendNudge(db, event.dispatchId, event.pointer, event.outcome, event.reason, event.createdAt ?? now);
    if (appended.kind !== "ok") throw new Error(appended.error);
    return { kind: "finished" as const };
  });
  if (result.kind !== "ok") return result;
  if (result.value.kind === "stale") return ok(false);
  if (result.value.kind === "missing") return failed("outbox item not found: " + id);
  return ok(true);
}

export type LeaseRecord = Readonly<{ key: string; holder: string; expiresAt: string }>;

function leaseHolderIsAlive(holder: string): boolean | undefined {
  // Older resource-admission holders used `admission-<pid>-...`; accept that
  // persisted format as well as the pid-prefixed format used by new callers.
  const match = /^(?:admission-)?(\d+)-/.exec(holder);
  if (match === null) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
      ? false
      : true;
  }
}

export function acquireLease(handle: DatabaseHandle, key: string, holder: string, seconds: number): Result<boolean> {
  if (key === "" || holder === "") return failed("lease key and holder must be non-empty");
  if (!Number.isFinite(seconds)) return failed("lease seconds must be finite");
  const now = new Date();
  const nowText = now.toISOString();
  const expiresAt = new Date(now.getTime() + seconds * 1000).toISOString();
  return write(handle, ({ db }) => {
    const current = db.query<{ holder: string; expires_at: string }>("SELECT holder, expires_at FROM leases WHERE key = ?").get(key);
    if (current !== null && current.holder !== holder && current.expires_at > nowText && leaseHolderIsAlive(current.holder) === false) {
      db.run("DELETE FROM leases WHERE key = ? AND holder = ?", [key, current.holder]);
    }
    return db.run("INSERT INTO leases (key, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE leases.expires_at <= ? OR leases.holder = excluded.holder", [key, holder, expiresAt, nowText]).changes > 0;
  });
}

export function transferLease(handle: DatabaseHandle, key: string, from: string, to: string): Result<boolean> {
  if (to === "") return failed("lease holder must be non-empty");
  return write(handle, ({ db }) => db.run("UPDATE leases SET holder = ? WHERE key = ? AND holder = ?", [to, key, from]).changes > 0);
}

export function releaseLease(handle: DatabaseHandle, key: string, holder: string): Result<boolean> {
  return write(handle, ({ db }) => db.run("DELETE FROM leases WHERE key = ? AND holder = ?", [key, holder]).changes > 0);
}
