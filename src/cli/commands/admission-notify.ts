import { formatDispatchMessage } from "../../core/chat-message-format.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import type { DatabaseHandle } from "../../db/db.js";
import { callStateOwner } from "../../db/state-owner.js";

type RecordValue = Record<string, unknown>;
const string = (value: unknown): string | undefined => typeof value === "string" && value !== "" ? value : undefined;

export async function notifyAdmissionStatus(root: string, _database: DatabaseHandle, dispatch: string, meta: RecordValue, status: "queued" | "started", reason: string, _process: ProcessAdapter, position?: number, now = Date.now()): Promise<void> {
  const text = status === "queued" ? `spawn queued at position ${position ?? "unknown"}; ${reason}` : `queued spawn started${reason === "" ? "" : `; ${reason}`}`;
  const createdAt = new Date(now).toISOString();
  const outboxId = `admission-${dispatch}-${status}`;
  const pointer = `mail: megabrain orchestrate watch ${dispatch}`;
  const fullMessage = formatDispatchMessage({ dispatchId: dispatch, chatName: string(meta.chatName) ?? string(meta.branch) ?? dispatch, agent: string(meta.agent) ?? "unknown", type: "admission", text, direction: "parent-bound" });
  await callStateOwner(root, {
    operation: "append-message", dispatchId: dispatch,
    message: { from: "child", type: "admission", text, sessionId: string(meta.terminalId) ?? "", createdAt, idempotencyKey: `${dispatch}:admission:${status}` },
    delivery: { id: `delivery-${outboxId}`, recipient: "parent", status: "outstanding", createdAt, updatedAt: createdAt, acknowledgedAt: null, fencedAt: null, consumer: null, consumerGeneration: null },
    outbox: { id: outboxId, targetKind: "parent-pointer", target: string(meta.parentSessionId) ?? dispatch, payload: { meta, dispatchId: dispatch, targetKind: "parent-pointer", pointer, fullMessage } },
  });
}
