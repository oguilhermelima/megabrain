export type CheckMessage = {
  readonly seq: number;
  readonly path: string;
  readonly from: string;
  readonly type: string;
  readonly text: string;
  readonly [key: string]: unknown;
};

export type CheckDelivery = {
  readonly id: string;
  readonly messageSeqs: readonly number[];
  readonly status: string;
  readonly consumer: string | null;
  readonly consumerGeneration: number | null;
  readonly [key: string]: unknown;
};

export type CheckSelection =
  | { readonly kind: "selected"; readonly delivery: CheckDelivery; readonly replayed: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

export function orderMessages(messages: readonly CheckMessage[]): CheckMessage[] {
  return [...messages].sort((left, right) => left.seq - right.seq || left.path.localeCompare(right.path));
}

export function classifyMail(from: string, type: string, hasPriorDone: boolean): "actionable" | "protocol" | { readonly kind: "unknown" } {
  const key = `${from}:${type}`;
  if (key === "child:done" && hasPriorDone) return "protocol";
  if (["child:ask", "child:done", "child:stalled", "megabrain:usage", "parent:withdrawal"].includes(key)) return "actionable";
  if (["child:received", "child:ack", "child:done-repeat", "parent:interrupt", "parent:interrupt-result"].includes(key)) return "protocol";
  return { kind: "unknown" };
}

function messageFor(delivery: CheckDelivery, messages: readonly CheckMessage[]): CheckMessage[] {
  return orderMessages(messages).filter((message) => delivery.messageSeqs.includes(message.seq));
}

function matchesMailbox(mailbox: "parent" | "child", full: boolean, delivery: CheckDelivery, messages: readonly CheckMessage[]): boolean {
  if (delivery.messageSeqs.length === 0) return false;
  if (delivery.recipient !== undefined && delivery.recipient !== null && delivery.recipient !== mailbox) return false;
  const ordered = messageFor(delivery, messages);
  if (ordered.length === 0) return false;
  let priorDone = false;
  for (const message of ordered) {
    if (mailbox === "parent" && (message.from === "child" || message.from === "megabrain")) {
      const classification = classifyMail(message.from, message.type, priorDone);
      if (full ? classification !== "unknown" : classification === "actionable") return true;
    }
    if (mailbox === "child" && message.from === "parent") {
      if (full ? ["reply", "withdrawal", "received", "ack", "ask", "done", "stalled", "interrupt", "interrupt-result"].includes(message.type) : ["reply", "withdrawal"].includes(message.type)) return true;
    }
    if (message.from === "child" && message.type === "done") priorDone = true;
  }
  return false;
}

export function selectDelivery(
  mailbox: "parent" | "child",
  full: boolean,
  deliveries: readonly CheckDelivery[],
  messages: readonly CheckMessage[],
  consumer = "",
  generation = 1,
): CheckSelection {
  const candidates = deliveries
    .filter((delivery) => delivery.status === "outstanding" || (full && delivery.status === "superseded"))
    .filter((delivery) => full || delivery.superseded !== true)
    .filter((delivery) => delivery.consumer === null || delivery.consumer === consumer)
    .filter((delivery) => matchesMailbox(mailbox, full, delivery, messages))
    .sort((left, right) => (left.messageSeqs[0] ?? Number.MAX_SAFE_INTEGER) - (right.messageSeqs[0] ?? Number.MAX_SAFE_INTEGER));
  if (candidates.length === 0) return deliveries.some((delivery) => delivery.messageSeqs.length === 0) ? { kind: "unknown" } : { kind: "none" };
  const selected = candidates[0];
  return { kind: "selected", delivery: selected, replayed: selected.consumer === consumer && selected.consumerGeneration === generation && selected.consumer !== null };
}

export function deliveryStatus(messages: readonly CheckMessage[]): string {
  switch (orderMessages(messages)[0]?.type) {
    case "ask": return "waiting_for_reply";
    case "done": return "done";
    case "stalled": return "stalled";
    case "reply": return "reply";
    case "withdrawal": return "withdrawal";
    case "received": return "received";
    case "ack": return "acknowledged";
    default: return "done";
  }
}
