import { decode, encode, object, type DatabaseAdapter } from "./types.js";

export type MessageRecord = Readonly<Record<string, unknown> & { seq: number; from: string; type: string; text: string; createdAt: string }>;
type MessageRow = Readonly<{ dispatch_id: string; seq: number; from: string; type: string; text: string; body: string | null; session_id: string | null; created_at: string; idempotency_key: string | null; extra: string }>;

export function toMessage(row: MessageRow): MessageRecord {
  const extra = object(decode<unknown>(row.extra));
  const result: Record<string, unknown> = { ...extra, seq: row.seq, from: row.from, type: row.type, text: row.text, createdAt: row.created_at };
  if (row.session_id !== null) result.sessionId = row.session_id;
  if (row.idempotency_key !== null) result.idempotencyKey = row.idempotency_key;
  if (row.body !== null) result.body = decode(row.body);
  return result as MessageRecord;
}

export function insertMessage(db: DatabaseAdapter, dispatchId: string, message: Readonly<Record<string, unknown>>): void {
  if (!Number.isInteger(message.seq) || typeof message.from !== "string" || typeof message.type !== "string" || typeof message.text !== "string" || typeof message.createdAt !== "string") throw new TypeError("message requires integer seq, from, type, text and createdAt fields");
  const known = ["seq", "from", "type", "text", "body", "sessionId", "createdAt", "idempotencyKey"];
  const extra = Object.fromEntries(Object.entries(message).filter(([key]) => !known.includes(key)));
  const body = Object.hasOwn(message, "body") ? encode(message.body) : null;
  db.run(`INSERT INTO messages (dispatch_id, seq, "from", type, text, body, session_id, created_at, idempotency_key, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    dispatchId, message.seq as number, message.from, message.type, message.text, body,
    typeof message.sessionId === "string" ? message.sessionId : null, message.createdAt,
    typeof message.idempotencyKey === "string" ? message.idempotencyKey : null, encode(extra),
  ]);
}

export function getMessage(db: DatabaseAdapter, dispatchId: string, seq: number): MessageRecord | undefined {
  const row = db.query<MessageRow>("SELECT * FROM messages WHERE dispatch_id = ? AND seq = ?").get(dispatchId, seq);
  return row === null ? undefined : toMessage(row);
}

export function listMessages(db: DatabaseAdapter, dispatchId: string): MessageRecord[] {
  return db.query<MessageRow>(`SELECT * FROM messages WHERE dispatch_id = '${dispatchId.replaceAll("'", "''")}' ORDER BY seq`).all().map(toMessage);
}
