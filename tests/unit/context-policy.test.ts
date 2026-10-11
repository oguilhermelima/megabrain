import { describe, expect, test } from "bun:test";
import {
  decideLoopTurn,
  evaluateContextThreshold,
  validateContextPolicy,
  type ContextPolicy,
  type ContextThresholdState,
} from "../../src/core/context-policy.js";

const emptyState: ContextThresholdState = { ceilingLatched: false, compactLatched: false };

describe("context policy validation", () => {
  test("requires every loop to have an iteration cap or context ceiling", () => {
    expect(validateContextPolicy({ loop: true })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ loop: true, maxIterations: 3 })).toMatchObject({ kind: "ok" });
    expect(validateContextPolicy({ loop: true, contextCeiling: 90 })).toMatchObject({ kind: "ok" });
  });

  test("rejects invalid percentages and iteration caps", () => {
    expect(validateContextPolicy({ contextCeiling: 101 })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ compactAt: -1 })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ loop: true, maxIterations: 0 })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ loop: true, maxIterations: 1.5 })).toMatchObject({ kind: "failed" });
  });
});

describe("evaluateContextThreshold", () => {
  const policy: ContextPolicy = { contextCeiling: 90, compactAt: 80, loop: false };

  test("fires once on a threshold crossing and rearms only after a known lower reading", () => {
    const reading = { status: "known" as const, percentUsed: 82, sourceFrame: "Context 18% left" };
    const first = evaluateContextThreshold(policy, emptyState, reading);
    expect(first.action).toBe("compact");
    expect(first.record).toEqual({ action: "compact", percentUsed: 82, sourceFrame: "Context 18% left" });

    const repeated = evaluateContextThreshold(policy, first.state, { ...reading, percentUsed: 85 });
    expect(repeated.action).toBe("none");

    const unknown = evaluateContextThreshold(policy, repeated.state, { status: "unknown" });
    expect(unknown.state.compactLatched).toBe(true);

    const below = evaluateContextThreshold(policy, unknown.state, { ...reading, percentUsed: 70 });
    expect(below.state.compactLatched).toBe(false);

    const recrossed = evaluateContextThreshold(policy, below.state, reading);
    expect(recrossed.action).toBe("compact");
  });

  test("stops at the ceiling and records the reading that caused it", () => {
    const decision = evaluateContextThreshold(policy, emptyState, {
      status: "known",
      percentUsed: 91,
      sourceFrame: "Context 9% left",
    });
    expect(decision.action).toBe("stop");
    expect(decision.record).toEqual({ action: "stop", percentUsed: 91, sourceFrame: "Context 9% left" });
  });

  test("never acts on unknown and does not let unknown clear an existing crossing latch", () => {
    expect(evaluateContextThreshold(policy, emptyState, { status: "unknown" })).toEqual({
      action: "none",
      state: emptyState,
      record: null,
    });
    const armed = { ceilingLatched: false, compactLatched: true };
    expect(evaluateContextThreshold(policy, armed, { status: "unknown" }).state).toEqual(armed);
  });
});

describe("decideLoopTurn", () => {
  test("ends when done is present in the queue, even at the iteration cap", () => {
    expect(decideLoopTurn(true, 3, 3)).toEqual({ action: "done", completedIterations: 3 });
  });

  test("stops at the iteration budget when the queue has no done message", () => {
    expect(decideLoopTurn(false, 2, 2)).toEqual({ action: "stop", completedIterations: 2 });
  });

  test("continues while done is absent and budget remains", () => {
    expect(decideLoopTurn(false, 1, 2)).toEqual({ action: "continue", completedIterations: 1 });
  });
});
