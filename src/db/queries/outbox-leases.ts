import { decode, encode, type DatabaseAdapter } from "./types.js";

export type OutboxRecord = Readonly<{
  id: string; dispatchId: string | null; targetKind: string; target: string; payload: unknown;
  status: "pending" | "sending" | "sent" | "failed" | "suppressed" | "cancelled"; attempts: number;
  leaseUntil: string | null; transport: string | null; createdAt: string; updatedAt: string;
}>;

type OutboxRow = Readonly<{
  id: string; dispatch_id: string | null; target_kind: string; target: string; payload: string;
  status: OutboxRecord["status"]; attempts: number; lease_until: string | null; transport: string | null;
  created_at: string; updated_at: string;
}>;

export function toOutbox(row: OutboxRow): OutboxRecord {
  return {
    id: row.id, dispatchId: row.dispatch_id, targetKind: row.target_kind, target: row.target,
    payload: decode(row.payload), status: row.status, attempts: row.attempts, leaseUntil: row.lease_until,
    transport: row.transport, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function insertOutbox(db: DatabaseAdapter, record: OutboxRecord): void {
  db.run("INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    record.id, record.dispatchId, record.targetKind, record.target, encode(record.payload), record.status,
    record.attempts, record.leaseUntil, record.transport, record.createdAt, record.updatedAt,
  ]);
}

export function getOutbox(db: DatabaseAdapter, id: string): OutboxRecord | undefined {
  const row = db.query<OutboxRow>("SELECT * FROM outbox WHERE id = ?").get(id);
  return row === null ? undefined : toOutbox(row);
}

export type OutboxCursor = Readonly<{ createdAt: string; id: string }>;
export type OutboxPage = Readonly<{ rows: OutboxRecord[]; nextCursor?: OutboxCursor }>;

export function listOutboxPage(db: DatabaseAdapter, options: Readonly<{ after?: OutboxCursor; limit?: number }> = {}): OutboxPage {
  const limit = Math.max(1, Math.min(1_000, Math.trunc(options.limit ?? 100)));
  const after = options.after;
  const rows = after === undefined
    ? db.query<OutboxRow>("SELECT * FROM outbox ORDER BY created_at, id LIMIT ?").all(limit)
    : db.query<OutboxRow>("SELECT * FROM outbox WHERE created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at, id LIMIT ?").all(after.createdAt, after.createdAt, after.id, limit);
  const records = rows.map(toOutbox);
  const last = rows.at(-1);
  return { rows: records, ...(rows.length === limit && last !== undefined ? { nextCursor: { createdAt: last.created_at, id: last.id } } : {}) };
}

export function listOutbox(db: DatabaseAdapter): OutboxRecord[] {
  const records: OutboxRecord[] = [];
  let after: OutboxCursor | undefined;
  for (;;) {
    const page = listOutboxPage(db, { after });
    records.push(...page.rows);
    if (page.nextCursor === undefined) return records;
    after = page.nextCursor;
  }
}

export type LeaseRecord = Readonly<{ key: string; holder: string; expiresAt: string }>;
type LeaseRow = Readonly<{ key: string; holder: string; expires_at: string }>;

function toLease(row: LeaseRow): LeaseRecord { return { key: row.key, holder: row.holder, expiresAt: row.expires_at }; }

export function insertLease(db: DatabaseAdapter, record: LeaseRecord): void {
  db.run("INSERT INTO leases (key, holder, expires_at) VALUES (?, ?, ?)", [record.key, record.holder, record.expiresAt]);
}

export function getLease(db: DatabaseAdapter, key: string): LeaseRecord | undefined {
  const row = db.query<LeaseRow>("SELECT * FROM leases WHERE key = ?").get(key);
  return row === null ? undefined : toLease(row);
}

export function listLeases(db: DatabaseAdapter): LeaseRecord[] {
  return db.query<LeaseRow>("SELECT * FROM leases ORDER BY key").all().map(toLease);
}
