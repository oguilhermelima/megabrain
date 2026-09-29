import { decode, encode, type DatabaseAdapter } from "./types.js";

export type OutboxRecord = Readonly<{
  id: string; dispatchId: string | null; targetKind: string; target: string; payload: unknown;
  status: "pending" | "sending" | "sent" | "failed" | "suppressed"; attempts: number;
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

export function listOutbox(db: DatabaseAdapter): OutboxRecord[] {
  return db.query<OutboxRow>("SELECT * FROM outbox ORDER BY created_at, id").all().map(toOutbox);
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
