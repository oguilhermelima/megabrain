import { failed, ok, type Result } from "../../core/result.js";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { classifyMail, deliveryStatus, orderMessages, selectDelivery, type CheckDelivery, type CheckMessage } from "../../core/check.js";
import { resolveChildStateDirectory } from "../../core/state.js";
import { findChild, type QueueEnvironment } from "./queue-write.js";
import { resolveConsumerIdentity, type ConsumerIdentityInput } from "../../core/identity.js";
import { getTmux } from "../../hosts/tmux.js";
import { usageText } from "../../core/usage.js";
import { listDeliveries, listMessages, readOnlyStateDatabase } from "../../adapters/state-db.js";
import type { DeliveryRecord } from "../../db/queries/deliveries.js";
import { callStateOwner } from "../../db/state-owner.js";

export type CheckEnvironment = Readonly<Record<string, string | undefined>>;
export type CheckOptions = Readonly<{ acknowledge?: boolean; excludedTransports?: readonly string[]; excludedDeliveryIds?: readonly string[] }>;

function checkMessages(root: string, dispatch: string): CheckMessage[] {
  const db = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") return [];
  const result = listMessages(db.value, dispatch);
  return result.kind === "ok" ? result.value.map((message) => ({ ...message, path: `db:${dispatch}:${message.seq}`, from: message.from, type: message.type, text: message.text })) : [];
}

function checkDeliveries(root: string, dispatch: string): CheckDelivery[] {
  const db = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (db.kind !== "ok") return [];
  const result = listDeliveries(db.value, dispatch);
  return result.kind === "ok" ? result.value as unknown as CheckDelivery[] : [];
}

export async function dispatchId(environment: CheckEnvironment, root: string, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const child = await findChild(root, environment as QueueEnvironment, processAdapter);
  return "kind" in child ? child : ok(child.dispatch);
}

export async function childIdentity(environment: CheckEnvironment, processAdapter: ProcessAdapter): Promise<Pick<ConsumerIdentityInput, "childHost" | "childSessionId" | "tmux">> {
  const childHost = environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : environment.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : environment.TMUX ? "tmux" : "local";
  const childSessionId = environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE
    ?? (environment.CLAUDE_CODE_SESSION_ID === undefined ? undefined : `claude:${environment.CLAUDE_CODE_SESSION_ID}`)
    ?? (environment.CODEX_THREAD_ID === undefined ? undefined : `codex:${environment.CODEX_THREAD_ID}`);
  if (environment.TMUX !== undefined && environment.TMUX.length > 0 && environment.TMUX_PANE !== undefined && environment.TMUX_PANE.length > 0) {
    const result = await getTmux().sessionForPane(environment.TMUX_PANE, processAdapter);
    return { childHost, tmux: { session: result.kind === "ok" ? result.value : undefined, pane: environment.TMUX_PANE } };
  }
  return { childHost, childSessionId };
}

export async function loadMessages(root: string, dispatch: string): Promise<CheckMessage[]> { return checkMessages(root, dispatch); }
export async function loadDeliveries(root: string, dispatch: string): Promise<CheckDelivery[]> { return checkDeliveries(root, dispatch); }

export async function migrateDeliveries(root: string, dispatch: string, messages: readonly CheckMessage[], deliveries: readonly CheckDelivery[], timeoutMs?: number): Promise<void> {
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") throw new Error(database.error);
  for (const message of messages) {
    if (deliveries.some((delivery) => delivery.messageSeqs.includes(message.seq))) continue;
    const classification = classifyMail(message.from, message.type, false);
    const recipient = message.from === "parent"
      ? message.type === "reply" ? "child" : undefined
      : classification === "actionable" || classification === "protocol" ? "parent" : undefined;
    if (recipient === undefined) continue;
    const now = new Date().toISOString();
    await callStateOwner(root, { operation: "create-delivery", delivery: {
      id: `delivery-${Date.now()}-${message.seq}`, dispatchId: dispatch, recipient, consumer: null, consumerGeneration: null,
      messageSeqs: [message.seq], status: "outstanding", createdAt: now, updatedAt: now, acknowledgedAt: null, fencedAt: null,
    } }, timeoutMs, timeoutMs);
  }
}

export function report(dispatch: string, delivery: CheckDelivery | undefined, messages: CheckMessage[], replayed: boolean, json: boolean, includeDeliveryStatus = false): string {
  if (delivery === undefined) return json ? `${JSON.stringify({ dispatchId: dispatch, deliveryId: null, replayed: false, status: "empty", messageSeqs: [], messages: [], text: "" }, null, 2)}\n` : `dispatch: ${dispatch}\nstatus: empty\n`;
  const batch = orderMessages(messages.filter((message) => delivery.messageSeqs.includes(message.seq)));
  const alreadyTyped = delivery.recipient === "child" && delivery.transport === "typed" && delivery.transportReason === "full-direction";
  const alreadySocketDelivered = delivery.recipient === "child" && delivery.transport === "ack-verifying";
  const outputMessages = batch.map(({ path: _path, ...message }) => ({
    ...message,
    ...(alreadyTyped && message.from === "parent" && message.type === "reply" ? { alreadyTyped: true, alreadyTypedAt: delivery.transportAt ?? delivery.updatedAt } : {}),
    ...(alreadySocketDelivered && message.from === "parent" && message.type === "reply" ? {
      alreadyDeliveredThroughSocket: true,
      alreadyDeliveredAt: delivery.transportAt ?? delivery.updatedAt,
      deliveredVia: "peer-socket",
      verified: delivery.transportReason === "peer-socket-verified",
    } : {}),
  }));
  const value = { dispatchId: dispatch, deliveryId: delivery.id, replayed, status: deliveryStatus(batch), ...(includeDeliveryStatus ? { deliveryStatus: delivery.status } : {}), messageSeqs: delivery.messageSeqs, messages: outputMessages, text: batch.map((message) => message.text ?? "").join("\n") };
  if (json) return `${JSON.stringify(value, null, 2)}\n`;
  return `delivery: ${delivery.id}\nreplayed: ${replayed}\nstatus: ${value.status}\n${batch.map((message) => `[${message.seq}] ${message.type || "message"}: ${message.text ?? ""}`).join("\n")}\n`;
}

export async function executeCheck(args: readonly string[], environment: CheckEnvironment, processAdapter: ProcessAdapter = createProcessAdapter(), options: CheckOptions = {}): Promise<Result<string>> {
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
  const root = resolveChildStateDirectory(environment);
  const resolvedDispatch = await dispatchId(environment, root, processAdapter);
  if (resolvedDispatch.kind !== "ok") return resolvedDispatch;
  const dispatch = resolvedDispatch.value;
  const database = readOnlyStateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
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
    const selected = selectDelivery("child", full, checkDeliveries(root, dispatch), messages, resolvedConsumer, generation, options.excludedTransports, options.excludedDeliveryIds);
    if (selected.kind === "selected") {
      if (selected.delivery.consumer === null) {
        let claim: DeliveryRecord | undefined;
        try { claim = await callStateOwner(root, { operation: "claim-delivery", id: selected.delivery.id, consumer: resolvedConsumer, generation }) as DeliveryRecord | undefined; }
        catch (cause: unknown) { return failed(`state owner delivery claim failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
        if (claim === undefined) continue;
      }
      if (options.acknowledge !== false && selected.delivery.recipient === "child") {
        for (const sequence of selected.delivery.messageSeqs) {
          await callStateOwner(root, { operation: "set-delivery-transport", dispatchId: dispatch, sequence, transport: "checked" });
        }
        await callStateOwner(root, { operation: "ack-implicit-delivery", dispatchId: dispatch, deliveryId: selected.delivery.id, recipient: "child" });
      }
      return ok(report(dispatch, selected.delivery, messages, selected.replayed, json));
    }
    if (Date.now() - started >= timeout * 1000) return ok(report(dispatch, undefined, [], false, json));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollInterval * 1000)));
  }
}
