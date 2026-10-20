import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAdmissionPolicy } from "../../src/adapters/state-db.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { callStateOwner, startStateOwner, stopStateOwner, type StateOwner } from "../../src/db/state-owner.js";
import { processFor } from "./spawn-harness.js";

const directories: string[] = [];
const owners: StateOwner[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await stopStateOwner(owner);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("spawn admission lock contention", () => {
  test("fails promptly with JSON when admission is explicitly configured to fail", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-spawn-admission-contention-"));
    directories.push(stateDir);
    await writeAdmissionPolicy({ MEGABRAIN_STATE_DIR: stateDir }, { maxAgents: 4 });
    const owner = await startStateOwner(stateDir);
    owners.push(owner);
    expect(await callStateOwner(stateDir, { operation: "acquire-lease", key: "resource-admission", holder: "other-spawn", seconds: 300 })).toBe(true);
    const process = processFor();
    const startedAt = performance.now();
    const result = await executeSpawn(
      ["--worktree", stateDir, "--agent", "codex", "--prompt", "spawn", "--tmux", "true", "--admission", "fail", "--json"],
      { MEGABRAIN_STATE_DIR: stateDir }, process,
    );
    const elapsedMs = performance.now() - startedAt;
    expect(result.kind === "failed" ? result.error : "").toContain("resource admission is busy");
    expect(result.kind === "failed" ? JSON.parse(result.stdout ?? "{}") : null).toMatchObject({
      ok: false,
      code: "admission-busy",
      message: "resource admission is busy; retry the spawn",
      slot: "resource-admission",
    });
    expect(result.kind === "failed" ? JSON.parse(result.stdout ?? "{}") : null).not.toHaveProperty("details");
    expect(elapsedMs).toBeLessThan(500);
    expect(process.calls.some(({ command, args }) => command === "tmux" && ["new-session", "split-window"].includes(args[0] ?? ""))).toBe(false);
  });

  test("waits for a held admission lease by default", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-spawn-admission-wait-"));
    directories.push(stateDir);
    await writeAdmissionPolicy({ MEGABRAIN_STATE_DIR: stateDir }, { maxAgents: 4 });
    const owner = await startStateOwner(stateDir);
    owners.push(owner);
    expect(await callStateOwner(stateDir, { operation: "acquire-lease", key: "resource-admission", holder: "other-spawn", seconds: 300 })).toBe(true);

    const process = processFor();
    const startedAt = performance.now();
    const resultPromise = executeSpawn(
      ["--json"],
      { MEGABRAIN_STATE_DIR: stateDir }, process,
    );
    setTimeout(() => {
      void callStateOwner(stateDir, { operation: "release-lease", key: "resource-admission", holder: "other-spawn" });
    }, 50);
    const result = await resultPromise;
    const elapsedMs = performance.now() - startedAt;
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).not.toContain("resource admission is busy");
      expect(JSON.parse(result.stdout ?? "")).toMatchObject({ ok: false, code: "spawn-failed" });
    }
    expect(elapsedMs).toBeLessThan(5000);
  });

  test("reclaims a lease held by a dead spawn process across consecutive attempts", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-spawn-admission-stale-"));
    directories.push(stateDir);
    await writeAdmissionPolicy({ MEGABRAIN_STATE_DIR: stateDir }, { maxAgents: 4 });
    const owner = await startStateOwner(stateDir);
    owners.push(owner);
    expect(await callStateOwner(stateDir, {
      operation: "acquire-lease", key: "resource-admission", holder: "admission-999999999-stale", seconds: 300,
    })).toBe(true);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await executeSpawn(
        ["--worktree", stateDir, "--agent", "codex", "--prompt", "spawn", "--tmux", "true", "--json"],
        { MEGABRAIN_STATE_DIR: stateDir }, processFor(),
      );
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.error).not.toContain("resource admission is busy");
        expect(() => JSON.parse(result.stdout ?? "")).not.toThrow();
      }
    }
  });
});
