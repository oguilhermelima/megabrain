import { describe, expect, test } from "bun:test";
import { resolveDispatchId, resolveDispatchIdSuffix } from "../../src/core/dispatch-paths.js";
import { USAGE_LINES } from "../../src/core/usage.js";

describe("resolveDispatchId", () => {
  test.each(["", "../outside", "dispatch/child", "dispatch child", "dispatch$child"]) (
    "rejects %j",
    (dispatchId) => expect(resolveDispatchId(dispatchId)).toEqual({ kind: "invalid", dispatchId }),
  );

  test.each(["dispatch-1", "a.b_c-2"]) ("accepts %j", (dispatchId) => {
    expect(resolveDispatchId(dispatchId)).toEqual({ kind: "valid", dispatchId });
  });
});

describe("resolveDispatchIdSuffix", () => {
  const visible = ["dispatch-20261011120144320-50861-ddb1bbe0", "dispatch-20261010120000000-12345-1122aabb"];

  test("resolves a unique suffix of at least eight characters", () => {
    expect(resolveDispatchIdSuffix("ddb1bbe0", visible)).toEqual({ kind: "resolved", dispatchId: visible[0] });
  });

  test("prefers an exact full id even when it is another id's suffix", () => {
    expect(resolveDispatchIdSuffix("dispatch-12345678", ["dispatch-12345678", "other-dispatch-12345678"]))
      .toEqual({ kind: "resolved", dispatchId: "dispatch-12345678" });
  });

  test("preserves exact legacy ids shorter than eight characters", () => {
    expect(resolveDispatchIdSuffix("legacy", ["legacy", "dispatch-legacy"]))
      .toEqual({ kind: "resolved", dispatchId: "legacy" });
  });

  test("reports every match for an ambiguous suffix", () => {
    const matches = ["dispatch-20261011120144320-50861-aabbccdd", "dispatch-20261010120000000-12345-aabbccdd"];
    expect(resolveDispatchIdSuffix("aabbccdd", matches)).toEqual({ kind: "ambiguous", dispatchIds: matches });
  });

  test("reports an unknown suffix", () => {
    expect(resolveDispatchIdSuffix("00000000", visible)).toEqual({ kind: "unknown" });
  });

  test("refuses suffixes shorter than eight characters", () => {
    expect(resolveDispatchIdSuffix("b1bbe0", visible)).toEqual({ kind: "too-short" });
  });
});

describe("orchestrate dispatch id usage", () => {
  test("every verb taking a dispatch id documents suffix support", () => {
    const unsupported = Object.entries(USAGE_LINES)
      .filter(([key, line]) => key.startsWith("orchestrate-") && /<dispatch-id>/.test(line))
      .map(([key]) => key);

    expect(unsupported).toEqual([]);
  });
});
