import { readdir, rm } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { addSupersedeSummary, normalizeDispatchState, parseParentChangeArgs, parseParentReplyArgs, replyStateError, supersedeDelivery, type SupersedeSummary } from "../../core/parent-reply.js";
import { acquireLock, appendMessage, atomicJson, notifyChild, readJson, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { hasCallerIdentity, ownsDispatch } from "../../core/context.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { executeOrchestrateStop } from "./orchestrate-stop-reconcile.js";
import { usageText } from "../../core/usage.js";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

function summaryFromReply(value: string): SupersedeSummary {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = recordValue(parsed);
    if (record !== undefined) {
      const queued = typeof record.supersededQueued === "number" ? record.supersededQueued : 0;
      const delivered = typeof record.supersededDelivered === "number" ? record.supersededDelivered : 0;
      const sequences = Array.isArray(record.deliveredSequences) ? record.deliveredSequences.filter((item): item is number => typeof item === "number") : [];
      return { queued, delivered, deliveredSequences: sequences };
    }
  } catch {
    // The reply command owns queue durability; a malformed formatter must not undo it.
  }
  return { queued: 0, delivered: 0, deliveredSequences: [] };
}

function stopReason(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = recordValue(parsed);
    if (record !== undefined) {
      const reason = record.reason;
      if (typeof reason === "string" && reason.length > 0) return reason;
    }
  } catch {
    // Stop errors are also allowed to be plain host text.
  }
  return value;
}

async function requireParent(root: string, dispatch: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<JsonRecord>> {
  const meta = await readJson(await dispatchPath(root, dispatch, "meta.json"));
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const current = await resolveCaller(environment, processAdapter);
  if (!hasCallerIdentity(current)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = String(meta.parentHost ?? ""); const expectedId = String(meta.parentSessionId ?? "");
  if (!ownsDispatch(current, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${dispatch} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id || current.terminalId || ""}`);
  return ok(meta);
}

async function updateState(root: string, dispatch: string, meta: JsonRecord, state: string): Promise<void> {
  await atomicJson(await dispatchPath(root, dispatch, "meta.json"), { ...meta, state, updatedAt: new Date().toISOString() });
}

async function deliveryIsReply(root: string, dispatch: string, delivery: JsonRecord): Promise<boolean> {
  const sequences = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : [];
  if (sequences.length === 0) return false;
  const names = await readdir(await dispatchPath(root, dispatch, "messages")).catch(() => []);
  for (const name of names) {
    const message = await readJson(await dispatchPath(root, dispatch, `messages/${name}`));
    if (message !== undefined && sequences.includes(typeof message.seq === "number" ? message.seq : -1)) {
      if (message.from !== "parent" || message.type !== "reply") return false;
    }
  }
  return true;
}

async function supersedeReplies(root: string, dispatch: string): Promise<Result<SupersedeSummary>> {
  const directory = await dispatchPath(root, dispatch, "");
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
    const withdrawal = await appendMessage(root, dispatch, "parent", "withdrawal", text, "", {}, { run: async () => failed("notification unavailable"), startDetached: async () => failed("notification unavailable"), invocationCount: () => 0 }, true);
    if (withdrawal.kind !== "ok") return withdrawal;
  }
  return ok(total);
}

function outputReply(dispatch: string, json: boolean, nudge: string, summary: SupersedeSummary): string {
  if (json) return `${JSON.stringify({ dispatchId: dispatch, status: "queued", nudge, supersededQueued: summary.queued, supersededDelivered: summary.delivered, deliveredSequences: summary.deliveredSequences }, null, 2)}\n`;
  return `queued: ${dispatch}\n${summary.queued > 0 || summary.delivered > 0 ? `superseded queued: ${summary.queued}\nsuperseded delivered: ${summary.delivered}\n` : ""}${nudge === "typed" ? "" : "nudge not typed; the child will still find this reply with megabrain check\n"}`;
}

export async function executeOrchestrateReply(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-reply"));
  const parsed = parseParentReplyArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment); const parent = await requireParent(root, parsed.value.dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  // The shell normalizes a persisted "stalled"/"timeout" state to "running" on every meta read
  // (megabrain_dispatch_meta_normalize), before the reply's own state check ever runs — so it,
  // and the "state !== done" guard below that decides whether to resume the dispatch, both see
  // the normalized value, never the raw legacy one.
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "");
  const stateError = replyStateError(parsed.value.dispatchId, state, false); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const sessionId = caller.id || caller.terminalId || "";
  let summary: SupersedeSummary = { queued: 0, delivered: 0, deliveredSequences: [] };
  let append: Result<number>;
  if (parsed.value.supersede) {
    const lockPath = await dispatchPath(root, parsed.value.dispatchId, "messages/.lock");
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
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-change"));
  const parsed = parseParentChangeArgs(args); if (parsed.kind !== "ok") return parsed;
  const reply = await executeOrchestrateReply([parsed.value.dispatchId, "--text", parsed.value.text, "--supersede", "--json"], environment, processAdapter);
  if (reply.kind !== "ok") return reply;
  const queued = summaryFromReply(reply.value);
  const stopped = await executeOrchestrateStop([parsed.value.dispatchId, "--json"], environment, processAdapter);
  const interrupted = stopped.kind === "ok";
  const reason = stopped.kind === "failed" ? stopReason(stopped.error) : "";
  if (parsed.value.json) return ok(`${JSON.stringify({ dispatchId: parsed.value.dispatchId, queueChanged: true, interrupted, supersededQueued: queued.queued, supersededDelivered: queued.delivered, deliveredSequences: queued.deliveredSequences, ...(interrupted ? {} : { reason, message: "queue changed; agent was not interrupted" }) }, null, 2)}\n`);
  return ok(`changed: ${parsed.value.dispatchId}\ninterrupted: ${interrupted}\n${interrupted ? "" : "queue changed; agent was not interrupted\n"}`);
}
