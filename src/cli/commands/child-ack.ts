import { mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { dispatchPath } from "../../adapters/dispatch-store.js";
import { atomicJson, appendMessage, findChild as sharedFindChild, readJson, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { acknowledgeDelivery } from "../../core/ack.js";
import { hasCallerIdentity } from "../../core/context.js";
import { usageText } from "../../core/usage.js";

type JsonRecord = Record<string, unknown>;
type ChildArguments = Readonly<{ deliveryId: string; consumer?: string; generation: number; json: boolean }>;
type ChildSession = Readonly<{ host: string; id: string; tmuxSession?: string; tmuxPane?: string }>;
type ChildDispatch = Readonly<{ id: string; session: ChildSession }>;

const usage = usageText("ack");

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
    else return failed(`unknown orchestrate ack option: ${arg}`, 2);
  }
  if (!Number.isInteger(generation) || generation < 1) return failed("--generation must be a positive number", 2);
  return ok({ deliveryId, ...(consumer !== undefined ? { consumer } : {}), generation, json });
}

// The child's own identity, matched against what spawn recorded for it (meta.terminalId /
// meta.childHost, or meta.tmuxSession / meta.tmuxPane). A real child never carries both a tmux
// pane and a superset/orca terminal handle at once — spawn's tmux launch line never sets either,
// and its host launch line clears TMUX/TMUX_PANE before starting the child — so the shared
// resolver's ordinary superset > orca > tmux precedence is safe here too. Prefers the terminal
// handle over a stable agent-session id, since spawn only ever hands a child a terminal-based
// identity.
export async function session(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<ChildSession>> {
  const caller = await resolveCaller(environment, processAdapter);
  if (!hasCallerIdentity(caller)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  return ok({
    host: caller.host,
    id: caller.terminalId ?? caller.id,
    ...(caller.tmuxSession !== null ? { tmuxSession: caller.tmuxSession } : {}),
    ...(caller.tmuxPane !== null ? { tmuxPane: caller.tmuxPane } : {}),
  });
}

// Reuses queue-write.ts's findChild (the same "is the current terminal itself a managed
// dispatch's child" question ask/done/received/the turn-end hook all ask) instead of this file's
// own former matches()/findChild pair, which had the same gap findChild's own tmux-identity fix
// closed: a runtime tmux record could still match by terminalId/childHost for a non-tmux-hosted
// caller, including a legacy record carrying that caller's own id. One behaviour difference from
// the deleted implementation, accepted: a caller whose own resolveCaller-based probe finds no
// identity now also gets queue-write.ts's `tmux list-panes -a` fallback for a plain-tmux caller
// (this file's own session() below, kept for its independent test coverage, has
// no such fallback and never did — a strict improvement, not a loss, matching the same regression
// tests/test-queue-write-cli.sh already covers for ask/done/received).
async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<ChildDispatch>> {
  const found = await sharedFindChild(root, environment, processAdapter);
  if ("kind" in found) return found;
  return ok({ id: found.dispatch, session: found.session });
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
  const decision = acknowledgeDelivery(status, text(delivery.consumer), integer(delivery.consumerGeneration) === undefined ? "" : String(integer(delivery.consumerGeneration)), consumer, parsed.value.generation, parsed.value.deliveryId);
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
