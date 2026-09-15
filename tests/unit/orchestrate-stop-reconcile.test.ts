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

  test("adopts a proven live terminal and keeps unknown parent unclassified", () => {
    expect(reconcileDecision(meta(), "proven", "alive")).toEqual({ outcome: "adopted", updates: { stage: "terminal-proven", reason: "identity-proven" } });
    expect(reconcileDecision(meta(), "proven", "unknown").outcome).toBe("parent-unproven");
  });

  test("marks a missing running terminal as exited and does not use time", () => {
    expect(reconcileDecision(meta(), "missing", "unknown")).toEqual({ outcome: "agent-exited", updates: { processState: "exited", terminalState: "missing", stage: "agent-exit", reason: "agent exited without reporting" } });
  });

  test("increments missing terminal failures and preserves settled process states", () => {
    expect(reconcileDecision(meta({ processState: "succeeded" }), "missing", "unknown").updates.processState).toBeUndefined();
    expect(reconcileDecision(meta({ processState: "stopped", failureCount: 2 }), "missing", "unknown").updates.state).toBe("circuit_broken");
  });
});
