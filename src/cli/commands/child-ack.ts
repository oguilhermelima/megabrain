import { type ProcessAdapter } from "../../adapters/proc.js";
import { appendMessage, findChild as sharedFindChild, resolveCaller, type QueueEnvironment } from "./queue-write.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { acknowledgeDelivery } from "../../core/ack.js";
import { hasCallerIdentity } from "../../core/context.js";
import { usageText } from "../../core/usage.js";
import { ackDelivery, listDeliveries, listMessages, stateDatabase } from "../../adapters/state-db.js";

type ChildArguments = Readonly<{ deliveryId: string; consumer?: string; generation: number; json: boolean }>;
type ChildSession = Readonly<{ host: string; id: string; tmuxSession?: string; tmuxPane?: string }>;
type ChildDispatch = Readonly<{ id: string; session: ChildSession }>;
const usage = usageText("ack");

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

export async function session(environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<ChildSession>> {
  const caller = await resolveCaller(environment, processAdapter);
  if (!hasCallerIdentity(caller)) return failed("this command requires a managed terminal identity; run it inside an Orca or Superset terminal");
  return ok({ host: caller.host, id: caller.terminalId ?? caller.id,
    ...(caller.tmuxSession !== null ? { tmuxSession: caller.tmuxSession } : {}),
    ...(caller.tmuxPane !== null ? { tmuxPane: caller.tmuxPane } : {}),
  });
}

async function findChild(root: string, environment: QueueEnvironment, processAdapter: ProcessAdapter): Promise<Result<ChildDispatch>> {
  const found = await sharedFindChild(root, environment, processAdapter);
  if ("kind" in found) return found;
  return ok({ id: found.dispatch, session: found.session });
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
  const database = stateDatabase({ MEGABRAIN_STATE_DIR: root, HOME: environment.HOME });
  if (database.kind !== "ok") return database;
  const deliveries = listDeliveries(database.value, child.value.id);
  if (deliveries.kind !== "ok") return deliveries;
  const delivery = deliveries.value.find((item) => item.id === parsed.value.deliveryId);
  if (delivery === undefined) return failed(`delivery ${parsed.value.deliveryId} refused: delivery is unknown`);
  const messages = listMessages(database.value, child.value.id);
  if (messages.kind !== "ok") return messages;
  const seqs = Array.isArray(delivery.messageSeqs) ? delivery.messageSeqs.filter((value): value is number => typeof value === "number") : [];
  const isReply = seqs.some((sequence) => messages.value.some((message) => message.seq === sequence && message.from === "parent" && message.type === "reply"));
  const hasReceipt = messages.value.some((message) => message.from === "child" && message.type === "ack" && message.text === parsed.value.deliveryId);
  const decision = acknowledgeDelivery(String(delivery.status), String(delivery.consumer ?? ""), String(delivery.consumerGeneration ?? 0), consumer, parsed.value.generation, parsed.value.deliveryId);
  if (decision.kind !== "ok") return decision;
  if (isReply && !hasReceipt) {
    const receipt = await appendMessage(root, child.value.id, "child", "ack", parsed.value.deliveryId, child.value.session.id, environment, processAdapter);
    if (receipt.kind !== "ok") return receipt;
  }
  const ack = ackDelivery(database.value, parsed.value.deliveryId, consumer, parsed.value.generation);
  if (ack.kind !== "ok") return ack;
  return ok(output(child.value.id, parsed.value.deliveryId, ack.value.duplicate, seqs, parsed.value.json));
}
