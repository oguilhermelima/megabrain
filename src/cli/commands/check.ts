import { failed, ok, type Result } from "../../core/result.js";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { classifyMail, deliveryStatus, orderMessages, selectDelivery, type CheckDelivery, type CheckMessage } from "../../core/check.js";
import { resolveStateDirectory } from "../../core/state.js";
import { resolveConsumerIdentity, type ConsumerIdentityInput } from "../../core/identity.js";
import { rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dispatchDeliveryFile, dispatchFile, resolveDispatchDirectory } from "../../adapters/dispatch-store.js";
import { getTmux } from "../../hosts/tmux.js";

export type CheckEnvironment = Readonly<Record<string, string | undefined>>;
type JsonRecord = Record<string, unknown>;

export async function readJson(path: string): Promise<JsonRecord | undefined> {
  try {
    const value: unknown = await Bun.file(path).json();
    return typeof value === "object" && value !== null ? value as JsonRecord : undefined;
  } catch { return undefined; }
}

function number(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined; }

export async function files(path: string): Promise<string[]> {
  const result: string[] = [];
  try {
    for await (const entry of new Bun.Glob("**/*.json").scan({ cwd: path, absolute: true })) result.push(entry);
  } catch {
    return [];
  }
  return result;
}

export async function dispatchId(environment: CheckEnvironment, root: string, processAdapter: ProcessAdapter): Promise<string | undefined> {
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  if (direct !== undefined && /^[A-Za-z0-9._-]+$/.test(direct)) {
    const resolved = await resolveDispatchDirectory(root, direct);
    const meta = resolved.kind === "ok" ? await readJson(dispatchFile(resolved.value, "meta")) : undefined;
    if (meta !== undefined && meta.dispatchId === direct) return direct;
  }
  if (environment.TMUX !== undefined && environment.TMUX.length > 0 && environment.TMUX_PANE !== undefined && environment.TMUX_PANE.length > 0) {
    const result = await getTmux().sessionForPane(environment.TMUX_PANE, processAdapter);
    if (result.kind !== "ok") return undefined;
    const session = result.value;
    if (session.length === 0) return undefined;
    for (const path of await files(`${root}/dispatches`)) {
      if (!path.endsWith("/meta.json")) continue;
      const meta = await readJson(path);
      if (meta?.runtime === "tmux" && meta.tmuxSession === session && meta.tmuxPane === environment.TMUX_PANE) return typeof meta.dispatchId === "string" ? meta.dispatchId : undefined;
    }
    return undefined;
  }
  const host = environment.SUPERSET_TERMINAL_ID !== undefined ? "superset" : environment.ORCA_TERMINAL_HANDLE !== undefined ? "orca" : undefined;
  const id = environment.SUPERSET_TERMINAL_ID ?? environment.ORCA_TERMINAL_HANDLE;
  if (host === undefined || id === undefined) return undefined;
  for (const path of await files(`${root}/dispatches`)) {
    if (!path.endsWith("/meta.json")) continue;
    const meta = await readJson(path);
    if (meta?.terminalId === id && meta.childHost === host) return typeof meta.dispatchId === "string" ? meta.dispatchId : undefined;
  }
  return undefined;
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

export async function loadMessages(directory: string): Promise<CheckMessage[]> {
  const result: CheckMessage[] = [];
  for (const path of await files(directory)) {
    const value = await readJson(path);
    const seq = number(value?.seq);
    if (value !== undefined && seq !== undefined && typeof value.from === "string" && typeof value.type === "string") result.push({ ...value, seq, path, from: value.from, type: value.type, text: typeof value.text === "string" ? value.text : "" });
  }
  return orderMessages(result);
}

export async function loadDeliveries(directory: string): Promise<CheckDelivery[]> {
  const result: CheckDelivery[] = [];
  for (const path of await files(directory)) {
    const value = await readJson(path);
    const id = typeof value?.id === "string" ? value.id : undefined;
    const seqs = Array.isArray(value?.messageSeqs) ? value.messageSeqs.filter((seq): seq is number => number(seq) !== undefined) : [];
    if (value !== undefined && id !== undefined && typeof value.status === "string") result.push({ ...value, id, messageSeqs: seqs, status: value.status, consumer: typeof value.consumer === "string" ? value.consumer : null, consumerGeneration: number(value.consumerGeneration) ?? null });
  }
  return result;
}

export async function migrateDeliveries(root: string, dispatch: string, messages: readonly CheckMessage[], deliveries: readonly CheckDelivery[]): Promise<void> {
  const resolved = await resolveDispatchDirectory(root, dispatch);
  if (resolved.kind !== "ok") return;
  const directory = dispatchFile(resolved.value, "deliveries");
  for (const message of messages) {
    if (deliveries.some((delivery) => delivery.messageSeqs.includes(message.seq))) continue;
    const priorDone = messages.some((candidate) => candidate.from === "child" && candidate.type === "done" && candidate.seq < message.seq);
    const classification = classifyMail(message.from, message.type, priorDone);
    const recipient = message.from === "parent" && message.type === "reply" ? "child" : classification === "actionable" || classification === "protocol" ? "parent" : undefined;
    if (recipient === undefined) continue;
    const id = `delivery-${Date.now()}-${message.seq}`;
    const value = { id, dispatchId: dispatch, recipient, consumer: null, consumerGeneration: null, messageSeqs: [message.seq], status: "outstanding", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), acknowledgedAt: null, fencedAt: null };
    await Bun.write(`${directory}/${id}.json`, `${JSON.stringify(value)}\n`);
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
    else if (arg === "-h" || arg === "--help") return ok("Usage: megabrain check [--timeout <seconds>] [--poll-interval <seconds>] [--wait-mode poll] [--consumer <id>] [--generation <number>] [--full] [--json]\n");
    else return failed(`unknown check option: ${arg}`, 2);
  }
  if (!Number.isInteger(timeout) || timeout < 0) return failed("--timeout must be a non-negative number of seconds", 2);
  if (!Number.isInteger(pollInterval) || pollInterval < 0) return failed("--poll-interval must be a non-negative number of seconds", 2);
  if (waitMode !== "poll") return failed("--wait-mode must be poll", 2);
  if (!Number.isInteger(generation) || generation < 1) return failed("--generation must be a positive number", 2);
  const root = resolveStateDirectory(environment);
  const dispatch = await dispatchId(environment, root, processAdapter);
  if (dispatch === undefined) return failed(`no managed dispatch belongs to superset/${environment.SUPERSET_TERMINAL_ID ?? "unknown"}`);
  const dispatchResult = await resolveDispatchDirectory(root, dispatch);
  if (dispatchResult.kind !== "ok") return dispatchResult;
  const dispatchHandle = dispatchResult.value;
  const resolvedIdentity = resolveConsumerIdentity({
    ...(await childIdentity(environment, processAdapter)),
    mailbox: "child",
    environmentConsumer: environment.MEGABRAIN_CONSUMER_ID,
    explicitConsumer: consumer,
    sessionHost: environment.MEGABRAIN_SESSION_HOST,
    sessionId: environment.MEGABRAIN_SESSION_ID,
  });
  if (resolvedIdentity.kind === "unknown") return failed(resolvedIdentity.reason);
  const resolvedConsumer = resolvedIdentity.value;
  const started = Date.now();
  let selected: ReturnType<typeof selectDelivery> = { kind: "none" };
  let messages: CheckMessage[] = [];
  while (true) {
    messages = await loadMessages(dispatchFile(dispatchHandle, "messages"));
    const deliveries = await loadDeliveries(dispatchFile(dispatchHandle, "deliveries"));
    await migrateDeliveries(root, dispatch, messages, deliveries);
    selected = selectDelivery("child", full, await loadDeliveries(dispatchFile(dispatchHandle, "deliveries")), messages, resolvedConsumer, generation);
    if (selected.kind === "selected" || Date.now() - started >= timeout * 1000) break;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, pollInterval * 1000)));
  }
  if (selected.kind === "selected") {
    if (selected.delivery.consumer === null) {
      const path = dispatchDeliveryFile(dispatchHandle, selected.delivery.id);
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      const claimed = { ...selected.delivery, consumer: resolvedConsumer, consumerGeneration: generation, updatedAt: new Date().toISOString() };
      try {
        await Bun.write(temporaryPath, `${JSON.stringify(claimed)}\n`);
        await rename(temporaryPath, path);
      } catch (error: unknown) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
      return ok(report(dispatch, selected.delivery, messages, false, json));
    }
    return ok(report(dispatch, selected.delivery, messages, selected.replayed, json));
  }
  return ok(report(dispatch, undefined, [], false, json));
}
