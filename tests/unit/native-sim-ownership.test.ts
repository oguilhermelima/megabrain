import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeNative } from "../../src/cli/commands/native.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import type { Clock } from "../../src/core/clock.js";
import { failed, ok } from "../../src/core/result.js";

const UDID = "AAAAAAAA-0000-4000-8000-000000000001";
const WORKTREE = "/work/project";
let stateDir: string;
let states: Record<string, string>;
let calls: string[][];
const clock: Clock = { now: () => Date.parse("2026-10-17T12:00:00.000Z"), setTimeout, clearTimeout };
const environment = () => ({ MEGABRAIN_STATE_DIR: stateDir, MEGABRAIN_NATIVE_WORKTREE: WORKTREE });

function processAdapter(): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "git") return ok({ stdout: `${WORKTREE}\n`, stderr: "", exitCode: 0 });
      if (command !== "xcrun" || args[0] !== "simctl") return failed(`${command} unavailable`);
      calls.push([...args]);
      if (args[1] === "list") {
        const devices = Object.entries(states).map(([udid, state]) => ({ udid, state, name: "iPhone Test", isAvailable: true }));
        return ok({ stdout: JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": devices } }), stderr: "", exitCode: 0 });
      }
      if (args[1] === "boot") states[args[2]!] = "Booted";
      if (args[1] === "shutdown") states[args[2]!] = "Shutdown";
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const run = (...args: string[]) => executeNative(args, environment(), processAdapter(), clock);
const json = async (...args: string[]) => {
  const result = await run(...args, "--json");
  return result.kind === "ok" ? JSON.parse(result.value) : result;
};

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "megabrain-sim-owner-"));
  states = { [UDID]: "Booted" };
  calls = [];
});
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

describe("simulator worktree ownership", () => {
  test("claim records the worktree and release clears it", async () => {
    expect(await json("sim", "claim", UDID, "--worktree", WORKTREE)).toMatchObject({ udid: UDID, worktree: WORKTREE });
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(WORKTREE);
    expect(await json("sim", "release", UDID)).toMatchObject({ udid: UDID, worktree: null });
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBeNull();
  });

  test("ensure records the selected simulator when a worktree is supplied", async () => {
    states[UDID] = "Shutdown";
    expect(await json("sim", "ensure", "phone", "--device", UDID, "--worktree", WORKTREE)).toMatchObject({ device: UDID, state: "Booted" });
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(WORKTREE);
  });

  test("shutdown clears ownership and list drops owners for devices shut down elsewhere", async () => {
    await json("sim", "claim", UDID, "--worktree", WORKTREE);
    expect(await json("sim", "shutdown", UDID)).toMatchObject({ udid: UDID, state: "Shutdown" });
    expect((await json("sim", "list", "--booted")).devices).toEqual([]);

    states[UDID] = "Booted";
    await json("sim", "claim", UDID, "--worktree", WORKTREE);
    states[UDID] = "Shutdown";
    expect((await json("sim", "list", "--booted")).devices).toEqual([]);
    states[UDID] = "Booted";
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBeNull();
  });
});

describe("simulator rename", () => {
  test("renames a simulator through simctl", async () => {
    expect(await json("sim", "rename", UDID, "My iPhone")).toMatchObject({ udid: UDID, name: "My iPhone" });
    expect(calls).toContainEqual(["simctl", "rename", UDID, "My iPhone"]);
  });

  test("refuses empty and overlong names without calling simctl", async () => {
    const before = calls.length;
    expect((await run("sim", "rename", UDID, "")).kind).toBe("failed");
    expect((await run("sim", "rename", UDID, "x".repeat(256))).kind).toBe("failed");
    expect(calls).toHaveLength(before);
  });
});
