import type { ProcessAdapter } from "../../adapters/proc.js";
import { listDeliveries, listDeliveryChannels, listDispatchEntries, listMessages, listOpenOutbox, readAdmissionPolicy, resourceHistoryEnabled, readOnlyStateDatabase } from "../../adapters/state-db.js";
import { decorateDispatchRecord, parseDispatchRecord, type DecoratedDispatch } from "../../core/dispatch.js";
import { listProcQueue } from "../../core/proc-queue.js";
import { executeProc } from "../../core/proc-runner.js";
import { readCachedMachineResources } from "../../core/resources.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { recommendationFor, type SupervisionFinding } from "../../core/supervise.js";
import { usageText } from "../../core/usage.js";
import { executeContext } from "./context.js";
import { callerFromEnvironment } from "./orchestrate-list.js";
import { queueItems } from "./orchestrate-queue.js";
import { supervisorWatcher } from "./supervise.js";
import { unhandledParentMail, type CheckDelivery } from "../../core/check.js";
import { agentUpdateStatus } from "../../core/agent-update.js";
import { inspectStateOwner } from "../../db/state-owner.js";

type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;

function parsedJson(result: Result<string>): unknown {
  if (result.kind !== "ok") return null;
  try { return JSON.parse(result.value); } catch { return null; }
}

function supervision(record: DecoratedDispatch): Readonly<{ lastCheck: string | null; finding: RecordValue | null }> {
  const lastCheck = typeof record.superviseLastCheck === "string" ? record.superviseLastCheck : null;
  const stored = record.superviseFinding;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return { lastCheck, finding: null };
  const finding = stored as RecordValue;
  if (finding.cause === "unknown") return { lastCheck, finding: null };
  const recommendation = recommendationFor(finding as SupervisionFinding, String(record.dispatchId));
  return { lastCheck, finding: { ...finding, ...(recommendation === undefined ? {} : { recommendation }) } };
}

// Everything the desktop panel polls, in one process. It is an operator's view: every session's
// dispatches that are not closed or archived, and every queued item, each with its owner. Docker
// containers are left out because docker stats alone takes seconds; resources --json has them.
async function collectStatus(environment: Environment, process: ProcessAdapter): Promise<Result<RecordValue>> {
  const root = resolveStateDirectory(environment);
  const stateEnvironment = { ...environment, MEGABRAIN_STATE_DIR: root };
  const database = readOnlyStateDatabase(stateEnvironment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);
  const entries = listDispatchEntries(database.value);
  if (entries.kind !== "ok") return failed(entries.error, entries.exitCode);
  const caller = await callerFromEnvironment(environment, process);
  // Archived records are not listed unless asked for.
  const dispatches = entries.value.flatMap(({ record }) => {
    const parsed = parseDispatchRecord(record);
    if (parsed.kind !== "ok" || parsed.value.raw.state === "closed") return [];
    const decorated = decorateDispatchRecord(parsed.value, caller);
    const dispatch = String(decorated.dispatchId ?? "");
    const deliveries = listDeliveries(database.value, dispatch);
    const messages = listMessages(database.value, dispatch);
    const unhandledChildMailCount = deliveries.kind === "ok" && messages.kind === "ok"
      ? unhandledParentMail(deliveries.value as unknown as CheckDelivery[], messages.value.map((message) => ({ ...message, path: `db:${dispatch}:${message.seq}` }))).length
      : 0;
    return [{ ...decorated, unhandledChildMailCount, supervision: supervision(decorated) }];
  });
  const queued = queueItems(database.value, dispatches.map((item) => String((item as RecordValue).dispatchId)));
  if (queued.kind !== "ok") return failed(queued.error, queued.exitCode);
  const watcher = supervisorWatcher(database.value);
  const staleBefore = Date.now() - 30_000;
  const stuckNotices: { outboxId: string; dispatchId: string; targetKind: string; ageSeconds: number }[] = [];
  if (!watcher.running) {
    const openOutbox = listOpenOutbox(database.value, new Date(staleBefore).toISOString());
    if (openOutbox.kind !== "ok") return failed(openOutbox.error, openOutbox.exitCode);
    for (const item of openOutbox.value) {
      const createdAt = Date.parse(item.createdAt);
      if (!Number.isFinite(createdAt)) continue;
      stuckNotices.push({ outboxId: item.id, dispatchId: item.dispatchId!, targetKind: item.targetKind, ageSeconds: Math.floor((Date.now() - createdAt) / 1000) });
    }
  }
  const procQueue = (await listProcQueue(stateEnvironment)).map((entry) => ({
    id: entry.id, kind: "proc", dispatch: "-", type: entry.name, createdAt: entry.createdAt, state: "queued", text: entry.reason, owner: entry.owner,
  }));
  const channels = listDeliveryChannels(database.value);
  const [context, machine, processes, history, admission] = await Promise.all([
    executeContext(["--json"], environment, process),
    readCachedMachineResources(stateEnvironment, process),
    executeProc(["list", "--json"], stateEnvironment, process),
    resourceHistoryEnabled(stateEnvironment),
    readAdmissionPolicy(stateEnvironment),
  ]);
  return ok({
    generatedAt: new Date().toISOString(),
    stateOwner: await inspectStateOwner(root),
    context: parsedJson(context),
    machine: machine ?? null,
    supervisor: { watcher: supervisorWatcher(database.value) },
    stuckNotices,
    dispatches,
    queue: [...queued.value, ...procQueue].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
    processes: parsedJson(processes) ?? [],
    resources: { history, admission: admission ?? null },
    deliveryChannels: channels.kind === "ok" ? channels.value : [],
    agentUpdates: await agentUpdateStatus(stateEnvironment),
  });
}

function summary(status: RecordValue): string {
  const stateOwner = status.stateOwner as { running: boolean; pid?: number; error?: string };
  const watcher = (status.supervisor as { watcher: { running: boolean; pid: number | null } }).watcher;
  const dispatches = status.dispatches as RecordValue[];
  const states = new Map<string, number>();
  for (const item of dispatches) states.set(String(item.state), (states.get(String(item.state)) ?? 0) + 1);
  const byState = [...states.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([state, count]) => `${state} ${count}`).join(", ");
  const findings = dispatches.filter((item) => (item.supervision as { finding: unknown }).finding !== null).length;
  const updates = Object.entries(status.agentUpdates as Record<string, { status: string }>).map(([agent, report]) => `${agent} ${report.status}`).join(", ");
  return [
    `state owner: ${stateOwner.running ? `running (pid ${stateOwner.pid ?? "unknown"})` : `stopped${stateOwner.error ? ` (${stateOwner.error})` : ""}`}`,
    `watcher: ${watcher.running ? `running (pid ${watcher.pid ?? "unknown"})` : "stopped"}`,
    `dispatches: ${dispatches.length}${byState === "" ? "" : ` (${byState})`}; findings ${findings}`,
    `queue: ${(status.queue as unknown[]).length}`,
    ...((status.stuckNotices as unknown[]).length === 0 ? [] : [`stuck notices: ${(status.stuckNotices as unknown[]).length}`]),
    `processes: ${(status.processes as unknown[]).length}`,
    ...(updates === "" ? [] : [`agent updates: ${updates}`]),
  ].join("\n") + "\n";
}

export async function executeStatus(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("status"));
  if (args.some((arg) => arg !== "--json")) return failed(`unknown status option: ${args.find((arg) => arg !== "--json")}`, 2);
  const status = await collectStatus(environment, process);
  if (status.kind !== "ok") return status;
  return ok(args.includes("--json") ? `${JSON.stringify(status.value, null, 2)}\n` : summary(status.value));
}
