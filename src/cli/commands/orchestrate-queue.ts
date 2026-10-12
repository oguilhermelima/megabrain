import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { ownsDispatch } from "../../core/context.js";
import { listDeliveries, listDispatches, listMessages, listOutbox, stateDatabase, cancelQueuedMessage, mutateDispatch } from "../../adapters/state-db.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";
import { resolveCaller } from "./queue-write.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { usageText } from "../../core/usage.js";

type QueueItem = Readonly<{
  id: string;
  kind: "message" | "spawn";
  dispatch: string;
  type: string;
  createdAt: string;
  state: string;
  text: string;
}>;
type RecordValue = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;

function firstLine(value: unknown): string {
  return typeof value === "string" ? value.split(/\r?\n/, 1)[0] ?? "" : "";
}

function itemState(outboxState: string | undefined, deliveryState: string): string {
  if (outboxState === "pending") return "pending";
  if (outboxState === "suppressed") return "held";
  if (outboxState === "failed") return "failed";
  return deliveryState;
}

function queueItems(database: Parameters<typeof listDispatches>[0], dispatchIds: readonly string[]): Result<QueueItem[]> {
  const outboxResult = listOutbox(database);
  if (outboxResult.kind !== "ok") return outboxResult;
  const dispatchResult = listDispatches(database);
  if (dispatchResult.kind !== "ok") return dispatchResult;
  const dispatchRecords = new Map(dispatchResult.value.map((record) => [record.dispatchId, record]));
  const outbox = outboxResult.value;
  const items: QueueItem[] = [];
  for (const dispatchId of dispatchIds) {
    const record = dispatchRecords.get(dispatchId);
    if (record?.state === "queued") items.push({
      id: dispatchId, kind: "spawn", dispatch: dispatchId, type: "spawn", createdAt: String(record.queuedAt ?? record.createdAt ?? ""),
      state: "queued", text: firstLine(record.admissionReason),
    });
    const messagesResult = listMessages(database, dispatchId);
    if (messagesResult.kind !== "ok") return messagesResult;
    const deliveriesResult = listDeliveries(database, dispatchId);
    if (deliveriesResult.kind !== "ok") return deliveriesResult;
    const messages = messagesResult.value;
    const dispatchOutbox = outbox.filter((entry) => entry.dispatchId === dispatchId);
    const associated = new Set<string>();
    for (const delivery of deliveriesResult.value) {
      if (delivery.recipient !== "child" || (delivery.status !== "outstanding" && delivery.status !== "superseded")) continue;
      const sequences = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs : [];
      const message = messages.find((entry) => sequences.includes(entry.seq));
      if (message?.from !== "parent" || message.type !== "reply") continue;
      const queuedOutbox = dispatchOutbox.find((entry) => {
        const payload = typeof entry.payload === "object" && entry.payload !== null ? entry.payload as RecordValue : {};
        const found = entry.targetKind === "child-delivery" && payload.sequence === message.seq && ["pending", "failed", "suppressed"].includes(entry.status);
        if (found) associated.add(entry.id);
        return found;
      });
      items.push({
        id: delivery.id, kind: "message", dispatch: dispatchId, type: message.type,
        createdAt: message.createdAt, state: itemState(queuedOutbox?.status, delivery.status), text: firstLine(message.text),
      });
    }
    for (const entry of dispatchOutbox) {
      if (associated.has(entry.id) || !["pending", "failed", "suppressed"].includes(entry.status)) continue;
      const payload = typeof entry.payload === "object" && entry.payload !== null ? entry.payload as RecordValue : {};
      items.push({
        id: entry.id, kind: "message", dispatch: dispatchId,
        type: entry.targetKind === "child-delivery" ? "reply" : entry.targetKind,
        createdAt: entry.createdAt, state: itemState(entry.status, entry.status),
        text: firstLine(payload.fullMessage ?? payload.pointer ?? entry.target),
      });
    }
  }
  return ok(items.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)));
}

function formatItems(items: readonly QueueItem[], json: boolean): string {
  if (json) return `${JSON.stringify(items, null, 2)}\n`;
  if (items.length === 0) return "No queued items.\n";
  return items.map((item) => `${item.id}\t${item.kind}\t${item.dispatch}\t${item.type}\t${item.state}\t${item.text}\n`).join("");
}

export async function executeOrchestrateQueue(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText(args[0] === "cancel" ? "orchestrate-queue-cancel" : "orchestrate-queue"));
  const subcommand = args[0] === "cancel" ? "cancel" : "list";
  if (subcommand === "cancel") {
    const itemId = args[1] ?? "";
    if (itemId === "") return failed(usageText("orchestrate-queue-cancel"), 2);
    let reason = "cancelled by caller";
    let json = false;
    for (let index = 2; index < args.length; index += 1) {
      if (args[index] === "--reason") reason = args[++index] ?? "";
      else if (args[index] === "--json") json = true;
      else return failed(`unknown orchestrate queue cancel option: ${args[index]}`, 2);
    }
    if (reason.trim() === "") return failed("--reason must not be empty", 2);
    const caller = await resolveCaller(environment, process);
    const db = stateDatabase({ MEGABRAIN_STATE_DIR: resolveStateDirectory(environment), HOME: environment.HOME });
    if (db.kind !== "ok") return db;
    const all = listDispatches(db.value, { includeArchived: true });
    if (all.kind !== "ok") return all;
    const queuedSpawn = all.value.find((entry) => entry.dispatchId === itemId && entry.state === "queued");
    if (queuedSpawn !== undefined) {
      const owner = resolveParentDispatchId(db.value, queuedSpawn.dispatchId, caller);
      if (owner.kind !== "ok") return failed(`queued item ${itemId} is not owned by this caller`);
      const cancelled = mutateDispatch(db.value, owner.value, (current) => current.state === "queued"
        ? { ...current, state: "closed", reason: reason.trim(), queuedCancelledAt: new Date().toISOString() }
        : { kind: "no_change" });
      if (cancelled.kind !== "ok") return cancelled;
      if (cancelled.value.state !== "closed" || cancelled.value.queuedCancelledAt === undefined) return failed(`queued spawn ${itemId} started before cancellation`);
      return ok(json ? `${JSON.stringify({ id: itemId, dispatch: owner.value, kind: "spawn", state: "cancelled", reason: reason.trim() }, null, 2)}\n` : `cancelled: ${itemId}\n`);
    }
    const requested = all.value.flatMap((entry) => {
      const deliveries = listDeliveries(db.value, entry.dispatchId);
      const outbox = listOutbox(db.value);
      if (deliveries.kind !== "ok" || outbox.kind !== "ok") return [];
      const found = deliveries.value.some((item) => item.id === itemId) || outbox.value.some((item) => item.dispatchId === entry.dispatchId && item.id === itemId);
      return found ? [entry.dispatchId] : [];
    })[0];
    if (requested === undefined) return failed(`queued item ${itemId} not found`);
    const owner = resolveParentDispatchId(db.value, requested, caller);
    if (owner.kind !== "ok") return failed(`queued item ${itemId} is not owned by this caller`);
    const cancelled = cancelQueuedMessage(db.value, owner.value, itemId, reason.trim(), caller.id || caller.terminalId || "caller");
    if (cancelled.kind !== "ok") return cancelled;
    return ok(json ? `${JSON.stringify({ id: itemId, dispatch: owner.value, state: "cancelled", reason: reason.trim() }, null, 2)}\n` : `cancelled: ${itemId}\n`);
  }

  let dispatch = "";
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg.startsWith("-")) return failed(`unknown orchestrate queue option: ${arg}`, 2);
    else if (dispatch === "") dispatch = arg;
    else return failed(`unexpected argument: ${arg}`, 2);
  }
  const caller = await resolveCaller(environment, process);
  const db = stateDatabase({ MEGABRAIN_STATE_DIR: resolveStateDirectory(environment), HOME: environment.HOME });
  if (db.kind !== "ok") return db;
  let dispatchIds: string[];
  if (dispatch !== "") {
    const resolved = resolveParentDispatchId(db.value, dispatch, caller);
    if (resolved.kind !== "ok") return resolved;
    dispatchIds = [resolved.value];
  } else {
    const listed = listDispatches(db.value, { includeArchived: true });
    if (listed.kind !== "ok") return listed;
    dispatchIds = listed.value.filter((entry) => ownsDispatch(caller, { parentHost: String(entry.parentHost ?? ""), parentSessionId: String(entry.parentSessionId ?? "") })).map((entry) => entry.dispatchId);
  }
  const items = queueItems(db.value, dispatchIds);
  return items.kind === "ok" ? ok(formatItems(items.value, json)) : items;
}
