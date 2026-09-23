import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeChildAck } from "../../src/cli/commands/child-ack.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = () => ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter {
  return {
    async run(command, args) { return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-child-ack-`);
  try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function writeDispatch(root: string, dispatchId: string, meta: Record<string, unknown>): Promise<void> {
  const directory = join(root, "dispatches", dispatchId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "meta.json"), JSON.stringify({ dispatchId, ...meta }));
}

// child-ack.ts's own findChild/matches() had the same self-attribution gap findChild
// (queue-write.ts) used to have: a runtime tmux record could still match by terminalId/childHost
// for a non-tmux-hosted caller, including a legacy record carrying that caller's own identity
// from before orchestrate-spawn.ts recorded a tmux child's own identity there.
describe("executeChildAck: tmux-runtime records", () => {
  test("does not match a legacy tmux dispatch by terminalId, even one carrying the caller's own id", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "legacy-tmux", {
        runtime: "tmux", terminalId: "coord-orca-term", childHost: "orca",
        tmuxSession: "dispatch-session", tmuxPane: "%5",
      });
      const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term" };
      const result = await executeChildAck(["delivery-1"], environment, fakeProcess());
      expect(result).toEqual({ kind: "failed", error: "no managed dispatch belongs to orca/coord-orca-term", exitCode: 1 });
    });
  });

  test("still finds the real child by tmuxSession and tmuxPane", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "real-child", {
        runtime: "tmux", terminalId: "coord-orca-term", childHost: "orca",
        tmuxSession: "dispatch-session", tmuxPane: "%5",
      });
      const environment = { MEGABRAIN_STATE_DIR: root, TMUX: "some-server", TMUX_PANE: "%5" };
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message" ? ok({ stdout: "dispatch-session\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
      // No delivery on disk, so this still fails — but past the "find my own dispatch" step: the
      // failure is about the delivery, not "no managed dispatch belongs to".
      const result = await executeChildAck(["delivery-1"], environment, process);
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.error).toBe("delivery delivery-1 refused: delivery is unknown");
    });
  });

  test("host-runtime dispatches are unaffected: terminalId/childHost matching still works", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "host-child", { runtime: "host", terminalId: "child-orca-term", childHost: "orca" });
      const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "child-orca-term" };
      const result = await executeChildAck(["delivery-1"], environment, fakeProcess());
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.error).toBe("delivery delivery-1 refused: delivery is unknown");
    });
  });
});
