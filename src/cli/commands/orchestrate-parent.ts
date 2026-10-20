import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { resolveConsumerIdentity } from "../../core/identity.js";
import { resolveCallerIdentity } from "../../core/context.js";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { selectDelivery, type CheckDelivery } from "../../core/check.js";
import { loadDeliveries, loadMessages, migrateDeliveries, report } from "./check.js";
import { ackCloseRefusal, parseParentAckArgs } from "../../core/parent-queue.js";
import { resolveCaller } from "./queue-write.js";
import { executeOrchestrateClose } from "./orchestrate-close.js";
import { getDispatch, isDispatchArchived, listDeliveries, listMessages, nudgeCursor, readOnlyStateDatabase, type WaiterRecord } from "../../adapters/state-db.js";
import { usageText } from "../../core/usage.js";
import { resolveParentDispatchId } from "./parent-dispatch.js";
import { callStateOwner } from "../../db/state-owner.js";

export type ParentQueueEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

async function requireParent(root: string, dispatch: string, caller: Awaited<ReturnType<typeof resolveCallerIdentity>>): Promise<Result<JsonRecord & { dispatchId: string }>> {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return database;
  const resolved = resolveParentDispatchId(database.value, dispatch, caller);
  if (resolved.kind !== "ok") return resolved;
  const result = getDispatch(database.value, resolved.value);
  const meta = result.kind === "ok" ? result.value : undefined;
  if (meta === undefined) return failed(`dispatch not found: ${resolved.value}`);
  return ok({ ...meta, dispatchId: resolved.value });
}

function parseWatchArgs(args: readonly string[], environmentGeneration = "1"): Result<{ readonly dispatch: string; readonly timeout: number; readonly pollInterval: number; readonly waitMode: "nudge" | "poll"; readonly consumer?: string; readonly generation: number; readonly full: boolean; readonly json: boolean }> {
  const dispatch = args[0] ?? "";
  if (dispatch === "") return failed(usageText("orchestrate-watch"), 2);
  let timeout = 120; let pollInterval = 3; let waitMode: "nudge" | "poll" = "nudge"; let consumer: string | undefined; let generation = Number(environmentGeneration); let full = false; let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout") timeout = Number(args[++index]);
    else if (arg === "--poll-interval") pollInterval = Number(args[++index]);
    else if (arg === "--wait-mode") { const value = args[++index]; if (value !== "nudge" && value !== "poll") return failed("--wait-mode must be nudge or poll", 2); waitMode = value; }
    else if (arg === "--poll") waitMode = "poll";
    else if (arg === "--consumer") consumer = args[++index];
    else if (arg === "--generation") generation = Number(args[++index]);
    else if (arg === "--full") full = true;
    else if (arg === "--json") json = true;
    else return failed(`unknown orchestrate watch option: ${arg}`, 2);
  }
  if (!Number.isInteger(timeout) || timeout < 0) return failed("--timeout must be a non-negative number of seconds", 2);
  if (!Number.isInteger(pollInterval) || pollInterval < 0) return failed("--poll-interval must be a non-negative number of seconds", 2);
  if (!Number.isInteger(generation) || generation < 1) return failed("--generation must be a positive number", 2);
  return ok({ dispatch, timeout, pollInterval, waitMode, consumer, generation, full, json });
}

function consumerSession(caller: Awaited<ReturnType<typeof resolveCallerIdentity>>): { readonly sessionHost?: string; readonly sessionId?: string } {
  const id = caller.id !== "" ? caller.id : caller.terminalId ?? undefined;
  return { sessionHost: caller.host !== "unknown" ? caller.host : undefined, sessionId: id };
}

function waiterRecord(dispatch: string, parent: JsonRecord): WaiterRecord {
  return { dispatchId: dispatch, pid: process.pid, parentSessionId: typeof parent.parentSessionId === "string" ? parent.parentSessionId : null, parentHost: typeof parent.parentHost === "string" ? parent.parentHost : null, createdAt: new Date().toISOString() };
}

async function waitForNudge(root: string, dispatch: string, cursor: number, messageSequence: number, milliseconds: number): Promise<{ readonly cursor: number; readonly messageSequence: number }> {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (database.kind !== "ok") return { cursor, messageSequence };
    const current = nudgeCursor(database.value, dispatch);
    const messages = listMessages(database.value, dispatch);
    const latestMessageSequence = messages.kind === "ok" ? Math.max(messageSequence, ...messages.value.map((message) => message.seq)) : messageSequence;
    if ((current.kind === "ok" && current.value !== cursor) || latestMessageSequence > messageSequence) {
      return { cursor: current.kind === "ok" ? current.value : cursor, messageSequence: latestMessageSequence };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, milliseconds - (Date.now() - started)))));
  }
  return { cursor, messageSequence };
}

function remainingTimeout(deadline: number): number { return Math.max(1_000, deadline - Date.now()); }

export async function executeOrchestrateWatch(args: readonly string[], environment: ParentQueueEnvironment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-watch"));
  const parsed = parseWatchArgs(args, environment.MEGABRAIN_CONSUMER_GENERATION ?? "1"); if (parsed.kind !== "ok") return parsed;
  const caller = await resolveCaller(environment, process);
  const root = resolveStateDirectory(environment);
  const parent = await requireParent(root, parsed.value.dispatch, caller); if (parent.kind !== "ok") return parent;
  const dispatchId = parent.value.dispatchId;
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME }); if (database.kind !== "ok") return database;
  const identity = resolveConsumerIdentity({ mailbox: "parent", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID, explicitConsumer: parsed.value.consumer, ...consumerSession(caller) });
  if (identity.kind !== "known") return failed(identity.reason);
  const started = Date.now();
  const deadline = started + parsed.value.timeout * 1000;
  const cursorResult = nudgeCursor(database.value, dispatchId);
  if (cursorResult.kind !== "ok") return cursorResult;
  let cursor = cursorResult.value;
  let waiterRegistered = false;
  let messageSequence = 0;
  try {
    while (true) {
      const messages = await loadMessages(root, dispatchId);
      const deliveries = await loadDeliveries(root, dispatchId);
      try { await migrateDeliveries(root, dispatchId, messages, deliveries, remainingTimeout(deadline)); }
      catch (cause: unknown) {
        if (Date.now() >= deadline) return ok(report(dispatchId, undefined, [], false, parsed.value.json));
        return failed(`state owner delivery migration failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const selected = selectDelivery("parent", parsed.value.full, await loadDeliveries(root, dispatchId), messages, identity.value, parsed.value.generation);
      if (selected.kind === "selected") {
        if (selected.delivery.consumer !== null && selected.delivery.consumerGeneration !== parsed.value.generation) {
          try { await callStateOwner(root, { operation: "fence-delivery", id: selected.delivery.id, consumer: identity.value, generation: parsed.value.generation }); }
          catch (cause: unknown) { return failed(`state owner delivery fence failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
          continue;
        }
        let claimed: unknown;
        try { claimed = await callStateOwner(root, { operation: "claim-delivery", id: selected.delivery.id, consumer: identity.value, generation: parsed.value.generation }); }
        catch (cause: unknown) { return failed(`state owner delivery claim failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
        if (typeof claimed !== "object" || claimed === null || !("status" in claimed) || (claimed.status !== "outstanding" && claimed.status !== "superseded")) continue;
        return ok(report(dispatchId, claimed as CheckDelivery, messages, selected.replayed, parsed.value.json));
      }
      const elapsed = Date.now() - started;
      if (selected.kind === "unknown" || elapsed >= parsed.value.timeout * 1000) return ok(report(dispatchId, undefined, [], false, parsed.value.json));
      messageSequence = Math.max(messageSequence, ...messages.map((message) => message.seq));
      if (!waiterRegistered) {
        const remaining = remainingTimeout(deadline);
        try {
          await callStateOwner(root, { operation: "put-waiter", waiter: waiterRecord(dispatchId, parent.value) }, remaining, remaining);
          waiterRegistered = true;
        } catch (cause: unknown) {
          if (Date.now() >= deadline) return ok(report(dispatchId, undefined, [], false, parsed.value.json));
          return failed(`state owner waiter write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      if (parsed.value.waitMode === "nudge") {
        const remaining = parsed.value.timeout * 1000 - elapsed;
        const next = await waitForNudge(root, dispatchId, cursor, messageSequence, remaining);
        cursor = next.cursor;
        messageSequence = next.messageSequence;
      } else await new Promise((resolve) => setTimeout(resolve, Math.min(parsed.value.pollInterval * 1000, Math.max(0, parsed.value.timeout * 1000 - elapsed))));
    }
  } finally {
    if (waiterRegistered) void callStateOwner(root, { operation: "delete-waiter", dispatchId }, 1_000, 1_000).catch(() => undefined);
  }
}

export async function executeOrchestrateAck(args: readonly string[], environment: ParentQueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-ack"));
  const parsed = parseParentAckArgs(args, environment.MEGABRAIN_CONSUMER_GENERATION ?? "1"); if (parsed.kind !== "ok") return parsed;
  const caller = await resolveCaller(environment, process);
  const root = resolveStateDirectory(environment);
  const parent = await requireParent(root, parsed.value.dispatchId, caller); if (parent.kind !== "ok") return parent;
  const dispatchId = parent.value.dispatchId;
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME }); if (database.kind !== "ok") return database;
  if (parsed.value.close === true) {
    const archived = isDispatchArchived(database.value, dispatchId);
    if (archived.kind !== "ok") return archived;
    if (archived.value) return failed(`dispatch ${dispatchId} is archived; refusing to close it`);
  }
  if (parsed.value.close === true && parent.value.state !== "done" && parent.value.state !== "closed") return ackCloseRefusal(dispatchId, typeof parent.value.state === "string" ? parent.value.state : "", parsed.value.json);
  const identity = resolveConsumerIdentity({ mailbox: "parent", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID, explicitConsumer: parsed.value.consumer, ...consumerSession(caller) });
  if (identity.kind !== "known") return failed(identity.reason);
  const deliveries = listDeliveries(database.value, dispatchId); if (deliveries.kind !== "ok") return deliveries;
  let delivery = deliveries.value.find((item) => item.id === parsed.value.deliveryId);
  if (delivery === undefined) return failed(`delivery ${parsed.value.deliveryId} refused: delivery is unknown`);
  // The command is printed inside the delivered message. Reaching it proves that this consumer
  // received the message, so an unclaimed delivery can be claimed here before it is acknowledged.
  if (delivery.consumer === null || delivery.consumer === undefined) {
    try { delivery = await callStateOwner(root, { operation: "claim-delivery", id: delivery.id, consumer: identity.value, generation: parsed.value.generation }) as typeof delivery; }
    catch (cause: unknown) { return failed(`state owner delivery claim failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (delivery === undefined) return failed(`delivery ${parsed.value.deliveryId} refused: it belongs to another consumer`);
  }
  let ack: { duplicate: boolean };
  try { ack = await callStateOwner(root, { operation: "ack-delivery", id: parsed.value.deliveryId, consumer: identity.value, generation: parsed.value.generation }) as typeof ack; }
  catch (cause: unknown) { return failed(`state owner delivery acknowledgement failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
  const messageSeqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs : [];
  const acknowledgment = {
    dispatchId,
    deliveryId: parsed.value.deliveryId,
    acknowledged: true,
    duplicate: ack.duplicate,
    status: "acknowledged",
    messageSeqs,
    ...(ack.duplicate && typeof delivery.acknowledgedAt === "string" ? { firstAcknowledgedAt: delivery.acknowledgedAt } : {}),
    ...(ack.duplicate && typeof delivery.consumer === "string" ? { firstAcknowledgedBy: delivery.consumer } : {}),
  };
  if (parsed.value.close !== true) {
    if (parsed.value.json) return ok(`${JSON.stringify(acknowledgment, null, 2)}\n`);
    return ok(`acknowledged: ${parsed.value.deliveryId}\nduplicate: ${ack.duplicate}\n${ack.duplicate && typeof delivery.acknowledgedAt === "string" ? `first acknowledged at: ${delivery.acknowledgedAt}\n` : ""}${ack.duplicate && typeof delivery.consumer === "string" ? `first acknowledged by: ${delivery.consumer}\n` : ""}`);
  }
  const closed = await executeOrchestrateClose([dispatchId, ...(parsed.value.json ? ["--json"] : [])], environment, process);
  if (closed.kind !== "ok") return failed(`delivery ${parsed.value.deliveryId} acknowledged; ${closed.error}`, closed.exitCode);
  if (parsed.value.json) {
    try { const close = JSON.parse(closed.value) as JsonRecord; return ok(`${JSON.stringify({ ...acknowledgment, close }, null, 2)}\n`); }
    catch { return failed(`delivery ${parsed.value.deliveryId} acknowledged; close returned invalid JSON`); }
  }
  return ok(`acknowledged: ${parsed.value.deliveryId}\nduplicate: ${ack.duplicate}\n${closed.value}`);
}
