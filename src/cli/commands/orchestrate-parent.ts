import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { watch as watchFile } from "node:fs";
import { randomUUID } from "node:crypto";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { resolveConsumerIdentity } from "../../core/identity.js";
import { hasCallerIdentity, ownsDispatch, resolveCallerIdentity, type CallerIdentity } from "../../core/context.js";
import { selectDelivery, type CheckDelivery } from "../../core/check.js";
import { files, loadDeliveries, loadMessages, migrateDeliveries, readJson, report } from "./check.js";
import { acknowledgeDelivery, ackCloseRefusal, parseParentAckArgs } from "../../core/parent-queue.js";
import { callerEnvironment, resolveCaller } from "./queue-write.js";
import { executeOrchestrateClose } from "./orchestrate-close.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";

export type ParentQueueEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

function number(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }

async function lock(path: string): Promise<void> {
  while (true) {
    try { await mkdir(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
}

async function writeAtomic(path: string, value: JsonRecord): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(value)}\n`); await rename(temporary, path); } catch (error: unknown) { await rm(temporary, { force: true }); throw error; }
}

async function registerWaiter(root: string, dispatch: string, parent: JsonRecord): Promise<void> {
  const directory = await dispatchPath(root, dispatch, "");
  const waiter = `${directory}/waiter.json`;
  const wake = `${directory}/nudge.log`;
  const waiterLock = `${directory}/.waiter.lock`;
  await lock(waiterLock);
  try {
    await writeAtomic(waiter, {
      pid: process.pid,
      parentSessionId: parent.parentSessionId,
      parentHost: parent.parentHost,
      createdAt: new Date().toISOString(),
    });
    await writeFile(wake, "", { flag: "a" });
  } finally {
    await rm(waiterLock, { recursive: true, force: true });
  }
}

async function unregisterWaiter(root: string, dispatch: string): Promise<void> {
  await rm(await dispatchPath(root, dispatch, "waiter.json"), { force: true });
}

async function wakeSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

async function waitForWake(path: string, initialSize: number, timeoutMilliseconds: number): Promise<void> {
  if (await wakeSize(path) !== initialSize) return;
  await new Promise<void>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watchFile(path, () => finish());
    const finish = (): void => {
      if (finished) return;
      finished = true;
      watcher.close();
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    watcher.on("error", finish);
    timer = setTimeout(finish, Math.max(0, timeoutMilliseconds));
    void wakeSize(path).then((size) => { if (size !== initialSize) finish(); });
  });
}

// Consumer-identity helper: the string form ("host/id") used for delivery locking, distinct from
// the ownership check below but drawn from the same resolved caller.
function consumerSession(caller: CallerIdentity): { readonly sessionHost?: string; readonly sessionId?: string } {
  const id = caller.id !== "" ? caller.id : caller.terminalId ?? undefined;
  return { sessionHost: caller.host !== "unknown" ? caller.host : undefined, sessionId: id };
}

async function requireParent(root: string, dispatch: string, caller: CallerIdentity): Promise<Result<JsonRecord>> {
  const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  if (!hasCallerIdentity(caller)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = String(meta.parentHost ?? ""); const expectedId = String(meta.parentSessionId ?? "");
  if (!ownsDispatch(caller, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${dispatch} is owned by ${expectedHost}/${expectedId}, not ${caller.host}/${caller.id || caller.terminalId || ""}`);
  return ok(meta);
}

function parseWatchArgs(args: readonly string[], environmentGeneration = "1"): Result<{ readonly dispatch: string; readonly timeout: number; readonly pollInterval: number; readonly waitMode: "nudge" | "poll"; readonly consumer?: string; readonly generation: number; readonly full: boolean; readonly json: boolean }> {
  const dispatch = args[0] ?? "";
  if (dispatch === "") return failed("Usage: megabrain orchestrate watch <dispatch-id> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json]\n", 2);
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

export async function executeOrchestrateWatch(args: readonly string[], environment: ParentQueueEnvironment): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate watch <dispatch-id> [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode nudge|poll] [--consumer <id>] [--generation <number>] [--full] [--json]\n");
  const parsed = parseWatchArgs(args, environment.MEGABRAIN_CONSUMER_GENERATION ?? "1"); if (parsed.kind !== "ok") return parsed;
  // No ProcessAdapter is threaded through watch, so the caller is resolved without the tmux
  // probe (the same capability gap this command has always had) — everything else (an explicit
  // override, an agent session id, a superset/orca terminal handle, or a structured Orca session)
  // still resolves.
  const caller = resolveCallerIdentity(callerEnvironment(environment));
  const root = resolveStateDirectory(environment); const parent = await requireParent(root, parsed.value.dispatch, caller); if (parent.kind !== "ok") return parent;
  const identity = resolveConsumerIdentity({ mailbox: "parent", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID, explicitConsumer: parsed.value.consumer, ...consumerSession(caller) });
  if (identity.kind !== "known") return failed(identity.reason);
  const started = Date.now();
  const wakePath = await dispatchPath(root, parsed.value.dispatch, "nudge.log");
  await registerWaiter(root, parsed.value.dispatch, parent.value);
  try {
    while (true) {
      const initialWakeSize = await wakeSize(wakePath);
      const messages = await loadMessages(await dispatchPath(root, parsed.value.dispatch, "messages"));
      const deliveries = await loadDeliveries(await dispatchPath(root, parsed.value.dispatch, "deliveries"));
      await migrateDeliveries(root, parsed.value.dispatch, messages, deliveries);
      const selected = selectDelivery("parent", parsed.value.full, await loadDeliveries(await dispatchPath(root, parsed.value.dispatch, "deliveries")), messages, identity.value, parsed.value.generation);
      if (selected.kind === "selected") {
        const path = await dispatchPath(root, parsed.value.dispatch, `deliveries/${selected.delivery.id}.json`);
        if (selected.delivery.consumer !== null && selected.delivery.consumer !== identity.value) continue;
        if (selected.delivery.consumer !== null && selected.delivery.consumerGeneration !== parsed.value.generation) {
          await lock(await dispatchPath(root, parsed.value.dispatch, "messages/.lock"));
          const current = await readJson(path); if (current !== undefined) await writeAtomic(path, { ...current, status: "fenced", fencedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
          await rm(await dispatchPath(root, parsed.value.dispatch, "messages/.lock"), { recursive: true, force: true });
          continue;
        }
        if (selected.delivery.consumer === null) {
          await lock(await dispatchPath(root, parsed.value.dispatch, "messages/.lock"));
          const current = await readJson(path); if (current !== undefined && current.consumer === null) await writeAtomic(path, { ...current, consumer: identity.value, consumerGeneration: parsed.value.generation, updatedAt: new Date().toISOString() });
          await rm(await dispatchPath(root, parsed.value.dispatch, "messages/.lock"), { recursive: true, force: true });
        }
        return ok(report(parsed.value.dispatch, selected.delivery, messages, selected.replayed, parsed.value.json));
      }
      if (selected.kind === "unknown" || Date.now() - started >= parsed.value.timeout * 1000) return ok(report(parsed.value.dispatch, undefined, [], false, parsed.value.json));
      if (parsed.value.waitMode === "nudge") {
        const remaining = parsed.value.timeout * 1000 - (Date.now() - started);
        await waitForWake(wakePath, initialWakeSize, remaining);
      } else {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, parsed.value.pollInterval * 1000)));
      }
    }
  } finally {
    await unregisterWaiter(root, parsed.value.dispatch);
  }
}

export async function executeOrchestrateAck(args: readonly string[], environment: ParentQueueEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate ack <dispatch-id> <delivery-id> [--consumer <id>] [--generation <number>] [--close] [--json]\n");
  const parsed = parseParentAckArgs(args, environment.MEGABRAIN_CONSUMER_GENERATION ?? "1"); if (parsed.kind !== "ok") return parsed;
  const caller = await resolveCaller(environment, process);
  const root = resolveStateDirectory(environment); const parent = await requireParent(root, parsed.value.dispatchId, caller); if (parent.kind !== "ok") return parent;
  if (parsed.value.close === true && parent.value.state !== "done" && parent.value.state !== "closed") return ackCloseRefusal(parsed.value.dispatchId, typeof parent.value.state === "string" ? parent.value.state : "", parsed.value.json);
  const identity = resolveConsumerIdentity({ mailbox: "parent", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID, explicitConsumer: parsed.value.consumer, ...consumerSession(caller) });
  if (identity.kind !== "known") return failed(identity.reason);
  const path = await dispatchPath(root, parsed.value.dispatchId, `deliveries/${parsed.value.deliveryId}.json`); const delivery = await readJson(path);
  if (delivery === undefined) return failed(`delivery ${parsed.value.deliveryId} refused: delivery is unknown`);
  const status = typeof delivery.status === "string" ? delivery.status : ""; const recordConsumer = typeof delivery.consumer === "string" ? delivery.consumer : ""; const recordGeneration = number(delivery.consumerGeneration) ?? 0;
  const decision = acknowledgeDelivery(status, recordConsumer, recordGeneration, identity.value, parsed.value.generation, parsed.value.deliveryId); if (decision.kind !== "ok") return decision;
  await lock(await dispatchPath(root, parsed.value.dispatchId, "messages/.lock"));
  const now = new Date().toISOString(); const current = await readJson(path); if (current !== undefined && decision.value.duplicate === false) await writeAtomic(path, { ...current, status: "acknowledged", acknowledgedAt: now, updatedAt: now });
  await rm(await dispatchPath(root, parsed.value.dispatchId, "messages/.lock"), { recursive: true, force: true });
  const messageSeqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs : [];
  const acknowledgment = { dispatchId: parsed.value.dispatchId, deliveryId: parsed.value.deliveryId, acknowledged: true, duplicate: decision.value.duplicate, status: "acknowledged", messageSeqs };
  if (parsed.value.close !== true) {
    if (parsed.value.json) return ok(`${JSON.stringify(acknowledgment, null, 2)}\n`);
    return ok(`acknowledged: ${parsed.value.deliveryId}\nduplicate: ${decision.value.duplicate}\n`);
  }
  const closed = await executeOrchestrateClose([parsed.value.dispatchId, ...(parsed.value.json ? ["--json"] : [])], environment, process);
  if (closed.kind !== "ok") return failed(`delivery ${parsed.value.deliveryId} acknowledged; ${closed.error}`, closed.exitCode);
  if (parsed.value.json) {
    try {
      const close = JSON.parse(closed.value) as Record<string, unknown>;
      return ok(`${JSON.stringify({ ...acknowledgment, close }, null, 2)}\n`);
    } catch {
      return failed(`delivery ${parsed.value.deliveryId} acknowledged; close returned invalid JSON`);
    }
  }
  return ok(`acknowledged: ${parsed.value.deliveryId}\nduplicate: ${decision.value.duplicate}\n${closed.value}`);
}
