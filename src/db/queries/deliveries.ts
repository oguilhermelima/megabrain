import { decode, encode, object, type DatabaseAdapter } from "./types.js";

export type DeliveryRecord = Readonly<Record<string, unknown> & { id: string; dispatchId: string; status: string }>;
type DeliveryRow = Readonly<{ id: string; dispatch_id: string; message_seq: number | null; message_seqs: string; consumer: string | null; generation: number | null; status: string; created_at: string; updated_at: string; acknowledged_at: string | null; fenced_at: string | null; extra: string }>;

export function toDelivery(row: DeliveryRow): DeliveryRecord {
  const extra = object(decode<unknown>(row.extra));
  const seqs = decode<unknown>(row.message_seqs);
  const result: Record<string, unknown> = {
    ...extra, id: row.id, dispatchId: row.dispatch_id,
    messageSeqs: Array.isArray(seqs) ? seqs : row.message_seq === null ? [] : [row.message_seq],
    status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  if (Object.hasOwn(extra, "recipient")) result.recipient = extra.recipient;
  if (row.consumer !== null || Object.hasOwn(extra, "consumer")) result.consumer = row.consumer;
  if (row.generation !== null || Object.hasOwn(extra, "consumerGeneration")) result.consumerGeneration = row.generation;
  if (row.acknowledged_at !== null || Object.hasOwn(extra, "acknowledgedAt")) result.acknowledgedAt = row.acknowledged_at;
  if (row.fenced_at !== null || Object.hasOwn(extra, "fencedAt")) result.fencedAt = row.fenced_at;
  return result as DeliveryRecord;
}

export function insertDelivery(db: DatabaseAdapter, delivery: Readonly<Record<string, unknown>>): void {
  if (typeof delivery.id !== "string" || typeof delivery.dispatchId !== "string" || typeof delivery.status !== "string" || typeof delivery.createdAt !== "string" || typeof delivery.updatedAt !== "string") throw new TypeError("delivery requires id, dispatchId, status, createdAt and updatedAt fields");
  const seqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs : [];
  const known = ["id", "dispatchId", "messageSeqs", "status", "createdAt", "updatedAt", "recipient", "consumer", "consumerGeneration", "acknowledgedAt", "fencedAt"];
  const extra: Record<string, unknown> = Object.fromEntries(Object.entries(delivery).filter(([key]) => !known.includes(key)));
  if (Object.hasOwn(delivery, "recipient")) extra.recipient = delivery.recipient;
  if (Object.hasOwn(delivery, "consumer")) extra.consumer = delivery.consumer;
  if (Object.hasOwn(delivery, "consumerGeneration")) extra.consumerGeneration = delivery.consumerGeneration;
  if (Object.hasOwn(delivery, "acknowledgedAt")) extra.acknowledgedAt = delivery.acknowledgedAt;
  if (Object.hasOwn(delivery, "fencedAt")) extra.fencedAt = delivery.fencedAt;
  db.run("INSERT INTO deliveries (id, dispatch_id, message_seq, message_seqs, consumer, generation, status, created_at, updated_at, acknowledged_at, fenced_at, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    delivery.id, delivery.dispatchId, typeof seqs[0] === "number" ? seqs[0] : null, encode(seqs),
    typeof delivery.consumer === "string" ? delivery.consumer : null,
    typeof delivery.consumerGeneration === "number" ? delivery.consumerGeneration : null,
    delivery.status, delivery.createdAt, delivery.updatedAt,
    typeof delivery.acknowledgedAt === "string" ? delivery.acknowledgedAt : null,
    typeof delivery.fencedAt === "string" ? delivery.fencedAt : null, encode(extra),
  ]);
}

export function getDelivery(db: DatabaseAdapter, id: string): DeliveryRecord | undefined {
  const row = db.query<DeliveryRow>("SELECT * FROM deliveries WHERE id = ?").get(id);
  return row === null ? undefined : toDelivery(row);
}

export function listDeliveries(db: DatabaseAdapter, dispatchId: string): DeliveryRecord[] {
  return db.query<DeliveryRow>(`SELECT * FROM deliveries WHERE dispatch_id = '${dispatchId.replaceAll("'", "''")}' ORDER BY COALESCE(message_seq, 2147483647), id`).all().map(toDelivery);
}
