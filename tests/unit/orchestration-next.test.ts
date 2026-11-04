import { describe, expect, test } from "bun:test";
import { nextOrchestrationStep } from "../../src/core/orchestration-next.js";

describe("nextOrchestrationStep", () => {
  test.each([
    ["spawn", { dispatchId: "dispatch-1" }, "Megabrain notifies you when the child reports back; end your turn."],
    ["watch", { dispatchId: "dispatch-1", status: "waiting_for_reply" }, "Answer the child's question with orchestrate reply dispatch-1."],
    ["watch", { dispatchId: "dispatch-1", status: "done" }, "Read the child pane, then close dispatch-1."],
    ["ack", { dispatchId: "dispatch-1", messageType: "ask" }, "Answer the child's question with orchestrate reply dispatch-1."],
    ["ack", { dispatchId: "dispatch-1", messageType: "done" }, "Close the completed dispatch with orchestrate close dispatch-1."],
    ["reply", { delivery: "queued-for-check" }, "Wait for the child to read the reply and report back."],
    ["change", { status: "delivered-unconfirmed" }, "Check the child's pane to confirm the new direction arrived."],
    ["change", { status: "queued" }, "The direction is queued; wait for the child to check its messages."],
  ] as const)("suggests the next step for %s", (action, receipt, expected) => {
    expect(nextOrchestrationStep(action, receipt)).toBe(expected);
  });

  test.each([
    ["watch", { status: "empty" }],
    ["ack", { messageType: "received" }],
    ["reply", { delivery: "delivered" }],
    ["change", { status: "delivered" }],
    ["close", { status: "closed" }],
  ] as const)("omits a hint when %s has no obvious next step", (action, receipt) => {
    expect(nextOrchestrationStep(action, receipt)).toBeUndefined();
  });
});
