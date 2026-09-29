import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { resolveConsumerIdentity } from "../../core/identity.js";
import { hasCallerIdentity, ownsDispatch, resolveCallerIdentity } from "../../core/context.js";
import { selectDelivery, type CheckDelivery } from "../../core/check.js";
import { loadDeliveries, loadMessages, migrateDeliveries, report } from "./check.js";
import { ackCloseRefusal, parseParentAckArgs } from "../../core/parent-queue.js";
import { callerEnvironment, resolveCaller } from "./queue-write.js";
import { executeOrchestrateClose } from "./orchestrate-close.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { ackDelivery, claimDelivery, deleteWaiter, fenceDelivery, getDispatch, isDispatchArchived, listDeliveries, nudgeCursor, putWaiter, stateDatabase, type WaiterRecord } from "../../adapters/state-db.js";
import { usageText } from "../../core/usage.js";

export type ParentQueueEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

async function requireParent(root: string, dispatch: string, caller: Awaited<ReturnType<typeof resolveCallerIdentity>>): Promise<Result<JsonRecord>> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") return database;
  const result = getDispatch(database.value, dispatch);
  const meta = result.kind === "ok" ? result.value : undefined;
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  if (!hasCallerIdentity(caller)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = String(meta.parentHost ?? ""); const expectedId = String(meta.parentSessionId ?? "");
  if (!ownsDispatch(caller, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${dispatch} is owned by ${expectedHost}/${expectedId}, not ${caller.host}/${caller.id || caller.terminalId || ""}`);
  return ok(meta);
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

async function waitForNudge(root: string, dispatch: string, cursor: number, milliseconds: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < milliseconds) {
    const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (database.kind !== "ok") return;
    const current = nudgeCursor(database.value, dispatch);
    if (current.kind !== "ok" || current.value !== cursor) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, milliseconds - (Date.now() - started)))));
  }
}

export async function executeOrchestrateWatch(args: readonly string[], environment: ParentQueueEnvironment): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-watch"));
  const parsed = parseWatchArgs(args, environment.MEGABRAIN_CONSUMER_GENERATION ?? "1"); if (parsed.kind !== "ok") return parsed;
  const caller = resolveCallerIdentity(callerEnvironment(environment));
  const root = resolveStateDirectory(environment);
  const parent = await requireParent(root, parsed.value.dispatch, caller); if (parent.kind !== "ok") return parent;
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME }); if (database.kind !== "ok") return database;
  const identity = resolveConsumerIdentity({ mailbox: "parent", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID, explicitConsumer: parsed.value.consumer, ...consumerSession(caller) });
  if (identity.kind !== "known") return failed(identity.reason);
  const started = Date.now();
  const cursorResult = nudgeCursor(database.value, parsed.value.dispatch);
  if (cursorResult.kind !== "ok") return cursorResult;
  const waiter = putWaiter(database.value, waiterRecord(parsed.value.dispatch, parent.value));
  if (waiter.kind !== "ok") return waiter;
  let cursor = cursorResult.value;
  try {
    while (true) {
      const messages = await loadMessages(root, parsed.value.dispatch);
      const deliveries = await loadDeliveries(root, parsed.value.dispatch);
      await migrateDeliveries(root, parsed.value.dispatch, messages, deliveries);
      const selected = selectDelivery("parent", parsed.value.full, await loadDeliveries(root, parsed.value.dispatch), messages, identity.value, parsed.value.generation);
      if (selected.kind === "selected") {
        if (selected.delivery.consumer !== null && selected.delivery.consumerGeneration !== parsed.value.generation) {
          const fenced = fenceDelivery(database.value, selected.delivery.id, identity.value, parsed.value.generation);
          if (fenced.kind !== "ok") return fenced;
          continue;
        }
        if (selected.delivery.consumer === null) {
          const claimed = claimDelivery(database.value, selected.delivery.id, identity.value, parsed.value.generation);
          if (claimed.kind !== "ok") return claimed;
          if (claimed.value === undefined) continue;
        }
        return ok(report(parsed.value.dispatch, selected.delivery, messages, selected.replayed, parsed.value.json));
      }
      const elapsed = Date.now() - started;
      if (selected.kind === "unknown" || elapsed >= parsed.value.timeout * 1000) return ok(report(parsed.value.dispatch, undefined, [], false, parsed.value.json));
      if (parsed.value.waitMode === "nudge") {
        const remaining = parsed.value.timeout * 1000 - elapsed;
        await waitForNudge(root, parsed.value.dispatch, cursor, remaining);
        const nextCursor = nudgeCursor(database.value, parsed.value.dispatch);
        if (nextCursor.kind === "ok") cursor = nextCursor.value;
      } else await new Promise((resolve) => setTimeout(resolve, Math.max(0, parsed.value.pollInterval * 1000)));
    }
  } finally { deleteWaiter(database.value, parsed.value.dispatch); }
}

export async function executeOrchestrateAck(args: readonly string[], environment: ParentQueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-ack"));
  const parsed = parseParentAckArgs(args, environment.MEGABRAIN_CONSUMER_GENERATION ?? "1"); if (parsed.kind !== "ok") return parsed;
  const caller = await resolveCaller(environment, process);
  const root = resolveStateDirectory(environment);
  const parent = await requireParent(root, parsed.value.dispatchId, caller); if (parent.kind !== "ok") return parent;
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME }); if (database.kind !== "ok") return database;
  if (parsed.value.close === true) {
    const archived = isDispatchArchived(database.value, parsed.value.dispatchId);
    if (archived.kind !== "ok") return archived;
    if (archived.value) return failed(`dispatch ${parsed.value.dispatchId} is archived; refusing to close it`);
  }
  if (parsed.value.close === true && parent.value.state !== "done" && parent.value.state !== "closed") return ackCloseRefusal(parsed.value.dispatchId, typeof parent.value.state === "string" ? parent.value.state : "", parsed.value.json);
  const identity = resolveConsumerIdentity({ mailbox: "parent", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID, explicitConsumer: parsed.value.consumer, ...consumerSession(caller) });
  if (identity.kind !== "known") return failed(identity.reason);
  const deliveries = listDeliveries(database.value, parsed.value.dispatchId); if (deliveries.kind !== "ok") return deliveries;
  const delivery = deliveries.value.find((item) => item.id === parsed.value.deliveryId);
  if (delivery === undefined) return failed(`delivery ${parsed.value.deliveryId} refused: delivery is unknown`);
  const ack = ackDelivery(database.value, parsed.value.deliveryId, identity.value, parsed.value.generation); if (ack.kind !== "ok") return ack;
  const messageSeqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs : [];
  const acknowledgment = { dispatchId: parsed.value.dispatchId, deliveryId: parsed.value.deliveryId, acknowledged: true, duplicate: ack.value.duplicate, status: "acknowledged", messageSeqs };
  if (parsed.value.close !== true) {
    if (parsed.value.json) return ok(`${JSON.stringify(acknowledgment, null, 2)}\n`);
    return ok(`acknowledged: ${parsed.value.deliveryId}\nduplicate: ${ack.value.duplicate}\n`);
  }
  const closed = await executeOrchestrateClose([parsed.value.dispatchId, ...(parsed.value.json ? ["--json"] : [])], environment, process);
  if (closed.kind !== "ok") return failed(`delivery ${parsed.value.deliveryId} acknowledged; ${closed.error}`, closed.exitCode);
  if (parsed.value.json) {
    try { const close = JSON.parse(closed.value) as JsonRecord; return ok(`${JSON.stringify({ ...acknowledgment, close }, null, 2)}\n`); }
    catch { return failed(`delivery ${parsed.value.deliveryId} acknowledged; close returned invalid JSON`); }
  }
  return ok(`acknowledged: ${parsed.value.deliveryId}\nduplicate: ${ack.value.duplicate}\n${closed.value}`);
}
