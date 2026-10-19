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

  test("does not report an empty downloadable runtime list as success", async () => {
    const result = await executeNative(["runtime", "list", "--available", "--json"], {}, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.value)).toMatchObject({ refusal: { code: "invalid-arguments", message: expect.stringContaining("not supported") } });
  });
});

describe("native simulator lifecycle commands", () => {
  const phone = "11111111-1111-1111-1111-111111111111";
  const tv = "22222222-2222-2222-2222-222222222222";
  function simulatorProcess(options: { initiallyBooted?: boolean; neverBoots?: boolean; devices?: unknown } = {}) {
    const calls: string[][] = [];
    let booted = options.initiallyBooted ?? false;
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push([command, ...args]);
        if (command === "xcrun" && args.join(" ") === "simctl list devices --json") {
          const devices = options.devices ?? { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: phone, state: booted ? "Booted" : "Shutdown", name: "iPhone", isAvailable: true }], "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [{ udid: tv, state: "Booted", name: "Apple TV", isAvailable: true }] };
          return ok({ stdout: JSON.stringify({ devices }), stderr: "", exitCode: 0 });
        }
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "shutdown") {
          if (!booted) return failed("xcrun exited with status 149");
          booted = false;
          return ok({ stdout: "", stderr: "", exitCode: 0 });
        }
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "boot") {
          if (!options.neverBoots) booted = true;
          return ok({ stdout: "", stderr: "", exitCode: 0 });
        }
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    return { process, calls };
  }

  test("shutdown succeeds when booted and already shut down", async () => {
    const active = simulatorProcess({ initiallyBooted: true });
    const shutdownResult = await executeNative(["sim", "shutdown", phone, "--json"], {}, active.process);
    expect(shutdownResult.kind).toBe("ok");
    expect(JSON.parse(shutdownResult.value)).toMatchObject({ udid: phone, state: "Shutdown", refusal: null });
    expect(active.calls.some((call) => call.join(" ") === `xcrun simctl shutdown ${phone}`)).toBe(true);
    const stopped = simulatorProcess();
    const alreadyStoppedResult = await executeNative(["sim", "shutdown", phone, "--json"], {}, stopped.process);
    expect(alreadyStoppedResult.kind).toBe("ok");
    expect(JSON.parse(alreadyStoppedResult.value)).toMatchObject({ udid: phone, state: "Shutdown", refusal: null });
  });

  test("restart shuts down, boots, and waits for booted state", async () => {
    const { process, calls } = simulatorProcess({ initiallyBooted: true });
    const result = await executeNative(["sim", "restart", phone, "--timeout", "2", "--json"], {}, process);
    expect(result.kind).toBe("ok");
    expect(calls.findIndex((call) => call[2] === "shutdown")).toBeLessThan(calls.findIndex((call) => call[2] === "boot"));
    expect(JSON.parse(result.value)).toMatchObject({ udid: phone, state: "Booted", waitedMs: expect.any(Number) });
  });

  test("restart reports timeout when boot never completes", async () => {
    const { process, calls } = simulatorProcess({ initiallyBooted: true, neverBoots: true });
    const result = await executeNative(["sim", "restart", phone, "--timeout", "1", "--json"], {}, process);
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.value).refusal.message).toContain("timed out");
    expect(calls.some((call) => call[2] === "boot")).toBe(true);
  });

  test("restart waits with bootstatus instead of repeatedly listing simulators", async () => {
    const { process, calls } = simulatorProcess({ initiallyBooted: true });
    await executeNative(["sim", "restart", phone, "--timeout", "2", "--json"], {}, process);
    expect(calls.filter((call) => call[2] === "list" && call[3] === "devices")).toHaveLength(1);
    expect(calls.filter((call) => call[2] === "bootstatus")).toHaveLength(1);
  });

  test("lists booted devices across phone and tv runtimes", async () => {
    const { process } = simulatorProcess({ initiallyBooted: true });
    const result = await executeNative(["sim", "list", "--booted", "--json"], {}, process);
    expect(result.kind).toBe("ok");
    const rows = JSON.parse(result.value).devices;
    expect(rows.map((row: { kind: string }) => row.kind)).toEqual(["phone", "tv"]);
    expect(rows.map((row: { udid: string }) => row.udid)).toEqual([phone, tv]);
    expect(rows[0]).toHaveProperty("runtime");
    expect(rows[0]).toHaveProperty("state", "Booted");
  });

  test("unknown simulator errors name its udid", async () => {
    const { process } = simulatorProcess();
    const result = await executeNative(["sim", "shutdown", "33333333-3333-3333-3333-333333333333", "--json"], {}, process);
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.value).refusal.message).toContain("33333333-3333-3333-3333-333333333333");
  });
});

describe("native build planning", () => {
  type BuildFixtureOptions = {
    readonly kind?: "phone" | "tv";
    readonly runtimes?: readonly { readonly platform: "iOS" | "tvOS"; readonly version: string }[];
    readonly devices: Readonly<Record<string, readonly { readonly udid: string; readonly state: string; readonly name: string; readonly isAvailable: boolean }[]>>;
    readonly args?: readonly string[];
    readonly configuredDevice?: string;
  };
  async function runNativeBuildFixture(options: BuildFixtureOptions) {
    const worktree = await mkdtemp(join(tmpdir(), "megabrain-native-build-"));
    const app = join(worktree, "apps", options.kind === "tv" ? "tv" : "phone");
    await mkdir(join(worktree, ".megabrain"), { recursive: true });
    await mkdir(join(app, "ios", "Example.xcworkspace"), { recursive: true });
    await writeFile(join(app, "app.json"), JSON.stringify({ expo: { scheme: "example", ios: { bundleIdentifier: "com.example.app" } } }));
    await writeFile(join(worktree, ".megabrain", "native.json"), JSON.stringify({ version: 1, surfaces: { [options.kind ?? "phone"]: { appPath: `apps/${options.kind === "tv" ? "tv" : "phone"}`, ...(options.configuredDevice ? { device: options.configuredDevice } : {}) } } }));
    const runtimes = options.runtimes ?? [{ platform: options.kind === "tv" ? "tvOS" : "iOS", version: "27.0" }];
    const runtimeData = { runtimes: runtimes.map(({ platform, version }) => ({ name: `${platform} ${version}`, version, buildversion: "A1", identifier: `com.apple.CoreSimulator.SimRuntime.${platform}-${version.replaceAll(".", "-")}`, isAvailable: true })) };
    const calls: Array<{ command: string; args: string[]; options?: Parameters<ProcessAdapter["run"]>[2] }> = [];
    const process: ProcessAdapter = {
      async run(command, args, runOptions) {
        calls.push({ command, args: [...args], ...(runOptions === undefined ? {} : { options: runOptions }) });
        if (command === "git") return ok({ stdout: `${worktree}\n`, stderr: "", exitCode: 0 });
        if (command === "xcrun" && args.join(" ") === "simctl list runtimes --json") return ok({ stdout: JSON.stringify(runtimeData), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args.join(" ") === "simctl list devices --json") return ok({ stdout: JSON.stringify({ devices: options.devices }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "boot") return ok({ stdout: "", stderr: "", exitCode: 0 });
        if (command === "pnpm" || command === "pod" || command === "xcodebuild") return ok({ stdout: "", stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[0] === "simctl") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    try {
      const result = await executeNative(["build", options.kind ?? "phone", ...(options.args ?? []), "--json"], { MEGABRAIN_NATIVE_WORKTREE: worktree, MEGABRAIN_STATE_DIR: join(worktree, "state") }, process);
      const xcode = calls.find((call) => call.command === "xcodebuild");
      return { result, xcodeArgs: xcode?.args, calls };
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  }

  test("uses the booted iPhone and excludes a booted Apple TV", async () => {
    const { result, xcodeArgs } = await runNativeBuildFixture({ devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "phone-1", state: "Booted", name: "iPhone 17", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [{ udid: "tv-1", state: "Booted", name: "Apple TV", isAvailable: true }],
    } });
    expect(result.kind).toBe("ok");
    expect(xcodeArgs).toContain("platform=iOS Simulator,id=phone-1");
  });

  test("prefers the only booted iPhone", async () => {
    const { xcodeArgs } = await runNativeBuildFixture({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "shutdown", state: "Shutdown", name: "iPhone 16", isAvailable: true },
      { udid: "booted", state: "Booted", name: "iPhone 17", isAvailable: true },
    ] } });
    expect(xcodeArgs).toContain("platform=iOS Simulator,id=booted");
  });

  test("refuses multiple unbooted iPhones with usable selectors and names", async () => {
    const { result, xcodeArgs } = await runNativeBuildFixture({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "a", state: "Shutdown", name: "iPhone 16", isAvailable: true },
      { udid: "b", state: "Shutdown", name: "iPhone 17", isAvailable: true },
    ] } });
    expect(xcodeArgs).toBeUndefined();
    const refusal = JSON.parse(result.value).refusal.message as string;
    expect(refusal).toContain("--device <name-or-udid>");
    expect(refusal).toContain("surfaces.phone.device");
    expect(refusal).toContain("iPhone 16");
    expect(refusal).toContain("iPhone 17");
  });

  test.each(["phone-2", "iPhone 17"]) ("selects an explicitly requested simulator by %s", async (requested) => {
    const { xcodeArgs } = await runNativeBuildFixture({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "phone-1", state: "Booted", name: "iPhone 16", isAvailable: true },
      { udid: "phone-2", state: "Shutdown", name: "iPhone 17", isAvailable: true },
    ] }, args: ["--device", requested] });
    expect(xcodeArgs).toContain("platform=iOS Simulator,id=phone-2");
  });

  test("uses the configured simulator and lets --device override it", async () => {
    const devices = { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "configured", state: "Shutdown", name: "iPhone 16", isAvailable: true },
      { udid: "override", state: "Shutdown", name: "iPhone 17", isAvailable: true },
    ] };
    const configured = await runNativeBuildFixture({ devices, configuredDevice: "configured" });
    expect(configured.xcodeArgs).toContain("platform=iOS Simulator,id=configured");
    const overridden = await runNativeBuildFixture({ devices, configuredDevice: "configured", args: ["--device", "override"] });
    expect(overridden.xcodeArgs).toContain("platform=iOS Simulator,id=override");
  });

  test("uses the runtime containing an explicitly selected simulator", async () => {
    const { result, xcodeArgs } = await runNativeBuildFixture({ runtimes: [{ platform: "iOS", version: "26.0" }, { platform: "iOS", version: "27.0" }], devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [{ udid: "older", state: "Shutdown", name: "iPhone 16", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "newer", state: "Booted", name: "iPhone 17", isAvailable: true }],
    }, args: ["--device", "older"] });
    expect(xcodeArgs).toContain("platform=iOS Simulator,id=older");
    expect(JSON.parse(result.value).runtime).toBe("26.0");
  });

  test("refuses an unknown simulator", async () => {
    const { result, xcodeArgs } = await runNativeBuildFixture({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "phone-1", state: "Booted", name: "iPhone 17", isAvailable: true },
    ] }, args: ["--device", "missing"] });
    expect(xcodeArgs).toBeUndefined();
    expect(JSON.parse(result.value).refusal.message).toContain("missing");
  });

  test("tv build never selects an iPhone", async () => {
    const { result, xcodeArgs } = await runNativeBuildFixture({ kind: "tv", devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "phone", state: "Booted", name: "iPhone 17", isAvailable: true }],
      "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [{ udid: "tv", state: "Booted", name: "Apple TV", isAvailable: true }],
    } });
    expect(result.kind).toBe("ok");
    expect(xcodeArgs).toContain("platform=tvOS Simulator,id=tv");
  });

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

  test("gives xcodebuild a deadline longer than the generic process limit", async () => {
    const { calls } = await runNativeBuildFixture({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [
      { udid: "phone", state: "Booted", name: "iPhone", isAvailable: true },
    ] } });
    const xcode = calls.find((call) => call.command === "xcodebuild");
    expect(xcode?.options?.timeoutMs).toBeGreaterThan(60_000);
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
  test.each([
    ["an ActivityIndicator-only source", "<XCUIElementTypeActivityIndicator label=\"Loading\"/>", "loading"],
    ["a source with no matching accessibility nodes", "<OtherElement/>", "loading"],
    ["a populated accessibility source", "<XCUIElementTypeWindow/><XCUIElementTypeButton/>", "rendered"],
  ] as const)("reaches a no-control-frame verdict for %s through a headless Appium session", async (_name, sourceTree, expectedStatus) => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-health-no-frame-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:45678/json/list")) return ok({ stdout: JSON.stringify([{ title: "com.example.app" }]), stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) return ok({ stdout: `${JSON.stringify({ value: { sessionId: "session-no-frame" } })}\n200`, stderr: "", exitCode: 0 });
        if (command === "curl" && args.some((arg) => arg.includes("/source"))) return ok({ stdout: `${sourceTree}\n200`, stderr: "", exitCode: 0 });
        if (command === "curl" && args[0] === "-fsS" && args[1] === "-X") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => calls.length,
    };

    try {
      const result = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one", "--metro-port", "45678", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      const health = JSON.parse(result.value) as { status: string; reason: string; process: { state: string }; metro: { state: string }; frame: { state: string } };
      expect(health.status).toBe(expectedStatus);
      expect(health.process.state).toBe("running");
      expect(health.metro.state).toBe("attached");
      expect(health.frame.state).toBe("unknown");
      expect(health.reason).toContain("frame was not checked");
      const sessionRequest = calls.find((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
      const capabilities = JSON.parse(sessionRequest?.args.at(-1) ?? "{}").capabilities.alwaysMatch;
      expect(capabilities["appium:isHeadless"]).toBe(true);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("requests a headless driver session", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-health-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) return ok({ stdout: `${JSON.stringify({ value: { sessionId: "session-1" } })}\n200`, stderr: "", exitCode: 0 });
        if (command === "curl" && args.some((arg) => arg.includes("/source"))) return ok({ stdout: "<XCUIElementTypeWindow/><XCUIElementTypeButton/>\n200", stderr: "", exitCode: 0 });
        if (command === "curl" && args[0] === "-fsS" && args[1] === "-X") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => calls.length,
    };

    try {
      const result = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      const sessionRequest = calls.find((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
      expect(sessionRequest).toBeDefined();
      const capabilities = JSON.parse(sessionRequest?.args.at(-1) ?? "{}").capabilities.alwaysMatch;
      expect(capabilities.platformName).toBe("iOS");
      expect(capabilities["appium:automationName"]).toBe("XCUITest");
      expect(capabilities["appium:isHeadless"]).toBe(true);
      expect(capabilities["appium:newCommandTimeout"]).toBe(60);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("requests a tvOS driver session for tv health", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-health-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "tvOS-1": [{ udid: "tv-one", state: "Booted", name: "Apple TV", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.tv", stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) return ok({ stdout: `${JSON.stringify({ value: { sessionId: "session-tv" } })}\n200`, stderr: "", exitCode: 0 });
        if (command === "curl" && args.some((arg) => arg.includes("/source"))) return ok({ stdout: "<XCUIElementTypeWindow/>\n200", stderr: "", exitCode: 0 });
        if (command === "curl" && args[0] === "-fsS" && args[1] === "-X") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => calls.length,
    };

    try {
      const result = await executeNative(["health", "tv", "--bundle-id", "com.example.tv", "--device", "tv-one"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      const sessionRequest = calls.find((call) => call.command === "curl" && call.args.includes("http://127.0.0.1:4723/session"));
      expect(sessionRequest).toBeDefined();
      expect(JSON.parse(sessionRequest?.args.at(-1) ?? "{}").capabilities.alwaysMatch.platformName).toBe("tvOS");
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("reports the server message when Appium rejects a session", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-health-"));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) return ok({ stdout: `${JSON.stringify({ value: { error: "invalid argument", message: "'automationName' is required to be present" } })}\n400`, stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => 0,
    };

    try {
      const result = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one", "--metro-port", "none", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.value).tree.reason).toContain("Appium server rejected session (HTTP 400): 'automationName' is required to be present");
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("distinguishes an unreachable Appium server from a rejected session", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-health-"));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) return failed("curl: (7) Failed to connect to 127.0.0.1 port 4723: Connection refused");
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => 0,
    };

    try {
      const result = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one", "--metro-port", "none", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      const reason = JSON.parse(result.value).tree.reason;
      expect(reason).toContain("Appium server was unreachable");
      expect(reason).not.toContain("automationName");
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("reports a failed source request after creating a session", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-health-"));
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "xcrun" && args[0] === "simctl" && args[1] === "list") return ok({ stdout: JSON.stringify({ devices: { "iOS-1": [{ udid: "one", state: "Booted", name: "Phone", isAvailable: true }] } }), stderr: "", exitCode: 0 });
        if (command === "xcrun" && args[1] === "spawn") return ok({ stdout: "com.example.app", stderr: "", exitCode: 0 });
        if (command === "curl" && args.includes("http://127.0.0.1:4723/session")) return ok({ stdout: `${JSON.stringify({ value: { sessionId: "session-1" } })}\n200`, stderr: "", exitCode: 0 });
        if (command === "curl" && args.some((arg) => arg.includes("/source"))) return ok({ stdout: `${JSON.stringify({ value: { error: "unknown error", message: "source endpoint failed" } })}\n500`, stderr: "", exitCode: 0 });
        if (command === "curl" && args[0] === "-fsS" && args[1] === "-X") return ok({ stdout: "", stderr: "", exitCode: 0 });
        return failed(`${command} unavailable`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => 0,
    };

    try {
      const result = await executeNative(["health", "phone", "--bundle-id", "com.example.app", "--device", "one", "--metro-port", "none", "--json"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      expect(JSON.parse(result.value).tree.reason).toContain("source endpoint failed");
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});

describe("native appium lifecycle", () => {
  test("starts detached, waits for port readiness, and leaves status up", async () => {
    const state = await mkdtemp(join(tmpdir(), "native-appium-"));
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

    try {
      const result = await executeNative(["appium", "start"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result).toEqual({ kind: "ok", value: "appium: up (port 4723, pid 1234)\n" });
      expect(calls).toEqual([
        `appium --port 4723 --log-level info --log ${join(state, "appium.log")}`,
        "curl -fsS --max-time 1 http://127.0.0.1:4723/status",
        "lsof -tiTCP:4723 -sTCP:LISTEN",
        "ps -p 1234 -o command=",
      ]);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("fails when the detached server never answers", async () => {
    const state = await mkdtemp(join(tmpdir(), "native-appium-"));
    const process: ProcessAdapter = {
      async run(command) {
        if (command === "curl") return failed("connection refused");
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return ok({ pid: 1234 }); },
      invocationCount: () => 0,
    };

    try {
      const result = await executeNative(["appium", "start"], { MEGABRAIN_STATE_DIR: state, MEGABRAIN_NATIVE_DEFAULT_TIMEOUT: "1" }, process);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toContain("appium did not start on port 4723");
    } finally {
      await rm(state, { recursive: true, force: true });
    }
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

describe("native sim screenshot", () => {
  const UDID = "401F3DA8-E4C1-48B7-9BB9-2C8416115E1A";
  const recording = (answer: (args: readonly string[]) => ReturnType<ProcessAdapter["run"]>) => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return answer(args);
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => calls.length,
    };
    return { calls, process };
  };

  test("captures the simulator's screen headlessly into the state directory", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-screenshot-"));
    const { calls, process } = recording(async () => ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      const result = await executeNative(["sim", "screenshot", UDID, "--json"], { MEGABRAIN_STATE_DIR: state }, process);
      expect(result.kind).toBe("ok");
      const path = join(state, "native", "screens", `${UDID}.png`);
      expect(result.kind === "ok" ? JSON.parse(result.value) : null).toEqual({ device: UDID, path, refusal: null });
      expect(calls).toEqual([{ command: "xcrun", args: ["simctl", "io", UDID, "screenshot", path] }]);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });

  test("refuses anything but a simulator udid without calling simctl", async () => {
    const { calls, process } = recording(async () => ok({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await executeNative(["sim", "screenshot", "../../etc"], { MEGABRAIN_STATE_DIR: "/nonexistent" }, process);
    expect(result.kind).toBe("failed");
    expect(calls).toEqual([]);
  });

  test("reports a simulator that is not booted", async () => {
    const state = await mkdtemp(join(tmpdir(), "megabrain-native-screenshot-"));
    const { process } = recording(async () => failed("xcrun exited with status 164"));
    try {
      const result = await executeNative(["sim", "screenshot", UDID, "--json"], { MEGABRAIN_STATE_DIR: state }, process);
      const refusal = (result.kind === "ok" ? JSON.parse(result.value) : null) as { refusal: { message: string } | null } | null;
      expect(refusal?.refusal?.message).toContain(UDID);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  });
});
