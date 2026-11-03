export type OrchestrationReceiptAction = "spawn" | "watch" | "ack" | "reply" | "change" | "close";
export type OrchestrationReceipt = Readonly<Record<string, unknown>>;

function dispatchId(receipt: OrchestrationReceipt): string {
  return typeof receipt.dispatchId === "string" && receipt.dispatchId !== "" ? receipt.dispatchId : "the dispatch";
}

export function nextOrchestrationStep(action: OrchestrationReceiptAction, receipt: OrchestrationReceipt): string | undefined {
  const id = dispatchId(receipt);
  switch (action) {
    case "spawn":
      return "Megabrain notifies you when the child reports back; end your turn.";
    case "watch":
      if (receipt.status === "waiting_for_reply") return `Answer the child's question with orchestrate reply ${id}.`;
      if (receipt.status === "done") return `Read the child pane, then close ${id}.`;
      return undefined;
    case "ack":
      if (receipt.messageType === "ask") return `Answer the child's question with orchestrate reply ${id}.`;
      if (receipt.messageType === "done") return `Close the completed dispatch with orchestrate close ${id}.`;
      return undefined;
    case "reply":
      return receipt.delivery === "queued-for-check" ? "Wait for the child to read the reply and report back." : undefined;
    case "change":
      if (receipt.status === "delivered-unconfirmed") return "Check the child's pane to confirm the new direction arrived.";
      if (receipt.status === "queued") return "The direction is queued; wait for the child to check its messages.";
      return undefined;
    case "close":
      return undefined;
  }
}

export function withNextOrchestrationStep<T extends Record<string, unknown>>(
  action: OrchestrationReceiptAction,
  context: OrchestrationReceipt,
  receipt: T,
): T | (T & { next: string }) {
  const next = nextOrchestrationStep(action, context);
  return next === undefined ? receipt : { ...receipt, next };
}
