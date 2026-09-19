import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNative } from "../../src/cli/commands/native.js";
import { buildXcodebuildArgs, candidatesForRuntimeFromSimctl, candidatesFromSimctl, evaluateNativeHealth, formatNativeList, nativeBuildStepFailure, renderNativeUrl, runtimesFromSimctl, selectDevice, validateKind, validateMetroPort, validateTimeout } from "../../src/core/native.js";
import { ok, failed } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";

const candidates = [{ udid: "one", state: "Booted", name: "Phone" }, { udid: "two", state: "Shutdown", name: "Other" }];
describe("native planning", () => {
  test("parses installed runtimes from simctl", () => {
    expect(runtimesFromSimctl({ runtimes: [{ name: "tvOS 26.5", version: "26.5", buildversion: "23J98", identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5", isAvailable: true }] })).toEqual({ kind: "ok", value: [{ platform: "tvOS", version: "26.5", build: "23J98", identifier: "com.apple.CoreSimulator.SimRuntime.tvOS-26-5" }] });
  });
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

describe("native health decision rules", () => {
  const base = {
    process: { state: "running" as const },
    metro: { state: "attached" as const },
    tree: { count: 3 },
    frame: { state: "differs" as const },
  };

  test("reports rendered when all evidence supports a real screen", () => {
    expect(evaluateNativeHealth(base)).toMatchObject({ status: "rendered", reason: "frame differs and accessibility tree exposes 3 elements" });
  });

  test("reports not-rendered when the process is stopped, before other sources", () => {
    expect(evaluateNativeHealth({ ...base, process: { state: "not-running", reason: "process is not running" }, metro: { state: "not-attached" }, tree: { count: 0 }, frame: { state: "unknown", reason: "capture failed" } })).toMatchObject({ status: "not-rendered", reason: "process is not running" });
  });

  test("reports unknown when the process cannot be checked", () => {
    expect(evaluateNativeHealth({ ...base, process: { state: "unknown", reason: "simctl unavailable" } })).toMatchObject({ status: "unknown", reason: "simctl unavailable" });
  });

  test("reports not-rendered when the live frame matches its control", () => {
    expect(evaluateNativeHealth({ ...base, frame: { state: "identical", reason: "hashes match" }, tree: { count: 4 } })).toMatchObject({ status: "not-rendered", reason: "screen matches the control frame" });
  });

  test("reports loading for an empty or single-element tree", () => {
    expect(evaluateNativeHealth({ ...base, tree: { count: 0 } })).toMatchObject({ status: "loading", reason: "accessibility tree exposes 0 elements" });
    expect(evaluateNativeHealth({ ...base, tree: { count: 1 } })).toMatchObject({ status: "loading", reason: "accessibility tree exposes 1 element" });
  });

  test("uses Metro as supporting evidence when the tree is unavailable", () => {
    expect(evaluateNativeHealth({ ...base, tree: { count: null, reason: "driver unavailable" } })).toMatchObject({ status: "rendered", reason: "frame differs and Metro is attached" });
    expect(evaluateNativeHealth({ ...base, metro: { state: "not-attached" }, tree: { count: null, reason: "driver unavailable" } })).toMatchObject({ status: "unknown", reason: "accessibility tree is unavailable and Metro is not attached" });
  });

  test("keeps missing frame evidence unknown", () => {
    expect(evaluateNativeHealth({ ...base, frame: { state: "unknown", reason: "no control frame" } })).toMatchObject({ status: "unknown", reason: "no control frame" });
  });
});

describe("native runtime commands", () => {
  const process: ProcessAdapter = {
    async run(command, args) {
      if (command === "xcrun" && args.join(" ") === "simctl list runtimes --json") return ok({ stdout: JSON.stringify({ runtimes: [{ name: "iOS 27.0", version: "27.0", buildversion: "24A1", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0" }] }), stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount: () => 1,
  };

  test("lists installed runtimes from a simctl fixture", async () => {
    const result = await executeNative(["runtime", "list", "--installed", "--json"], {}, process);
    expect(result).toEqual({ kind: "ok", value: JSON.stringify({ platform: "all", runtimes: [{ platform: "iOS", version: "27.0", build: "24A1", identifier: "com.apple.CoreSimulator.SimRuntime.iOS-27-0" }], available: [], refusal: null }) + "\n" });
  });

  test("returns a structured refusal for JSON usage errors", async () => {
    const result = await executeNative(["runtime", "list", "--available", "--json", "--bad"], {}, process);
    expect(result).toEqual({ kind: "ok", value: JSON.stringify({ refusal: { code: "invalid-arguments", message: "unknown native runtime list option: --bad" } }) + "\n", exitCode: 2 });
  });
});

describe("native build planning", () => {
  test("discovers the worktree root through the process adapter when git is unavailable", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-root-"));
    const state = join(worktree, "state");
    const app = join(worktree, "apps", "tv");
    await mkdir(join(worktree, ".megabrain"));
    await mkdir(app, { recursive: true });
    await writeFile(join(worktree, ".megabrain", "native.json"), JSON.stringify({ version: 1, surfaces: { tv: { appPath: "apps/tv" } } }));
    await writeFile(join(app, "app.json"), JSON.stringify({ expo: { ios: { bundleIdentifier: "com.example.tv" } } }));
    const calls: string[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push([command, ...args].join(" "));
        return failed("git is unavailable");
      },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return calls.length; },
    };

    try {
      const result = await executeNative(["build", "tv"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_STATE_DIR: state }, process);
      expect(result).toEqual({ kind: "failed", error: `scheme is required in ${join(app, "app.json")}`, exitCode: 1 });
      expect(calls).toEqual([`git -C ${worktree} rev-parse --show-toplevel`]);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("builds the working simulator xcodebuild arguments", () => {
    expect(buildXcodebuildArgs("tvOS", "ios/canto.xcworkspace", "canto", "26.5", "tv-1", "ios/build")).toEqual([
      "-workspace", "ios/canto.xcworkspace", "-scheme", "canto", "-sdk", "appletvsimulator",
      "-destination", "platform=tvOS Simulator,id=tv-1", "-derivedDataPath", "ios/build", "CODE_SIGNING_ALLOWED=NO", "build",
    ]);
  });

  test("stops at the first failed build step", () => {
    const outcomes = { prebuild: { ok: true }, pods: { ok: true }, build: { ok: false, error: "xcodebuild failed" }, install: { ok: false }, launch: { ok: false } } as const;
    expect(nativeBuildStepFailure(outcomes)).toBe("build");
    expect(nativeBuildStepFailure({ prebuild: { ok: true }, pods: { ok: true }, build: { ok: true }, install: { ok: true }, launch: { ok: true } })).toBeUndefined();
  });

  test("resolves a device from kind and runtime rather than a stored udid", () => {
    expect(candidatesForRuntimeFromSimctl({ devices: {
      "tvOS-26-5": [{ udid: "tv-old", state: "Booted", name: "Apple TV", isAvailable: true }],
      "tvOS-27-0": [{ udid: "tv-new", state: "Booted", name: "Apple TV", isAvailable: true }],
    } }, "tv", "26.5")).toEqual({ kind: "ok", value: [{ udid: "tv-old", state: "Booted", name: "Apple TV" }] });
  });

  test("refuses a build when its app path is not configured", async () => {
    const result = await executeNative(["build", "tv"], {}, {
      async run() { return failed("must not run a process"); },
      async startDetached() { return failed("must not start a process"); },
      invocationCount() { return 0; },
    });
    expect(result).toEqual({ kind: "failed", error: "app path is required for tv; pass surfaces.tv.appPath in .megabrain/native.json", exitCode: 1 });
  });
});

describe("native health Appium session", () => {
  test("requests a headless driver session", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
        if (command === "curl" && args[3] === "http://127.0.0.1:4723/session") return ok({ stdout: JSON.stringify({ value: { sessionId: "session-1" } }), stderr: "", exitCode: 0 });
        if (command === "curl" && args[0] === "-fsS" && args[1]?.includes("/source")) return ok({ stdout: "<XCUIElementTypeWindow/><XCUIElementTypeButton/>", stderr: "", exitCode: 0 });
        if (command === "curl" && args[0] === "-fsS" && args[1] === "-X") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => calls.length,
    };

    const result = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one"], {}, process);
    expect(result.kind).toBe("ok");
    const sessionRequest = calls.find((call) => call.command === "curl" && call.args[3] === "http://127.0.0.1:4723/session");
    expect(sessionRequest).toBeDefined();
    expect(JSON.parse(sessionRequest?.args.at(-1) ?? "{}").capabilities.alwaysMatch["appium:isHeadless"]).toBe(true);
    expect(JSON.parse(sessionRequest?.args.at(-1) ?? "{}").capabilities.alwaysMatch["appium:newCommandTimeout"]).toBe(60);
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
