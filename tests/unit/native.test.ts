import { describe, expect, test } from "bun:test";
import { executeNative } from "../../src/cli/commands/native.js";
import { candidatesFromSimctl, formatNativeList, renderNativeUrl, selectDevice, validateKind, validateMetroPort, validateTimeout } from "../../src/core/native.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

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

describe("native appium lifecycle", () => {
  test("starts detached, waits for port readiness, and leaves status up", async () => {
    const calls: string[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        if (command === "lsof") return ok({ stdout: "1234\n", stderr: "", exitCode: 0 });
        if (command === "ps") return ok({ stdout: "appium --port 4723\n", stderr: "", exitCode: 0 });
        if (command === "curl") return ok({ stdout: "{}\n", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached(command, args) {
        calls.push([command, ...args].join(" "));
        return ok({ pid: 1234 });
      },
      invocationCount: () => calls.length,
    };

    const result = await executeNative(["appium", "start"], {}, process);
    expect(result).toEqual({ kind: "ok", value: "appium: up (port 4723, pid 1234)\n" });
    expect(calls).toEqual([
      "appium --port 4723 --log-level error",
      "curl -fsS --max-time 1 http://127.0.0.1:4723/status",
      "lsof -tiTCP:4723 -sTCP:LISTEN",
      "ps -p 1234 -o command=",
    ]);
  });

  test("fails when the detached server never answers", async () => {
    const process: ProcessAdapter = {
      async run(command) {
        if (command === "curl") return failed("connection refused");
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return ok({ pid: 1234 }); },
      invocationCount: () => 0,
    };

    const result = await executeNative(["appium", "start"], { MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("appium did not start on port 4723");
  });

  test("stops the Appium process found on the listening port", async () => {
    const calls: string[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        if (command === "lsof") return ok({ stdout: "1234\n", stderr: "", exitCode: 0 });
        if (command === "ps") return ok({ stdout: "appium --port 4723\n", stderr: "", exitCode: 0 });
        if (command === "kill") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return ok({ pid: 1234 }); },
      invocationCount: () => calls.length,
    };

    const result = await executeNative(["appium", "stop"], {}, process);
    expect(result).toEqual({ kind: "ok", value: "appium: stopped (pid 1234)\n" });
    expect(calls).toEqual([
      "lsof -tiTCP:4723 -sTCP:LISTEN",
      "ps -p 1234 -o command=",
      "kill 1234",
    ]);
  });
});
