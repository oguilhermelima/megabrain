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
  test("fails promptly before creating a terminal when another spawn owns admission", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "megabrain-spawn-admission-contention-"));
    directories.push(stateDir);
    await writeAdmissionPolicy({ MEGABRAIN_STATE_DIR: stateDir }, { maxAgents: 4 });
    const owner = await startStateOwner(stateDir);
    owners.push(owner);
    expect(await callStateOwner(stateDir, { operation: "acquire-lease", key: "resource-admission", holder: "other-spawn", seconds: 300 })).toBe(true);
    const process = processFor();
    const startedAt = performance.now();
    const result = await executeSpawn(
      ["--worktree", stateDir, "--agent", "codex", "--prompt", "spawn", "--tmux", "true"],
      { MEGABRAIN_STATE_DIR: stateDir }, process,
    );
    const elapsedMs = performance.now() - startedAt;
    expect(result.kind === "failed" ? result.error : "").toContain("resource admission is busy");
    expect(elapsedMs).toBeLessThan(500);
    expect(process.calls.some(({ command, args }) => command === "tmux" && ["new-session", "split-window"].includes(args[0] ?? ""))).toBe(false);
  });
});
