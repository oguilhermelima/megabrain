import { describe, expect, test } from "bun:test";
import { classifyMail, deliveryStatus, orderMessages, selectDelivery, type CheckDelivery, type CheckMessage } from "../../src/core/check.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCheck, loadMessages, loadDeliveries } from "../../src/cli/commands/check.js";
import { createDispatch, appendMessage, setDeliveryTransport, listDeliveries } from "../../src/adapters/state-db.js";
import { guardedStateDatabase } from "./state-db-guard.js";

const message = (seq: number, from: string, type: string, text = type): CheckMessage => ({ seq, path: `message-${seq}.json`, from, type, text });
const delivery = (id: string, messageSeqs: number[], status = "outstanding", consumer: string | null = null): CheckDelivery => ({ id, messageSeqs, status, consumer, consumerGeneration: consumer === null ? null : 1 });

describe("orderMessages", () => {
  test("orders by recorded sequence and filename for ties", () => {
    expect(orderMessages([{ ...message(2, "child", "ask"), path: "b.json" }, { ...message(1, "child", "done"), path: "z.json" }, { ...message(2, "child", "done"), path: "a.json" }])).toEqual([{ ...message(1, "child", "done"), path: "z.json" }, { ...message(2, "child", "done"), path: "a.json" }, { ...message(2, "child", "ask"), path: "b.json" }]);
  });
});

describe("classifyMail", () => {
  test.each([["child", "ask", false, "actionable"], ["child", "done", false, "actionable"], ["child", "stalled", false, "actionable"], ["megabrain", "usage", false, "actionable"], ["parent", "withdrawal", false, "actionable"], ["child", "received", false, "protocol"], ["child", "ack", false, "protocol"], ["child", "done", true, "actionable"], ["parent", "interrupt", false, "protocol"], ["parent", "interrupt-result", false, "protocol"]] as const)("classifies %s:%s", (from, type, priorDone, expected) => { expect(classifyMail(from, type, priorDone)).toBe(expected); });
  test("returns unknown for an unrecognised key", () => { expect(classifyMail("child", "unknown", false)).toEqual({ kind: "unknown" }); });
});

describe("selectDelivery", () => {
  const messages = [message(1, "child", "received"), message(2, "child", "ask"), message(3, "parent", "reply")];
  test("shows actionable child mail by default and skips protocol mail", () => { expect(selectDelivery("parent", false, [delivery("protocol", [1]), delivery("action", [2])], messages)).toEqual({ kind: "selected", delivery: delivery("action", [2]), replayed: false }); });
  test("--full shows protocol mail and parent mail to the child", () => {
    expect(selectDelivery("parent", true, [delivery("protocol", [1])], messages)).toEqual({ kind: "selected", delivery: delivery("protocol", [1]), replayed: false });
    expect(selectDelivery("child", false, [delivery("reply", [3])], messages)).toEqual({ kind: "selected", delivery: delivery("reply", [3]), replayed: false });
  });
  test.each(["typed", "queue"] as const)("keeps a %s summary visible to the child until check", (transport) => {
    const reply = { ...delivery("reply", [3]), recipient: "child", transport };
    expect(selectDelivery("child", false, [reply], messages)).toMatchObject({ kind: "selected", delivery: reply });
  });
  test("returns a typed full direction until the child checks it", () => {
    const change = { ...delivery("change", [4]), recipient: "child", transport: "typed", transportReason: "full-direction" };
    expect(selectDelivery("child", false, [change], [...messages, message(4, "parent", "reply")])).toMatchObject({ kind: "selected", delivery: change });
  });
  test("does not return transport-acknowledged directions", () => {
    const queuedChange = { ...delivery("queued-change", [4], "acknowledged", "child-consumer"), recipient: "child", transport: "queue", transportReason: "full-direction" };
    expect(selectDelivery("child", false, [queuedChange], [...messages, message(4, "parent", "reply")], "child-consumer", 1)).toEqual({ kind: "none" });
  });
  test("replays a delivery owned by the same consumer and generation", () => { expect(selectDelivery("parent", false, [delivery("owned", [2], "outstanding", "consumer")], messages, "consumer", 1)).toEqual({ kind: "selected", delivery: delivery("owned", [2], "outstanding", "consumer"), replayed: true }); });
  test("returns unknown when no candidate has a valid first sequence", () => { expect(selectDelivery("parent", false, [{ ...delivery("bad", []), messageSeqs: [] }], messages)).toEqual({ kind: "unknown" }); });
});

describe("check delivery lifecycle", () => {
  test.each(["failed", "queue", "typed"] as const)("returns a %s transported reply until the child checks it", async (transport) => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-check-mailbox-"));
    try {
      const opened = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (opened.kind !== "ok") throw new Error(opened.error);
      createDispatch(opened.value, { dispatchId: "reply-dispatch", state: "running", childHost: "local", terminalId: "child-session" });
      const now = new Date().toISOString();
      const appended = appendMessage(opened.value, "reply-dispatch", { from: "parent", type: "reply", text: "continue safely" }, { delivery: { id: "reply-delivery", recipient: "child", status: "outstanding", createdAt: now, updatedAt: now } });
      if (appended.kind !== "ok") throw new Error(appended.error);
      setDeliveryTransport(opened.value, "reply-dispatch", appended.value.seq, transport, "full-direction");
      opened.value.close();

      const env = { MEGABRAIN_STATE_DIR: root, MEGABRAIN_DISPATCH_STATE_DIR: root, MEGABRAIN_DISPATCH_ID: "reply-dispatch", MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "child-session", MEGABRAIN_CONSUMER_ID: "child" };
      const loadedDeliveries = await loadDeliveries(root, "reply-dispatch"); const loadedMessages = await loadMessages(root, "reply-dispatch");
      expect(selectDelivery("child", false, loadedDeliveries, loadedMessages, "child").kind).toBe("selected");
      const first = await executeCheck(["--timeout", "0", "--json"], env);
      expect(first.kind).toBe("ok");
      expect(first.kind === "ok" ? JSON.parse(first.value).text : "").toBe("continue safely");
      if (transport === "typed") {
        const parsed = first.kind === "ok" ? JSON.parse(first.value) as { messages: Array<Record<string, unknown>> } : { messages: [] };
        expect(parsed.messages[0]).toMatchObject({ alreadyTyped: true });
        expect(parsed.messages[0]?.alreadyTypedAt).toBeString();
      }
      const afterRead = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (afterRead.kind !== "ok") throw new Error(afterRead.error);
      const delivery = listDeliveries(afterRead.value, "reply-dispatch");
      expect(delivery.kind === "ok" ? delivery.value[0]?.status : "").toBe("acknowledged");
      afterRead.value.close();

      const second = await executeCheck(["--timeout", "0", "--json"], env);
      expect(second.kind === "ok" ? JSON.parse(second.value).status : "").toBe("empty");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("deliveryStatus", () => {
  test.each([["ask", "waiting_for_reply"], ["done", "done"], ["stalled", "stalled"], ["reply", "reply"], ["withdrawal", "withdrawal"], ["received", "received"], ["ack", "acknowledged"], ["other", "done"]] as const)("maps %s", (type, expected) => { expect(deliveryStatus([message(1, "child", type)])).toBe(expected); });
  test("uses the first ordered message and supports empty batches", () => { expect(deliveryStatus([])).toBe("done"); expect(deliveryStatus([message(2, "child", "done"), message(1, "child", "ask")])).toBe("waiting_for_reply"); });
});
