import { failed, ok, type Result } from "./result.js";
import { childMessageErrorUsage as usageFromTable, usageText } from "./usage.js";

export type QueueMailClass = "actionable" | "protocol" | undefined;
export type QueueRecipient = "parent" | "child" | undefined;

export function childMessageUsage(type: "received" | "ask" | "done"): string {
  return usageText(type);
}

function childMessageErrorUsage(type: "received" | "ask" | "done"): string {
  if (type === "received") return usageText(type);
  return usageFromTable(type);
}

export function parseChildMessage(type: string, args: readonly string[]): Result<string> {
  if (type === "received") return args.length === 0 ? ok("prompt received") : failed(childMessageErrorUsage(type), 2);
  if (type === "ask" || type === "done") {
    const text = args[0] === "--text" ? args.length === 2 ? args[1] : "" : args.length === 1 ? args[0] : "";
    return text !== "" ? ok(text) : failed(childMessageErrorUsage(type), 2);
  }
  return failed(`unsupported child message type: ${type}`, 2);
}

export function classifyQueueMail(from: string, type: string, hasPriorDone: boolean): QueueMailClass {
  if (from === "child" && type === "done" && hasPriorDone) return "protocol";
  if (["child:ask", "child:done", "child:stalled", "megabrain:usage", "parent:withdrawal"].includes(`${from}:${type}`)) return "actionable";
  if (["child:received", "child:ack", "child:done-repeat", "parent:interrupt", "parent:interrupt-result"].includes(`${from}:${type}`)) return "protocol";
  return undefined;
}

export function recipientForQueueMessage(from: string, type: string, hasPriorDone: boolean): QueueRecipient {
  if (from === "parent" && ["reply", "withdrawal", "interrupt", "interrupt-result"].includes(type)) return "child";
  const classification = classifyQueueMail(from, type, hasPriorDone);
  return classification === undefined ? undefined : "parent";
}

export function nextMessageSequence(names: readonly string[]): number {
  let highest = 0;
  for (const name of names) {
    const match = /^(\d{4,})-[^-]+-.+\.json$/.exec(name);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}
