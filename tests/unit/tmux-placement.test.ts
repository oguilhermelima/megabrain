import { describe, expect, test } from "bun:test";
import { decideTmuxPlacement } from "../../src/core/tmux-placement.js";

describe("tmux placement", () => {
  test("opens beside a caller in the same worktree even when its host resolves as orca and runtime is disabled", () => {
    expect(decideTmuxPlacement({ callerInTmux: true, sameWorktree: true, tmuxRuntimeSelected: false, existingSession: true })).toEqual({ kind: "caller-window" });
  });
});
