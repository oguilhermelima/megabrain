import { describe, expect, test } from "bun:test";
import { parseStopArgs, stopOutput, stopDecision } from "../../src/core/orchestrate-stop.js";
import { reconcileDecision } from "../../src/core/orchestrate-reconcile.js";

describe("orchestrate stop", () => {
  test("parses json and rejects unknown options", () => {
    expect(parseStopArgs(["dispatch", "--json"])).toEqual({ kind: "ok", value: { dispatchId: "dispatch", json: true } });
    expect(parseStopArgs(["dispatch", "--bad"])).toEqual({ kind: "failed", error: "unknown orchestrate stop option: --bad", exitCode: 2 });
  });

  test("only working or proven identity can be interrupted", () => {
    expect(stopDecision("working", "known")).toEqual({ kind: "ok", value: "interrupt" });
    expect(stopDecision("pending-check", "known")).toEqual({ kind: "failed", error: "pending check frame: messages are waiting for the next tool call", exitCode: 1 });
    expect(stopDecision("working", "unknown")).toEqual({ kind: "failed", error: "interrupt affordance is unknown", exitCode: 1 });
  });

  test("formats landed and failed interruption", () => {
    expect(stopOutput("d", "queued", false)).toBe("interrupted: d\nresult: queued\n");
    expect(JSON.parse(stopOutput("d", "not-landed", true))).toEqual({ dispatchId: "d", status: "not-interrupted", result: "not-landed", interrupted: false });
  });
});

describe("orchestrate reconcile", () => {
  const meta = (values: Record<string, unknown> = {}) => ({ state: "running", processState: "running", terminalState: "owned", failureCount: 0, ...values });

  test("does not create dispatch state from terminal identity proofs", () => {
    expect(reconcileDecision(meta(), "proven", "alive")).toEqual({ outcome: "running", updates: {} });
  });

  test("derives exited state from a dead terminal", () => {
    expect(reconcileDecision(meta(), "missing", "unknown")).toEqual({ outcome: "exited", updates: { state: "exited", processState: "exited", terminalState: "missing", stage: "agent-exit", reason: "terminal process exited" } });
  });

  test("increments missing terminal failures and preserves settled process states", () => {
    expect(reconcileDecision(meta({ processState: "succeeded" }), "missing", "unknown").updates.processState).toBeUndefined();
    const first = reconcileDecision(meta({ processState: "stopped", failureCount: 2 }), "missing", "unknown");
    expect(first.updates.state).toBe("failed");
    expect(reconcileDecision({ ...meta({ processState: "stopped", terminalState: "missing", failureCount: 3 }), state: first.updates.state }, "missing", "unknown").updates.state).toBe("circuit_broken");
  });

  test("does not mutate state while the terminal is still alive", () => {
    expect(reconcileDecision(meta(), "proven", "alive")).toEqual({ outcome: "running", updates: {} });
  });
});
