import { failed, ok, type Result } from "../../core/result.js";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { classifyMail, deliveryStatus, orderMessages, selectDelivery, type CheckDelivery, type CheckMessage } from "../../core/check.js";
import { resolveStateDirectory } from "../../core/state.js";
import { resolveConsumerIdentity, type ConsumerIdentityInput } from "../../core/identity.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { claimDelivery, createDelivery, getDispatch, listDeliveries, listDispatches, listMessages, stateDatabase } from "../../adapters/state-db.js";
import type { DeliveryRecord } from "../../db/queries/deliveries.js";

export type CheckEnvironment = Readonly<Record<string, string | undefined>>;

// Compatibility export retained for another command being migrated in this cutover wave.
export { readJson } from "./queue-write.js";

function checkMessages(root: string, dispatch: string): CheckMessage[] {
  const db = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") return [];
  const result = listMessages(db.value, dispatch);
  return result.kind === "ok" ? result.value.map((message) => ({ ...message, path: `db:${dispatch}:${message.seq}`, from: message.from, type: message.type, text: message.text })) : [];
}

function checkDeliveries(root: string, dispatch: string): CheckDelivery[] {
  const db = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") return [];
  const result = listDeliveries(db.value, dispatch);
  return result.kind === "ok" ? result.value as unknown as CheckDelivery[] : [];
}

export async function dispatchId(environment: CheckEnvironment, root: string, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return undefined;
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  if (direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct)) {
    const resolved = getDispatch(database.value, direct);
    if (resolved.kind === "ok" && resolved.value?.dispatchId === direct) return direct;
  }
  let host: string | undefined;
  let id: string | undefined;
  let tmuxSession: string | undefined;
  if (environment.TMUX && environment.TMUX_PANE) {
    const result = await getTmux().sessionForPane(environment.TMUX_PANE, processAdapter);
    if (result.kind !== "ok" || result.value === "") return undefined;
    host = "tmux"; tmuxSession = result.value;
  } else {
    host = environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : environment.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : undefined;
    id = environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE;
    if (host === undefined || id === undefined) return undefined;
  }
  const listed = listDispatches(database.value);
  if (listed.kind !== "ok") return undefined;
  const matched = listed.value.find((meta) => host === "tmux"
    ? meta.runtime === "tmux" && meta.tmuxSession === tmuxSession && meta.tmuxPane === environment.TMUX_PANE
    : meta.terminalId === id && meta.childHost === host);
  return matched?.dispatchId;
}

export async function childIdentity(environment: CheckEnvironment, processAdapter: ProcessAdapter): Promise<Pick<ConsumerIdentityInput, "childHost" | "childSessionId" | "tmux">> {
  const childHost = environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : environment.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : "tmux";
  const childSessionId = environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE;
  if (environment.TMUX !== undefined && environment.TMUX.length > 0 && environment.TMUX_PANE !== undefined && environment.TMUX_PANE.length > 0) {
    const result = await getTmux().sessionForPane(environment.TMUX_PANE, processAdapter);
    return { childHost, tmux: { session: result.kind === "ok" ? result.value : undefined, pane: environment.TMUX_PANE } };
  }
  return { childHost, childSessionId };
}

export async function loadMessages(root: string, dispatch: string): Promise<CheckMessage[]> { return checkMessages(root, dispatch); }
export async function loadDeliveries(root: string, dispatch: string): Promise<CheckDelivery[]> { return checkDeliveries(root, dispatch); }

export async function migrateDeliveries(root: string, dispatch: string, messages: readonly CheckMessage[], deliveries: readonly CheckDelivery[]): Promise<void> {
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") throw new Error(database.error);
  for (const message of messages) {
    if (deliveries.some((delivery) => delivery.messageSeqs.includes(message.seq))) continue;
    const priorDone = messages.some((candidate) => candidate.from === "child" && candidate.type === "done" && candidate.seq < message.seq);
    const classification = classifyMail(message.from, message.type, priorDone);
    const recipient = message.from === "parent" && message.type === "reply" ? "child" : classification === "actionable" || classification === "protocol" ? "parent" : undefined;
    if (recipient === undefined) continue;
    const now = new Date().toISOString();
    const created = createDelivery(database.value, {
      id: `delivery-${Date.now()}-${message.seq}`, dispatchId: dispatch, recipient, consumer: null, consumerGeneration: null,
      messageSeqs: [message.seq], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null,
    });
    if (created.kind !== "ok") throw new Error(created.error);
  }
}

export function report(dispatch: string, delivery: CheckDelivery | undefined, messages: CheckMessage[], replayed: boolean, json: boolean): string {
  if (delivery === undefined) return json ? `${JSON.stringify({ dispatchId: dispatch, deliveryId: null, replayed: false, status: "empty", messageSeqs: [], messages: [], text: "" }, null, 2)}\n` : `dispatch: ${dispatch}\nstatus: empty\n`;
  const batch = orderMessages(messages.filter((message) => delivery.messageSeqs.includes(message.seq)));
  const outputMessages = batch.map(({ path: _path, ...message }) => message);
  const value = { dispatchId: dispatch, deliveryId: delivery.id, replayed, status: deliveryStatus(batch), messageSeqs: delivery.messageSeqs, messages: outputMessages, text: batch.map((message) => message.text ?? "").join("\n") };
  if (json) return `${JSON.stringify(value, null, 2)}\n`;
  return `delivery: ${delivery.id}\nreplayed: ${replayed}\nstatus: ${value.status}\n${batch.map((message) => `[${message.seq}] ${message.type || "message"}: ${message.text ?? ""}`).join("\n")}\n`;
}

export async function executeCheck(args: readonly string[], environment: CheckEnvironment, processAdapter: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  let timeout = 120; let pollInterval = 3; let waitMode = "poll"; let full = false; let json = false; let consumer = "";
  let generation = environment.MEGABRAIN_CONSUMER_GENERATION === undefined ? 1 : Number(environment.MEGABRAIN_CONSUMER_GENERATION);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout") timeout = Number(args[++index]);
    else if (arg === "--poll-interval") pollInterval = Number(args[++index]);
    else if (arg === "--wait-mode") waitMode = args[++index] ?? "";
    else if (arg === "--consumer") consumer = args[++index] ?? "";
    else if (arg === "--generation") generation = Number(args[++index]);
    else if (arg === "--full") full = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok(usageText("check"));
    else return failed(`unknown check option: ${arg}`, 2);
  }
  if (!Number.isInteger(timeout) || timeout < 0) return failed("--timeout must be a non-negative number of seconds", 2);
  if (!Number.isInteger(pollInterval) || pollInterval < 0) return failed("--poll-interval must be a non-negative number of seconds", 2);
  if (waitMode !== "poll") return failed("--wait-mode must be poll", 2);
  if (!Number.isInteger(generation) || generation < 1) return failed("--generation must be a positive number", 2);
  const root = resolveStateDirectory(environment);
  const dispatch = await dispatchId(environment, root, processAdapter);
  if (dispatch === undefined) return failed(`no managed dispatch belongs to superset/${environment.SUPERSET_TERMINAL_ID ?? "unknown"}`);
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return database;
  const resolvedIdentity = resolveConsumerIdentity({
    ...(await childIdentity(environment, processAdapter)), mailbox: "child", environmentConsumer: environment.MEGABRAIN_CONSUMER_ID,
    explicitConsumer: consumer, sessionHost: environment.MEGABRAIN_SESSION_HOST, sessionId: environment.MEGABRAIN_SESSION_ID,
  });
  if (resolvedIdentity.kind === "unknown") return failed(resolvedIdentity.reason);
  const resolvedConsumer = resolvedIdentity.value;
  const started = Date.now();
  while (true) {
    const messages = checkMessages(root, dispatch);
    const deliveries = checkDeliveries(root, dispatch);
    await migrateDeliveries(root, dispatch, messages, deliveries);
    const selected = selectDelivery("child", full, checkDeliveries(root, dispatch), messages, resolvedConsumer, generation);
    if (selected.kind === "selected") {
      if (selected.delivery.consumer === null) {
        const claim = claimDelivery(database.value, selected.delivery.id, resolvedConsumer, generation);
        if (claim.kind !== "ok") return claim;
        if (claim.value === undefined) continue;
      }
      return ok(report(dispatch, selected.delivery, messages, selected.replayed, json));
    }
    if (Date.now() - started >= timeout * 1000) return ok(report(dispatch, undefined, [], false, json));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollInterval * 1000)));
  }
}
