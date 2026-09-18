import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath, liveDispatchDirectories } from "../../adapters/dispatch-store.js";
import { atomicJson, appendMessage, readJson, type QueueEnvironment } from "./queue-write.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { acknowledgeChildDelivery } from "../../core/child-ack.js";

type JsonRecord = Record<string, unknown>;
type ChildArguments = Readonly<{ deliveryId: string; consumer?: string; generation: number; json: boolean }>;
type ChildSession = Readonly<{ host: string; id: string; tmuxSession?: string; tmuxPane?: string }>;
type ChildDispatch = Readonly<{ id: string; session: ChildSession }>;

const usage = "Usage: megabrain ack <delivery-id> [--consumer <id>] [--generation <number>] [--json]\n";

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function integer(value: unknown): number | undefined { return typeof value === "number" && Number.isInteger(value) ? value : undefined; }

function parseArgs(args: readonly string[], environment: QueueEnvironment): Result<ChildArguments> {
  const deliveryId = args[0] ?? "";
  if (deliveryId === "") return failed(usage, 2);
  let consumer: string | undefined;
  let generation = Number(environment.MEGABRAIN_CONSUMER_GENERATION ?? "1");
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--consumer") consumer = args[++index] ?? "";
    else if (arg === "--generation") generation = Number(args[++index]);
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok(usage);
    else return failed(`unknown orchestrate ack option: ${arg}`, 2);
  }
  if (!Number.isInteger(generation) || generation < 1) return failed("--generation must be a positive number", 2);
  return ok({ deliveryId, ...(consumer !== undefined ? { consumer } : {}), generation, json });
}

async function session(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<ChildSession>> {
  if (environment.TMUX && environment.TMUX_PANE) {
    const result = await processAdapter.run("tmux", ["display-message", "-p", "-t", environment.TMUX_PANE, "#{session_name}"]);
    if (result.kind !== "ok" || result.value.stdout.trim() === "") return failed("tmux session could not be resolved");
    const host = environment.SUPERSET_TERMINAL_ID ? "superset" : environment.ORCA_TERMINAL_HANDLE ? "orca" : "tmux";
    return ok({ host, id: `${result.value.stdout.trim()}:${environment.TMUX_PANE}`, tmuxSession: result.value.stdout.trim(), tmuxPane: environment.TMUX_PANE });
  }
  if (environment.SUPERSET_TERMINAL_ID) return ok({ host: "superset", id: environment.SUPERSET_TERMINAL_ID });
  if (environment.ORCA_TERMINAL_HANDLE) return ok({ host: "orca", id: environment.ORCA_TERMINAL_HANDLE });
  return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
}

function matches(sessionValue: ChildSession, meta: JsonRecord): boolean {
  if (sessionValue.tmuxSession && sessionValue.tmuxPane) return meta.runtime === "tmux" && meta.tmuxSession === sessionValue.tmuxSession && meta.tmuxPane === sessionValue.tmuxPane;
  return meta.terminalId === sessionValue.id && meta.childHost === sessionValue.host;
}

async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<ChildDispatch>> {
  const current = await session(environment, processAdapter);
  if (current.kind !== "ok") return current;
  const direct = environment.MEGABRAIN_DISPATCH_ID;
  if (direct && /^[A-Za-z0-9._-]+$/.test(direct)) {
    const meta = await readJson(await dispatchPath(root, direct, "meta.json"));
    if (meta?.dispatchId === direct && matches(current.value, meta)) return ok({ id: direct, session: current.value });
  }
  const found: string[] = [];
  for (const directory of await liveDispatchDirectories(root)) {
    const meta = await readJson(`${directory}/meta.json`);
    if (meta?.dispatchId && matches(current.value, meta)) found.push(meta.dispatchId as string);
  }
  if (found.length > 1) {
    if (current.value.tmuxSession && current.value.tmuxPane) return failed(`tmux identity matches multiple dispatches for session ${current.value.tmuxSession} pane ${current.value.tmuxPane}: ${found[0]}, ${found[1]}`);
    return failed(`terminal identity matches multiple dispatches for ${current.value.host}/${current.value.id}: ${found[0]}, ${found[1]}`);
  }
  const dispatch = found[0];
  if (dispatch) return ok({ id: dispatch, session: current.value });
  if (current.value.tmuxSession && current.value.tmuxPane) return failed(`no managed dispatch belongs to tmux session ${current.value.tmuxSession} pane ${current.value.tmuxPane}`);
  return failed(`no managed dispatch belongs to ${current.value.host}/${current.value.id}`);
}

async function lock(path: string): Promise<void> {
  while (true) {
    try { await mkdir(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
}

async function isReply(root: string, dispatch: string, delivery: JsonRecord): Promise<boolean> {
  const messageSeqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => integer(value) !== undefined) : [];
  for (const sequence of messageSeqs) {
    const message = await readJson(await dispatchPath(root, dispatch, `messages/${String(sequence).padStart(4, "0")}-parent-reply.json`));
    if (message?.from === "parent" && message.type === "reply") return true;
  }
  return false;
}

async function hasReplyReceipt(root: string, dispatch: string, deliveryId: string): Promise<boolean> {
  const directory = await dispatchPath(root, dispatch, "messages");
  for (const entry of await readdir(directory).catch(() => [])) {
    if (!entry.endsWith(".json")) continue;
    const message = await readJson(`${directory}/${entry}`);
    if (message?.from === "child" && message.type === "ack" && message.text === deliveryId) return true;
  }
  return false;
}

function output(dispatchId: string, deliveryId: string, duplicate: boolean, messageSeqs: readonly unknown[], json: boolean): string {
  const value = { dispatchId, deliveryId, acknowledged: true, duplicate, status: "acknowledged", messageSeqs };
  if (json) return `${JSON.stringify(value, null, 2)}\n`;
  return `acknowledged: ${deliveryId}\nduplicate: ${duplicate}\n`;
}

export async function executeChildAck(args: readonly string[], environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usage);
  const parsed = parseArgs(args, environment);
  if (parsed.kind !== "ok") return parsed;
  const root = resolveStateDirectory(environment);
  const child = await findChild(root, environment, processAdapter);
  if (child.kind !== "ok") return child;
  const consumer = parsed.value.consumer ?? environment.MEGABRAIN_CONSUMER_ID ?? (child.value.session.tmuxSession && child.value.session.tmuxPane
    ? `child/${child.value.session.host}/${child.value.session.tmuxSession}/${child.value.session.tmuxPane}`
    : `child/${child.value.session.host}/${child.value.session.id}`);
  if (consumer === "") return failed("consumer identity is empty");
  const path = await dispatchPath(root, child.value.id, `deliveries/${parsed.value.deliveryId}.json`);
  const delivery = await readJson(path);
  if (delivery === undefined) return failed(`delivery ${parsed.value.deliveryId} refused: delivery is unknown`);
  const status = text(delivery.status);
  const messageSeqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs : [];
  const decision = acknowledgeChildDelivery(status, text(delivery.consumer), integer(delivery.consumerGeneration) === undefined ? "" : String(integer(delivery.consumerGeneration)), consumer, parsed.value.generation, parsed.value.deliveryId);
  if (decision.kind !== "ok") return decision;
  const duplicate = decision.value.duplicate;
  const lockPath = await dispatchPath(root, child.value.id, "messages/.lock");
  await lock(lockPath);
  try {
    const current = await readJson(path);
    const reply = await isReply(root, child.value.id, delivery);
    if (reply && !(await hasReplyReceipt(root, child.value.id, parsed.value.deliveryId))) {
      const receipt = await appendMessage(root, child.value.id, "child", "ack", parsed.value.deliveryId, child.value.session.id, environment, processAdapter, true);
      if (receipt.kind !== "ok") return receipt;
    }
    if (!duplicate && current !== undefined) {
      const now = new Date().toISOString();
      await atomicJson(path, { ...current, status: "acknowledged", acknowledgedAt: now, updatedAt: now });
    }
  } finally { await rm(lockPath, { recursive: true, force: true }); }
  return ok(output(child.value.id, parsed.value.deliveryId, duplicate, messageSeqs, parsed.value.json));
}
