import { describe, expect, test } from "bun:test";
import { candidatesFromSimctl, formatNativeList, renderNativeUrl, selectDevice, validateKind, validateMetroPort, validateTimeout } from "../../src/core/native.js";

const candidates = [{ udid: "one", state: "Booted", name: "Phone" }, { udid: "two", state: "Shutdown", name: "Other" }];
describe("native planning", () => {
  test("validates kind, timeout and metro port", () => {
    expect(validateKind("tv")).toEqual({ kind: "ok", value: "tv" });
    expect(validateKind("bad")).toEqual({ kind: "failed", error: "expected simulator kind phone or tv, got: bad", exitCode: 2 });
    expect(validateTimeout("0").kind).toBe("failed");
    expect(validateMetroPort("none")).toEqual({ kind: "ok", value: "none" });
    expect(validateMetroPort("70000").kind).toBe("failed");
  });
  test("filters available devices by runtime", () => {
    expect(candidatesFromSimctl({ devices: { "iOS-1": [{ udid: "p", state: "Shutdown", name: "P", isAvailable: true }], "tvOS-1": [{ udid: "t", state: "Booted", name: "T", isAvailable: true }] } }, "tv")).toEqual({ kind: "ok", value: [{ udid: "t", state: "Booted", name: "T" }] });
  });
  test("selects identifiers before names and reports ambiguity", () => {
    expect(selectDevice("phone", candidates, "one", false)).toEqual({ kind: "ok", value: candidates[0] });
    expect(selectDevice("phone", [{ ...candidates[0], name: "Same" }, { ...candidates[1], name: "Same" }], "Same", false).kind).toBe("failed");
    expect(selectDevice("phone", candidates, "two", true).error).toContain("not a booted");
  });
  test("renders routes and rejects unknown placeholders", () => {
    expect(renderNativeUrl("canto:///{route}", "/deep", "", "bundle", "one")).toEqual({ kind: "ok", value: "canto:///deep" });
    expect(renderNativeUrl("x/{bad}", "r", "", "b", "d").kind).toBe("failed");
  });
  test("formats plain and json lists", () => {
    expect(formatNativeList("phone", candidates, false)).toContain("Phone\tBooted\tone");
    expect(JSON.parse(formatNativeList("phone", candidates, true)).devices).toHaveLength(2);
  });
});
