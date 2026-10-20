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

export function classifyMail(from: string, type: string, _hasPriorDone: boolean): "actionable" | "protocol" | { readonly kind: "unknown" } {
  const key = `${from}:${type}`;
  if (["child:ask", "child:done", "child:stalled", "child:policy", "child:supervise", "megabrain:usage", "parent:withdrawal"].includes(key)) return "actionable";
  if (["child:received", "child:ack", "child:done-repeat", "parent:interrupt", "parent:interrupt-result"].includes(key)) return "protocol";
  return { kind: "unknown" };
}

export type UnhandledParentMail = Readonly<{ delivery: CheckDelivery; messages: readonly CheckMessage[] }>;

// The turn-end hook, dispatch list and status view all answer the same question: which child mail
// is still outstanding for the parent? An ask is handled once a later parent reply exists, even
// while that reply is still queued for delivery to the child.
export function unhandledParentMail(deliveries: readonly CheckDelivery[], messages: readonly CheckMessage[]): UnhandledParentMail[] {
  const seen = new Set<string>();
  const replies = messages.filter((message) => message.from === "parent" && message.type === "reply");
  const result: UnhandledParentMail[] = [];
  for (const delivery of deliveries) {
    if (delivery.recipient !== "parent" || delivery.status !== "outstanding" || delivery.transport === "hook-notified" || seen.has(delivery.id)) continue;
    seen.add(delivery.id);
    const batch = orderMessages(messages.filter((message) => delivery.messageSeqs.includes(message.seq)));
    const unhandled = batch.filter((message) => {
      if (classifyMail(message.from, message.type, false) !== "actionable") return false;
      return message.type !== "ask" || !replies.some((reply) => reply.seq > message.seq);
    });
    if (unhandled.length > 0) result.push({ delivery, messages: unhandled });
  }
  return result;
}

function messageFor(delivery: CheckDelivery, messages: readonly CheckMessage[]): CheckMessage[] {
  return orderMessages(messages).filter((message) => delivery.messageSeqs.includes(message.seq));
}

function matchesMailbox(mailbox: "parent" | "child", full: boolean, delivery: CheckDelivery, messages: readonly CheckMessage[]): boolean {
  if (delivery.messageSeqs.length === 0) return false;
  if (delivery.recipient !== undefined && delivery.recipient !== null && delivery.recipient !== mailbox) return false;
  const ordered = messageFor(delivery, messages);
  if (ordered.length === 0) return false;
  for (const message of ordered) {
    if (mailbox === "parent" && (message.from === "child" || message.from === "megabrain")) {
      const classification = classifyMail(message.from, message.type, false);
      if (full ? (typeof classification === "string" || classification.kind !== "unknown") : classification === "actionable") return true;
    }
    if (mailbox === "child" && message.from === "parent") {
      const transported = (delivery.transport === "typed" || delivery.transport === "queue") && delivery.transportReason === "full-direction";
      if (message.type === "reply" && !transported) return true;
    }
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
  excludedTransports: readonly string[] = [],
): CheckSelection {
  const candidates = deliveries
    .filter((delivery) => delivery.status === "outstanding" || (full && delivery.status === "superseded"))
    .filter((delivery) => !excludedTransports.includes(String(delivery.transport ?? "")))
    .filter((delivery) => full || delivery.superseded !== true)
    .filter((delivery) => delivery.consumer === null || delivery.consumer === consumer)
    .filter((delivery) => matchesMailbox(mailbox, full, delivery, messages))
    .sort((left, right) => {
      const priority = (delivery: CheckDelivery): number => {
        if (mailbox !== "parent" || !full) return 0;
        const messagesForDelivery = messageFor(delivery, messages);
        return messagesForDelivery.some((message) => {
          const classification = classifyMail(message.from, message.type, false);
          return message.from === "child" && classification === "actionable";
        }) ? 0 : 1;
      };
      return priority(left) - priority(right) || (left.messageSeqs[0] ?? Number.MAX_SAFE_INTEGER) - (right.messageSeqs[0] ?? Number.MAX_SAFE_INTEGER);
    });
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
