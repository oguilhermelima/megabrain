import { readdir, rm } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { addSupersedeSummary, parseParentChangeArgs, parseParentReplyArgs, replyStateError, supersedeDelivery, type SupersedeSummary } from "../../core/parent-reply.js";
import { acquireLock, appendMessage, atomicJson, notifyChild, readJson, type QueueEnvironment } from "./queue-write.js";
import { type ProcessAdapter } from "../../adapters/proc.js";

type JsonRecord = Record<string, unknown>;

async function requireParent(root: string, dispatch: string, environment: QueueEnvironment): Promise<Result<JsonRecord>> {
  const meta = await readJson(`${root}/dispatches/${dispatch}/meta.json`);
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const host = environment.MEGABRAIN_SESSION_HOST ?? (environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : environment.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : undefined);
  const id = environment.MEGABRAIN_SESSION_ID ?? environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE;
  if (host === undefined || id === undefined) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  if (meta.parentSessionId !== id || meta.parentHost !== host) return failed(`dispatch ${dispatch} is owned by ${String(meta.parentHost ?? "")}/${String(meta.parentSessionId ?? "")}, not ${host}/${id}`);
  return ok(meta);
}

async function updateState(root: string, dispatch: string, meta: JsonRecord, state: string): Promise<void> {
  await atomicJson(`${root}/dispatches/${dispatch}/meta.json`, { ...meta, state, updatedAt: new Date().toISOString() });
}

async function deliveryIsReply(root: string, dispatch: string, delivery: JsonRecord): Promise<boolean> {
  const sequences = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : [];
  if (sequences.length === 0) return false;
  const names = await readdir(`${root}/dispatches/${dispatch}/messages`).catch(() => []);
  for (const name of names) {
    const message = await readJson(`${root}/dispatches/${dispatch}/messages/${name}`);
    if (message !== undefined && sequences.includes(typeof message.seq === "number" ? message.seq : -1)) {
      if (message.from !== "parent" || message.type !== "reply") return false;
    }
  }
  return true;
}

async function supersedeReplies(root: string, dispatch: string): Promise<Result<SupersedeSummary>> {
  const directory = `${root}/dispatches/${dispatch}`;
  let total: SupersedeSummary = { queued: 0, delivered: 0, deliveredSequences: [] };
  for (const name of await readdir(`${directory}/deliveries`).catch(() => [])) {
    const path = `${directory}/deliveries/${name}`;
    const delivery = await readJson(path);
    if (delivery === undefined || !(await deliveryIsReply(root, dispatch, delivery))) continue;
    const sequences = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : [];
    const decision = supersedeDelivery(
      typeof delivery.status === "string" ? delivery.status : "",
      typeof delivery.consumer === "string" ? delivery.consumer : null,
      sequences,
      delivery.superseded === true,
    );
    if (decision.queued === 0 && decision.delivered === 0) continue;
    const now = new Date().toISOString();
    const next = decision.delivered > 0
      ? { ...delivery, superseded: true, supersededAt: now, updatedAt: now }
      : { ...delivery, status: "superseded", superseded: true, supersededAt: now, updatedAt: now };
    await atomicJson(path, next);
    total = addSupersedeSummary(total, decision);
  }
  if (total.delivered > 0) {
    const text = `withdrawn parent direction message sequence(s): ${total.deliveredSequences.join(", ")}`;
    const withdrawal = await appendMessage(root, dispatch, "parent", "withdrawal", text, "", {}, { run: async () => failed("notification unavailable"), invocationCount: () => 0 }, true);
    if (withdrawal.kind !== "ok") return withdrawal;
  }
  return ok(total);
}

function outputReply(dispatch: string, json: boolean, nudge: string, summary: SupersedeSummary): string {
  if (json) return `${JSON.stringify({ dispatchId: dispatch, status: "queued", nudge, supersededQueued: summary.queued, supersededDelivered: summary.delivered, deliveredSequences: summary.deliveredSequences }, null, 2)}\n`;
  return `queued: ${dispatch}\n${summary.queued > 0 || summary.delivered > 0 ? `superseded queued: ${summary.queued}\nsuperseded delivered: ${summary.delivered}\n` : ""}${nudge === "typed" ? "" : "nudge not typed; the child will still find this reply with megabrain check\n"}`;
}

export async function executeOrchestrateReply(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate reply <dispatch-id> --text <answer> [--supersede] [--json]\n");
  const parsed = parseParentReplyArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment); const parent = await requireParent(root, parsed.value.dispatchId, environment); if (parent.kind !== "ok") return parent;
  const state = typeof parent.value.state === "string" ? parent.value.state : "";
  const stateError = replyStateError(parsed.value.dispatchId, state, false); if (stateError !== undefined) return failed(stateError);
  const sessionId = environment.MEGABRAIN_SESSION_ID ?? environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE ?? "";
  let summary: SupersedeSummary = { queued: 0, delivered: 0, deliveredSequences: [] };
  let append: Result<number>;
  if (parsed.value.supersede) {
    const lockPath = `${root}/dispatches/${parsed.value.dispatchId}/messages/.lock`;
    const lock = await acquireLock(lockPath, environment); if (lock.kind !== "ok") return lock;
    try {
      const superseded = await supersedeReplies(root, parsed.value.dispatchId); if (superseded.kind !== "ok") return superseded;
      summary = superseded.value;
      append = await appendMessage(root, parsed.value.dispatchId, "parent", "reply", parsed.value.text, sessionId, environment, processAdapter, true);
    } finally { await rm(lockPath, { recursive: true, force: true }); }
  } else {
    append = await appendMessage(root, parsed.value.dispatchId, "parent", "reply", parsed.value.text, sessionId, environment, processAdapter);
  }
  if (append.kind !== "ok") return append;
  const notification = await notifyChild(root, parent.value, parsed.value.dispatchId, processAdapter).catch(() => ({ outcome: "failed", reason: "notification failed" }));
  if (state !== "done") await updateState(root, parsed.value.dispatchId, parent.value, "running");
  return ok(outputReply(parsed.value.dispatchId, parsed.value.json, notification.outcome === "delivered" ? "typed" : "not-typed", summary));
}

export async function executeOrchestrateChange(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate change <dispatch-id> --text <text> [--json]\n");
  const parsed = parseParentChangeArgs(args); if (parsed.kind !== "ok") return parsed;
  const reply = await executeOrchestrateReply([parsed.value.dispatchId, "--text", parsed.value.text, "--supersede", "--json"], environment, processAdapter);
  if (reply.kind !== "ok") return reply;
  const queued = JSON.parse(reply.value) as { readonly supersededQueued: number; readonly supersededDelivered: number; readonly deliveredSequences: readonly number[] };
  const reason = "megabrain: dispatch " + parsed.value.dispatchId + " cannot be stopped: interrupt capability is unavailable for host " + (environment.MEGABRAIN_CHILD_HOST ?? "unknown");
  if (parsed.value.json) return ok(`${JSON.stringify({ dispatchId: parsed.value.dispatchId, queueChanged: true, interrupted: false, supersededQueued: queued.supersededQueued, supersededDelivered: queued.supersededDelivered, deliveredSequences: queued.deliveredSequences, reason, message: "queue changed; agent was not interrupted" }, null, 2)}\n`);
  return ok(`changed: ${parsed.value.dispatchId}\ninterrupted: false\nqueue changed; agent was not interrupted\n`);
}
