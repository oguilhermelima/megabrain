import { describe, expect, test } from "bun:test";
import { classifyMail, deliveryStatus, orderMessages, selectDelivery, type CheckDelivery, type CheckMessage } from "../../src/core/check.js";

const message = (seq: number, from: string, type: string, text = type): CheckMessage => ({ seq, path: `message-${seq}.json`, from, type, text });
const delivery = (id: string, messageSeqs: number[], status = "outstanding", consumer: string | null = null): CheckDelivery => ({ id, messageSeqs, status, consumer, consumerGeneration: consumer === null ? null : 1 });

describe("orderMessages", () => {
  test("orders by recorded sequence and filename for ties", () => {
    expect(orderMessages([{ ...message(2, "child", "ask"), path: "b.json" }, { ...message(1, "child", "done"), path: "z.json" }, { ...message(2, "child", "done"), path: "a.json" }])).toEqual([{ ...message(1, "child", "done"), path: "z.json" }, { ...message(2, "child", "done"), path: "a.json" }, { ...message(2, "child", "ask"), path: "b.json" }]);
  });
});

describe("classifyMail", () => {
  test.each([["child", "ask", false, "actionable"], ["child", "done", false, "actionable"], ["child", "stalled", false, "actionable"], ["megabrain", "usage", false, "actionable"], ["parent", "withdrawal", false, "actionable"], ["child", "received", false, "protocol"], ["child", "ack", false, "protocol"], ["child", "done", true, "protocol"], ["parent", "interrupt", false, "protocol"], ["parent", "interrupt-result", false, "protocol"]] as const)("classifies %s:%s", (from, type, priorDone, expected) => { expect(classifyMail(from, type, priorDone)).toBe(expected); });
  test("returns unknown for an unrecognised key", () => { expect(classifyMail("child", "unknown", false)).toEqual({ kind: "unknown" }); });
});

describe("selectDelivery", () => {
  const messages = [message(1, "child", "received"), message(2, "child", "ask"), message(3, "parent", "reply")];
  test("shows actionable child mail by default and skips protocol mail", () => { expect(selectDelivery("parent", false, [delivery("protocol", [1]), delivery("action", [2])], messages)).toEqual({ kind: "selected", delivery: delivery("action", [2]), replayed: false }); });
  test("--full shows protocol mail and parent mail to the child", () => {
    expect(selectDelivery("parent", true, [delivery("protocol", [1])], messages)).toEqual({ kind: "selected", delivery: delivery("protocol", [1]), replayed: false });
    expect(selectDelivery("child", false, [delivery("reply", [3])], messages)).toEqual({ kind: "selected", delivery: delivery("reply", [3]), replayed: false });
  });
  test("replays a delivery owned by the same consumer and generation", () => { expect(selectDelivery("parent", false, [delivery("owned", [2], "outstanding", "consumer")], messages, "consumer", 1)).toEqual({ kind: "selected", delivery: delivery("owned", [2], "outstanding", "consumer"), replayed: true }); });
  test("returns unknown when no candidate has a valid first sequence", () => { expect(selectDelivery("parent", false, [{ ...delivery("bad", []), messageSeqs: [] }], messages)).toEqual({ kind: "unknown" }); });
});

describe("deliveryStatus", () => {
  test.each([["ask", "waiting_for_reply"], ["done", "done"], ["stalled", "stalled"], ["reply", "reply"], ["withdrawal", "withdrawal"], ["received", "received"], ["ack", "acknowledged"], ["other", "done"]] as const)("maps %s", (type, expected) => { expect(deliveryStatus([message(1, "child", type)])).toBe(expected); });
  test("uses the first ordered message and supports empty batches", () => { expect(deliveryStatus([])).toBe("done"); expect(deliveryStatus([message(2, "child", "done"), message(1, "child", "ask")])).toBe("waiting_for_reply"); });
});
