import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { normalizeDispatchState, parseParentChangeArgs, parseParentReplyArgs, replyStateError, type SupersedeSummary } from "../../core/parent-reply.js";
import { notifyChild, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { hasCallerIdentity, ownsDispatch } from "../../core/context.js";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { executeOrchestrateStop } from "./orchestrate-stop-reconcile.js";
import { usageText } from "../../core/usage.js";
import { stateDatabase, getDispatch, listDispatches, mutateDispatch, appendParentReply } from "../../adapters/state-db.js";
import type { DatabaseHandle } from "../../db/db.js";

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

async function requireParent(database: DatabaseHandle, dispatch: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<JsonRecord>> {
  const stored = getDispatch(database, dispatch);
  if (stored.kind !== "ok") return stored;
  const meta = stored.value;
  if (meta === undefined) return failed(`dispatch not found: ${dispatch}`);
  const live = listDispatches(database);
  if (live.kind !== "ok") return live;
  if (!live.value.some((record) => record.dispatchId === dispatch)) return failed(`dispatch ${dispatch} is archived; refusing to change it`);
  const current = await resolveCaller(environment, processAdapter);
  if (!hasCallerIdentity(current)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  const expectedHost = String(meta.parentHost ?? ""); const expectedId = String(meta.parentSessionId ?? "");
  if (!ownsDispatch(current, { parentHost: expectedHost, parentSessionId: expectedId })) return failed(`dispatch ${dispatch} is owned by ${expectedHost}/${expectedId}, not ${current.host}/${current.id || current.terminalId || ""}`);
  return ok(meta);
}

function outputReply(dispatch: string, json: boolean, nudge: string, summary: SupersedeSummary): string {
  if (json) return `${JSON.stringify({ dispatchId: dispatch, status: "queued", nudge, supersededQueued: summary.queued, supersededDelivered: summary.delivered, deliveredSequences: summary.deliveredSequences }, null, 2)}\n`;
  return `queued: ${dispatch}\n${summary.queued > 0 || summary.delivered > 0 ? `superseded queued: ${summary.queued}\nsuperseded delivered: ${summary.delivered}\n` : ""}${nudge === "typed" ? "" : "nudge not typed; the child will still find this reply with megabrain check\n"}`;
}

export async function executeOrchestrateReply(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-reply"));
  const parsed = parseParentReplyArgs(args); if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const opened = stateDatabase(environment); if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const parent = await requireParent(opened.value, parsed.value.dispatchId, environment, processAdapter); if (parent.kind !== "ok") return parent;
  // The shell normalizes a persisted "stalled"/"timeout" state to "running" on every meta read
  // (megabrain_dispatch_meta_normalize), before the reply's own state check ever runs — so it,
  // and the "state !== done" guard below that decides whether to resume the dispatch, both see
  // the normalized value, never the raw legacy one.
  const state = normalizeDispatchState(typeof parent.value.state === "string" ? parent.value.state : "");
  const stateError = replyStateError(parsed.value.dispatchId, state, false); if (stateError !== undefined) return failed(stateError);
  const caller = await resolveCaller(environment, processAdapter);
  const sessionId = caller.id || caller.terminalId || "";
  const append = appendParentReply(opened.value, parsed.value.dispatchId, { from: "parent", type: "reply", text: parsed.value.text, sessionId }, { supersede: parsed.value.supersede });
  if (append.kind !== "ok") return append;
  const summary: SupersedeSummary = append.value.supersedeSummary as SupersedeSummary ?? { queued: 0, delivered: 0, deliveredSequences: [] };
  const notification = await notifyChild(root, parent.value, parsed.value.dispatchId, processAdapter).catch(() => ({ outcome: "failed", reason: "notification failed" }));
  if (state !== "done") {
    const updated = mutateDispatch(opened.value, parsed.value.dispatchId, (current) => ({ ...current, state: "running", updatedAt: new Date().toISOString() }));
    if (updated.kind !== "ok") return updated;
  }
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
