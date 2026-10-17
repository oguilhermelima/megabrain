import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNative } from "../../src/cli/commands/native.js";
import { executeSettings } from "../../src/cli/commands/settings.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import type { Clock } from "../../src/core/clock.js";
import { failed, ok } from "../../src/core/result.js";

const MINUTE = 60_000;
const OURS = "AAAAAAAA-0000-4000-8000-000000000001";
const FOREIGN = "BBBBBBBB-0000-4000-8000-000000000002";

let state: string;
let now: number;
let states: Record<string, string>;
let calls: string[][];

const clock = (): Clock => ({ now: () => now, setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>) });
const environment = () => ({ MEGABRAIN_STATE_DIR: state, MEGABRAIN_NATIVE_WORKTREE: state });

// A fake simctl: it lists the current states and changes them on boot and shutdown, so nothing real boots.
function simctl(): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "git") return ok({ stdout: `${state}\n`, stderr: "", exitCode: 0 });
      if (command !== "xcrun" || args[0] !== "simctl") return failed(`${command} unavailable`);
      calls.push([...args]);
      if (args[1] === "list") {
        const devices = Object.entries(states).map(([udid, deviceState]) => ({ udid, state: deviceState, name: `Phone ${udid.slice(0, 2)}`, isAvailable: true }));
        return ok({ stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": devices } }), stderr: "", exitCode: 0 });
      }
      const udid = args[2] ?? "";
      if (args[1] === "boot") states[udid] = "Booted";
      if (args[1] === "shutdown") states[udid] = "Shutdown";
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const run = (...args: string[]) => executeNative(args, environment(), simctl(), clock());
const shutdowns = () => calls.filter((call) => call[1] === "shutdown").map((call) => call[2]);
async function idle(...args: string[]) {
  const result = await run("sim", "idle", "--json", ...args);
  if (result.kind !== "ok") throw new Error(`idle failed: ${JSON.stringify(result)}`);
  return JSON.parse(result.value) as { minutes: number; devices: Array<{ udid: string; bootedAt: string; sleepsAt: string | null; running: boolean }>; asleep: string[]; slept?: string[] };
}

beforeEach(async () => {
  state = await mkdtemp(join(tmpdir(), "megabrain-idle-"));
  now = Date.parse("2026-10-16T10:00:00Z");
  states = { [OURS]: "Shutdown", [FOREIGN]: "Booted" };
  calls = [];
});
afterEach(async () => { await rm(state, { recursive: true, force: true }); });

describe("who booted a simulator", () => {
  test("ensure records a simulator it booted", async () => {
    expect((await run("sim", "ensure", "phone", "--device", OURS, "--json")).kind).toBe("ok");
    const report = await idle();
    expect(report.devices.map((device) => device.udid)).toEqual([OURS]);
    expect(report.devices[0]?.sleepsAt).toBe(new Date(now + 10 * MINUTE).toISOString());
  });

  test("ensure does not record a simulator that was already booted", async () => {
    expect((await run("sim", "ensure", "phone", "--device", FOREIGN, "--json")).kind).toBe("ok");
    expect((await idle()).devices).toEqual([]);
  });
});

describe("the idle timer", () => {
  beforeEach(async () => { await run("sim", "ensure", "phone", "--device", OURS, "--json"); });

  test("a sweep before the timer ends shuts nothing down", async () => {
    now += 9 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([]);
    expect(shutdowns()).toEqual([]);
  });

  test("a sweep after it shuts the simulator down and remembers it asleep", async () => {
    now += 10 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([OURS]);
    expect(shutdowns()).toEqual([OURS]);
    const report = await idle();
    expect(report.devices).toEqual([]);
    expect(report.asleep).toEqual([OURS]);
  });

  test("a visible Device tab pushes the timer back", async () => {
    now += 9 * MINUTE;
    await idle("--touch");
    now += 9 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([]);
    now += 2 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([OURS]);
  });

  test("a Maestro run on the simulator keeps it awake", async () => {
    const directory = join(state, "maestro", "abc", "run-1");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "run.json"), JSON.stringify({ runId: "run-1", flow: "f.yaml", worktree: state, device: OURS, pid: process.pid, state: "running", startedAt: new Date(now).toISOString() }));
    now += 60 * MINUTE;
    const report = await idle("--sweep");
    expect(report.slept).toEqual([]);
    expect(shutdowns()).toEqual([]);
  });

  test("zero minutes turns sleeping off", async () => {
    expect((await executeSettings(["set", "device-idle-minutes", '{"version":1,"minutes":0}'], environment(), simctl())).kind).toBe("ok");
    now += 600 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([]);
  });

  test("the setting changes how long it waits", async () => {
    expect((await executeSettings(["set", "device-idle-minutes", '{"version":1,"minutes":3}'], environment(), simctl())).kind).toBe("ok");
    now += 3 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([OURS]);
  });

  test("leaving the app sleeps everything megabrain booted at once, never a foreign simulator", async () => {
    await run("sim", "ensure", "phone", "--device", FOREIGN, "--json");
    const report = await idle("--sweep", "--all");
    expect(report.slept).toEqual([OURS]);
    expect(shutdowns()).toEqual([OURS]);
    expect(states[FOREIGN]).toBe("Booted");
  });

  test("a simulator the person shut down by hand is forgotten, not shut down again", async () => {
    states[OURS] = "Shutdown";
    now += 10 * MINUTE;
    expect((await idle("--sweep")).slept).toEqual([]);
    expect(shutdowns()).toEqual([]);
    expect((await idle()).devices).toEqual([]);
  });

  test("booting again clears the asleep mark", async () => {
    now += 10 * MINUTE;
    await idle("--sweep");
    await run("sim", "ensure", "phone", "--device", OURS, "--json");
    const report = await idle();
    expect(report.asleep).toEqual([]);
    expect(report.devices.map((device) => device.udid)).toEqual([OURS]);
  });
});

describe("the device-idle-minutes setting", () => {
  test("defaults to 10 and rejects a negative or non-integer value", async () => {
    const read = await executeSettings(["get", "device-idle-minutes"], environment(), simctl());
    expect(read.kind === "ok" ? JSON.parse(read.value) : null).toEqual({ version: 1, minutes: 10 });
    for (const bad of ['{"version":1,"minutes":-1}', '{"version":1,"minutes":2.5}']) {
      expect((await executeSettings(["set", "device-idle-minutes", bad], environment(), simctl())).kind).toBe("failed");
    }
  });
});
