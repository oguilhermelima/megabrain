import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { openDatabase } from "../../src/db/db.js";
import { registerRepository } from "../../src/db/queries/repositories.js";
import { executeNative } from "../../src/cli/commands/native.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import type { Clock } from "../../src/core/clock.js";
import { failed, ok } from "../../src/core/result.js";

const UDID = "AAAAAAAA-0000-4000-8000-000000000001";
let stateDir: string;
let states: Record<string, string>;
let calls: string[][];
let project: string;
let worktree: string;
let currentRoot: string | null;
const clock: Clock = { now: () => Date.parse("2026-10-17T12:00:00.000Z"), setTimeout, clearTimeout };
const environment = () => ({ MEGABRAIN_STATE_DIR: stateDir, MEGABRAIN_NATIVE_WORKTREE: project });

function processAdapter(): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "git") {
        if (args.includes("worktree")) return ok({ stdout: `worktree ${project}\nbranch refs/heads/main\n\nworktree ${worktree}\nbranch refs/heads/fix/test\n`, stderr: "", exitCode: 0 });
        if (currentRoot === null) return failed("not a git repository");
        const explicitAt = args.indexOf("-C");
        return ok({ stdout: `${explicitAt >= 0 ? args[explicitAt + 1] : currentRoot}\n`, stderr: "", exitCode: 0 });
      }
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
  project = join(stateDir, "project");
  worktree = join(stateDir, "worktree");
  await mkdir(project, { recursive: true });
  await mkdir(worktree, { recursive: true });
  currentRoot = worktree;
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: stateDir });
  if (opened.kind !== "ok") throw new Error(opened.error);
  try { registerRepository(opened.value.db, { name: "project", path: project, remote: null, source: "megabrain", addedAt: "2026-10-17T12:00:00.000Z" }); }
  finally { opened.value.close(); }
  states = { [UDID]: "Booted" };
  calls = [];
});
afterEach(async () => { await rm(stateDir, { recursive: true, force: true }); });

describe("simulator worktree ownership", () => {
  test("claim records the worktree and release clears it", async () => {
    expect(await json("sim", "claim", UDID, "--worktree", worktree)).toMatchObject({ udid: UDID, worktree });
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(worktree);
    expect(await json("sim", "release", UDID)).toMatchObject({ udid: UDID, worktree: null });
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBeNull();
  });

  test("ensure records the selected simulator when a worktree is supplied", async () => {
    states[UDID] = "Shutdown";
    expect(await json("sim", "ensure", "phone", "--device", UDID, "--worktree", worktree)).toMatchObject({ device: UDID, state: "Booted" });
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(worktree);
    expect((await json("sim", "list", "--booted")).devices[0].project).toBe(project);
  });

  test("ensure records the current registered worktree when no owner exists", async () => {
    states[UDID] = "Shutdown";
    await json("sim", "ensure", "phone", "--device", UDID);
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(worktree);
  });

  test("ensure outside a registered project leaves the simulator unowned", async () => {
    currentRoot = null;
    states[UDID] = "Shutdown";
    await json("sim", "ensure", "phone", "--device", UDID);
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBeNull();
  });

  test("ensure preserves a different owner and reports it", async () => {
    const different = join(stateDir, "other");
    await json("sim", "claim", UDID, "--worktree", different);
    states[UDID] = "Shutdown";
    const result = await run("sim", "ensure", "phone", "--device", UDID);
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(different);
    expect(result.kind === "ok" ? result.value : "").toContain(different);
  });

  test("shutdown clears ownership and list drops owners for devices shut down elsewhere", async () => {
    await json("sim", "claim", UDID, "--worktree", worktree);
    expect(await json("sim", "shutdown", UDID)).toMatchObject({ udid: UDID, state: "Shutdown" });
    expect((await json("sim", "list", "--booted")).devices).toEqual([]);

    states[UDID] = "Booted";
    await json("sim", "claim", UDID, "--worktree", worktree);
    states[UDID] = "Shutdown";
    expect((await json("sim", "list", "--booted")).devices).toEqual([]);
    states[UDID] = "Booted";
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBeNull();
  });

  test("megabrain-slept devices keep their owner while manually shut down devices lose it", async () => {
    await json("sim", "claim", UDID, "--worktree", worktree);
    states[UDID] = "Shutdown";
    await mkdir(join(stateDir, "native"), { recursive: true });
    await writeFile(join(stateDir, "native", "booted.json"), JSON.stringify({ version: 1, booted: {}, asleep: [UDID], seenAt: null }));
    expect((await json("sim", "list", "--booted")).devices).toEqual([]);
    states[UDID] = "Booted";
    expect((await json("sim", "list", "--booted")).devices[0].worktree).toBe(worktree);
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
