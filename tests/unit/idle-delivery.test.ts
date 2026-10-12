import { describe, expect, test } from "bun:test";
import { deliverWhenIdle, startDeferredDelivery } from "../../src/core/idle-delivery.js";

function harness(overrides: Partial<Parameters<typeof deliverWhenIdle>[0]> = {}) {
  let state: "busy" | "idle" = "busy";
  let composer = "";
  let read = false;
  const calls = { sends: 0, clears: 0, waits: 0 };
  const input: Parameters<typeof deliverWhenIdle>[0] = {
    timeoutMs: 100,
    initialDelayMs: 10,
    maxDelayMs: 20,
    inspect: async () => state,
    composer: async () => composer,
    clear: async () => { calls.clears += 1; composer = ""; return true; },
    send: async () => { calls.sends += 1; return true; },
    isRead: async () => read,
    wait: async () => { calls.waits += 1; state = "idle"; },
    ...overrides,
  };
  return { input, calls, setState: (value: "busy" | "idle") => { state = value; }, setComposer: (value: string) => { composer = value; }, setRead: (value: boolean) => { read = value; } };
}

describe("idle-gated message delivery", () => {
  test("defers while busy and delivers once idle", async () => {
    const h = harness();
    const result = await deliverWhenIdle(h.input);
    expect(result).toBe("delivered");
    expect(h.calls.sends).toBe(1);
  });

  test("waits on foreign composer text without clearing it", async () => {
    const h = harness();
    h.setState("idle");
    h.setComposer("operator draft");
    let checks = 0;
    h.input.wait = async () => { checks += 1; if (checks === 1) h.setComposer(""); };
    const result = await deliverWhenIdle(h.input);
    expect(result).toBe("delivered");
    expect(h.calls.clears).toBe(0);
    expect(h.calls.sends).toBe(1);
  });

  test("renews the worker lease while waiting beyond its original TTL", async () => {
    const renewals: number[] = [];
    const h = harness({
      timeoutMs: 10_000,
      renew: async () => { renewals.push(Date.now()); },
      wait: async () => { h.setState("idle"); },
    });
    h.setState("busy");
    expect(await deliverWhenIdle(h.input)).toBe("delivered");
    expect(renewals.length).toBeGreaterThan(0);
  });

  test("clears only a composer draft that matches its own text", async () => {
    const h = harness({ ownDraft: "our previous nudge" });
    h.setState("idle");
    h.setComposer("our previous nudge");
    expect(await deliverWhenIdle(h.input)).toBe("delivered");
    expect(h.calls.clears).toBe(1);
  });

  test("cancels when the message is read before delivery", async () => {
    const h = harness();
    h.setRead(true);
    expect(await deliverWhenIdle(h.input)).toBe("cancelled");
    expect(h.calls.sends).toBe(0);
  });

  test("times out as failed when the target never becomes idle", async () => {
    let recorded = "";
    const h = harness({ timeoutMs: 15, wait: async () => {}, record: async (outcome) => { recorded = outcome; } });
    expect(await deliverWhenIdle(h.input)).toBe("failed");
    expect(recorded).toBe("failed");
    expect(h.calls.sends).toBe(0);
  });

  test("does not start a second deliverer for the same target", async () => {
    let reserved = false;
    let starts = 0;
    const reserve = async () => { if (reserved) return false; reserved = true; return true; };
    const start = async () => { starts += 1; return true; };
    const release = async () => { reserved = false; };
    expect(await startDeferredDelivery("terminal-1", "one", reserve, start, release)).toBe("started");
    expect(await startDeferredDelivery("terminal-1", "two", reserve, start, release)).toBe("already-running");
    expect(starts).toBe(1);
  });

  test("retries a failed send on the backoff schedule and delivers", async () => {
    const h = harness({ timeoutMs: 10_000, retryDelaysMs: [5, 15, 60] });
    h.setState("idle");
    const waits: number[] = [];
    h.input.wait = async (ms) => { waits.push(ms); };
    h.input.send = async () => { h.calls.sends += 1; return h.calls.sends >= 3; };
    expect(await deliverWhenIdle(h.input)).toBe("delivered");
    expect(h.calls.sends).toBe(3);
    expect(waits).toEqual([5, 15]);
  });

  test("gives up after the last backoff step and records why every attempt failed", async () => {
    const h = harness({ timeoutMs: 10_000, retryDelaysMs: [5, 15, 60] });
    h.setState("idle");
    h.input.wait = async () => {};
    h.input.send = async () => { h.calls.sends += 1; return false; };
    h.input.sendError = () => "orca terminal send exited 1: no such terminal";
    const attempts: { decision: string; reason?: string }[] = [];
    h.input.attempt = async (details) => { attempts.push({ decision: details.decision, reason: details.reason }); };
    expect(await deliverWhenIdle(h.input)).toBe("failed");
    expect(h.calls.sends).toBe(4);
    const sendFailures = attempts.filter((a) => a.decision === "send-failed");
    expect(sendFailures).toHaveLength(4);
    for (const failure of sendFailures) expect(failure.reason).toBe("orca terminal send exited 1: no such terminal");
  });

  test("a message pulled by the child during a retry wait is cancelled, not resent", async () => {
    const h = harness({ timeoutMs: 10_000, retryDelaysMs: [5, 15] });
    h.setState("idle");
    h.input.wait = async () => { h.setRead(true); };
    h.input.send = async () => { h.calls.sends += 1; return false; };
    expect(await deliverWhenIdle(h.input)).toBe("cancelled");
    expect(h.calls.sends).toBe(1);
  });
});
