import { describe, expect, test } from "bun:test";
import { verifyClaudePeerConsumption } from "../../src/core/claude-peer-delivery.js";
import { formatDeliveryAcknowledgment } from "../../src/core/chat-message-format.js";

describe("Claude peer verification", () => {
  test("formats the receiver's acknowledgment command for each mailbox direction", () => {
    expect(formatDeliveryAcknowledgment("dispatch-1", "delivery-2", "child")).toBe("After reading, acknowledge with: megabrain ack delivery-2");
    expect(formatDeliveryAcknowledgment("dispatch-1", "delivery-2", "parent")).toBe("After reading, acknowledge with: megabrain orchestrate ack dispatch-1 delivery-2");
  });

  test("receiver acknowledgment confirms delivery without scanning the transcript", async () => {
    let typed = 0;
    let scans = 0;
    const result = await verifyClaudePeerConsumption({
      acknowledged: async () => true,
      status: async () => "idle",
      scan: async () => { scans += 1; return undefined; },
      sleep: async () => undefined,
      fallback: async () => { typed += 1; },
    });
    expect(result).toBe("delivered");
    expect(scans).toBe(0);
    expect(typed).toBe(0);
  });

  test("transcript consumption is the fallback proof when no acknowledgment arrives", async () => {
    let typed = 0;
    let now = 0;
    const result = await verifyClaudePeerConsumption({
      acknowledged: async () => false,
      status: async () => "idle",
      scan: async () => "consumed",
      sleep: async (ms) => { now += ms; },
      now: () => now,
      idleWindowMs: 20,
      pollIntervalMs: 10,
      fallback: async () => { typed += 1; },
    });
    expect(result).toBe("delivered");
    expect(typed).toBe(0);
  });

  test("a dropped message in an idle session marks delivery lost and falls back once", async () => {
    let typed = 0;
    let now = 0;
    const result = await verifyClaudePeerConsumption({
      acknowledged: async () => false,
      status: async () => "idle",
      scan: async () => undefined,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      idleWindowMs: 20,
      pollIntervalMs: 10,
      fallback: async () => { typed += 1; },
    });
    expect(result).toBe("fallback");
    expect(typed).toBe(1);
  });

  test("busy time does not use the idle window before eventual transcript proof", async () => {
    let typed = 0;
    let polls = 0;
    let now = 0;
    const result = await verifyClaudePeerConsumption({
      acknowledged: async () => false,
      status: async () => ++polls < 5 ? "busy" : "idle",
      scan: async () => polls >= 6 ? "consumed" : undefined,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      idleWindowMs: 1,
      pollIntervalMs: 10,
      fallback: async () => { typed += 1; },
    });
    expect(result).toBe("delivered");
    expect(typed).toBe(0);
  });

  test("a late acknowledgment after the one fallback does not trigger another send", async () => {
    let typed = 0;
    let now = 0;
    const result = await verifyClaudePeerConsumption({
      acknowledged: async () => now > 100,
      status: async () => "idle",
      scan: async () => undefined,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      idleWindowMs: 20,
      pollIntervalMs: 10,
      fallback: async () => { typed += 1; },
    });
    expect(result).toBe("fallback");
    expect(typed).toBe(1);
    expect(await verifyClaudePeerConsumption({
      acknowledged: async () => true,
      status: async () => "idle",
      scan: async () => undefined,
      sleep: async () => undefined,
      fallback: async () => { typed += 1; },
    })).toBe("delivered");
    expect(typed).toBe(1);
  });
});
