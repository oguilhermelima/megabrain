import { describe, expect, test } from "bun:test";
import {
  decideLoopTurn,
  parseContextThreshold,
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

describe("parseContextThreshold", () => {
  test("reads percentages and token counts with an optional k or m suffix", () => {
    expect(parseContextThreshold("80%")).toEqual({ kind: "ok", value: { unit: "percent", amount: 80 } });
    expect(parseContextThreshold("150k")).toEqual({ kind: "ok", value: { unit: "tokens", amount: 150000 } });
    expect(parseContextThreshold("1m")).toEqual({ kind: "ok", value: { unit: "tokens", amount: 1000000 } });
    expect(parseContextThreshold("1.5M")).toEqual({ kind: "ok", value: { unit: "tokens", amount: 1500000 } });
    expect(parseContextThreshold("150000")).toEqual({ kind: "ok", value: { unit: "tokens", amount: 150000 } });
  });

  test("refuses a bare number up to 100, zero, negatives, junk and out-of-range percentages", () => {
    for (const bad of ["90", "100", "0", "0%", "0k", "-5k", "-1%", "101%", "abc", "", "k", "%", "12kk", "1e5", "NaN", "Infinity"]) {
      expect(parseContextThreshold(bad)).toMatchObject({ kind: "failed" });
    }
  });
});

describe("token thresholds", () => {
  const unknownWindow = { status: "known" as const, usedTokens: 160000, sourceFrame: "claude transcript usage: 160000 tokens, window unknown" };

  test("an absolute 150k ceiling fires at 160000 tokens with an unknown window", () => {
    const decision = evaluateContextThreshold({ contextCeilingTokens: 150000 }, emptyState, unknownWindow);
    expect(decision.action).toBe("stop");
    expect(decision.record).toEqual({ action: "stop", percentUsed: null, usedTokens: 160000, sourceFrame: unknownWindow.sourceFrame });
  });

  test("a percentage threshold never fires without a percentage, and does not clear its latch", () => {
    const armed = { ceilingLatched: true, compactLatched: true };
    const decision = evaluateContextThreshold({ contextCeiling: 10, compactAt: 5 }, armed, unknownWindow);
    expect(decision).toEqual({ action: "none", state: armed, record: null });
  });

  test("an absolute compact threshold fires once and rearms below it", () => {
    const policy: ContextPolicy = { compactAtTokens: 100000, contextCeilingTokens: 200000 };
    const first = evaluateContextThreshold(policy, emptyState, unknownWindow);
    expect(first.action).toBe("compact");
    expect(evaluateContextThreshold(policy, first.state, unknownWindow).action).toBe("none");
    const below = evaluateContextThreshold(policy, first.state, { ...unknownWindow, usedTokens: 50000 });
    expect(below.state.compactLatched).toBe(false);
  });

  test("validation refuses a threshold given in both units, a bad token count, and compact not below ceiling in the same unit", () => {
    expect(validateContextPolicy({ contextCeiling: 90, contextCeilingTokens: 150000 })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ compactAtTokens: 0 })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ compactAtTokens: 150000, contextCeilingTokens: 150000 })).toMatchObject({ kind: "failed" });
    expect(validateContextPolicy({ compactAtTokens: 100000, contextCeilingTokens: 150000 })).toMatchObject({ kind: "ok" });
    expect(validateContextPolicy({ compactAt: 80, contextCeilingTokens: 150000 })).toMatchObject({ kind: "ok" });
    expect(validateContextPolicy({ loop: true, contextCeilingTokens: 150000 })).toMatchObject({ kind: "ok" });
  });
});

describe("evaluateContextThreshold", () => {
  const policy: ContextPolicy = { contextCeiling: 90, compactAt: 80, loop: false };

  test("fires once on a threshold crossing and rearms only after a known lower reading", () => {
    const reading = { status: "known" as const, usedTokens: 82000, percentUsed: 82, sourceFrame: "Context 18% left" };
    const first = evaluateContextThreshold(policy, emptyState, reading);
    expect(first.action).toBe("compact");
    expect(first.record).toEqual({ action: "compact", usedTokens: 82000, percentUsed: 82, sourceFrame: "Context 18% left" });

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
      usedTokens: 91000,
      percentUsed: 91,
      sourceFrame: "Context 9% left",
    });
    expect(decision.action).toBe("stop");
    expect(decision.record).toEqual({ action: "stop", percentUsed: 91, usedTokens: 91000, sourceFrame: "Context 9% left" });
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
