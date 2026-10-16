import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok } from "../../src/core/result.js";
import { executeSpawn, type SpawnDependencies } from "../../src/cli/commands/orchestrate-spawn.js";
import { tmuxWorktreeSessionName } from "../../src/core/tmux-placement.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { createDispatch, getDispatch, listTmuxSessions } from "../../src/adapters/state-db.js";
import { guardedStateDatabase } from "./state-db-guard.js";
import { existingWorktree, processFor, spawnEnvironment } from "./spawn-harness.js";

const dependencies: SpawnDependencies = { resolveWorktree: async () => ok(existingWorktree) };
const args = ["--worktree", "/work/tree", "--agent", "codex", "--prompt", "fail", "--tmux", "true"];

function registeredSessions(root: string): readonly string[] {
  const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (database.kind !== "ok") throw new Error(database.error);
  const listed = listTmuxSessions(database.value);
  if (listed.kind !== "ok") throw new Error(listed.error);
  return listed.value.map((record) => String(record.tmuxSession));
}

describe("a failed spawn leaves no ghost row", () => {
  test("the tmux session row of a session the spawn created and killed is removed", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-ghost-`);
    const process = processFor();
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", sendText: async () => failed("launch failed"), sendKey: async () => ok(undefined) });
    try {
      const result = await executeSpawn(args, spawnEnvironment(root, "dispatch-ghost-launch"), process, dependencies);
      expect(result.kind).toBe("failed");
      expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "kill-session")).toBe(true);
      expect(registeredSessions(root)).not.toContain(tmuxWorktreeSessionName("/work/tree"));
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (database.kind !== "ok") throw new Error(database.error);
      const record = getDispatch(database.value, "dispatch-ghost-launch");
      expect(record.kind === "ok" ? record.value?.state : undefined).toBe("failed");
      expect(record.kind === "ok" ? String(record.value?.reason ?? "") : "").not.toBe("");
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a spawn that cannot record its dispatch kills what it opened and removes the session row", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-spawn-ghost-`);
    const process = processFor();
    const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (database.kind !== "ok") throw new Error(database.error);
    // The id is already taken by a settled dispatch, so createDispatch refuses after the pane exists.
    const seeded = createDispatch(database.value, { dispatchId: "dispatch-ghost-taken", state: "done", agent: "codex" });
    if (seeded.kind !== "ok") throw new Error(seeded.error);
    try {
      const result = await executeSpawn(args, spawnEnvironment(root, "dispatch-ghost-taken"), process, dependencies);
      expect(result.kind).toBe("failed");
      expect(process.calls.some((call) => call.command === "tmux" && (call.args[0] === "kill-session" || call.args[0] === "kill-pane"))).toBe(true);
      expect(registeredSessions(root)).not.toContain(tmuxWorktreeSessionName("/work/tree"));
      const record = getDispatch(database.value, "dispatch-ghost-taken");
      expect(record.kind === "ok" ? record.value?.state : undefined).toBe("done");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
