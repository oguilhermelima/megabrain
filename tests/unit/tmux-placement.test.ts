import { guardedStateDatabase } from "./state-db-guard.js";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { decideTmuxPlacement, tmuxWorktreeSessionName } from "../../src/core/tmux-placement.js";
import { deleteTmuxSession, getDispatch, getTmuxSession, listTmuxSessions, putTmuxSession } from "../../src/adapters/state-db.js";

describe("tmux placement", () => {
  test("lists, looks up, and deletes tmux sessions through the state facade", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-tmux-registry-`);
    try {
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (database.kind !== "ok") throw new Error(database.error);
      const handle = database.value;
      expect(putTmuxSession(handle, { tmuxSession: "z-session", workingDirectory: "/z" }, "$2").kind).toBe("ok");
      expect(putTmuxSession(handle, { tmuxSession: "a-session", workingDirectory: "/a" }, "$1").kind).toBe("ok");
      expect(getTmuxSession(handle, "a-session")).toMatchObject({ kind: "ok", value: { tmuxSession: "a-session" } });
      expect(listTmuxSessions(handle)).toMatchObject({ kind: "ok", value: [{ tmuxSession: "a-session" }, { tmuxSession: "z-session" }] });
      expect(deleteTmuxSession(handle, "z-session")).toEqual({ kind: "ok", value: true });
      expect(deleteTmuxSession(handle, "z-session")).toEqual({ kind: "ok", value: false });
      expect(listTmuxSessions(handle)).toMatchObject({ kind: "ok", value: [{ tmuxSession: "a-session" }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("opens beside a caller in the same worktree even when its host resolves as orca and runtime is disabled", () => {
    expect(decideTmuxPlacement({ callerInTmux: true, sameWorktree: true, tmuxRuntimeSelected: false, existingSession: true })).toEqual({ kind: "caller-window" });
  });

  test("selects a known worktree session before creating one", () => {
    expect(decideTmuxPlacement({ callerInTmux: false, sameWorktree: false, tmuxRuntimeSelected: true, existingSession: true })).toEqual({ kind: "existing-session" });
    expect(decideTmuxPlacement({ callerInTmux: false, sameWorktree: false, tmuxRuntimeSelected: true, existingSession: false })).toEqual({ kind: "worktree-session" });
    expect(decideTmuxPlacement({ callerInTmux: false, sameWorktree: false, tmuxRuntimeSelected: false, existingSession: false })).toEqual({ kind: "host" });
  });

  test("names worktree sessions stably and distinguishes paths that share a basename", () => {
    const first = tmuxWorktreeSessionName("/repo/feature/tree");
    expect(first).toBe(tmuxWorktreeSessionName("/repo/feature/tree"));
    expect(first).toMatch(/^megabrain-wt-tree-[a-f0-9]{12}$/);
    expect(tmuxWorktreeSessionName("/other/tree")).not.toBe(first);
  });

  test("splits the real caller pane when host identity resolves as orca", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-tmux-local-`);
    const calls: { command: string; args: readonly string[] }[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "tmux" && args[0] === "display-message" && args.at(-1) === "#{pane_current_path}") return ok({ stdout: `${root}\n`, stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "display-message" && args.at(-1) === "#{session_name}") return ok({ stdout: "caller-session\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "split-window") return ok({ stdout: "%child\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "list-panes" && String(args.at(-1)).includes("window_id")) return ok({ stdout: "%caller|@1|0|0|0|59|120\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%child\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "capture-pane") return ok({ stdout: "› Ask Codex to do anything\n", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    const original = getTmux();
    registerTmux({ ...original, sendText: async () => ok(undefined), sendKey: async () => ok(undefined) });
    try {
      const result = await executeSpawn(["--worktree", root, "--agent", "codex", "--prompt", "spawn"], {
        MEGABRAIN_STATE_DIR: `${root}/state`, MEGABRAIN_SESSION_ID: "orca-parent", ORCA_TERMINAL_HANDLE: "orca-terminal",
        TMUX: "isolated", TMUX_PANE: "%caller", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-orca-tmux", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, { resolveWorktree: async () => ok({ path: root, branch: "main", ownership: "existing", workspaceId: null }) });
      expect(result.kind).toBe("ok");
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: `${root}/state` });
      if (database.kind !== "ok") throw new Error(database.error);
      const stored = getDispatch(database.value, "dispatch-orca-tmux");
      if (stored.kind !== "ok" || stored.value === undefined) throw new Error("spawned dispatch missing from database");
      const meta = stored.value as Record<string, unknown>;
      expect(meta).toMatchObject({ runtime: "tmux", parentHost: "orca", tmuxSession: "caller-session", tmuxPane: "%child" });
      expect(calls.some((call) => call.command === "tmux" && call.args[0] === "split-window" && call.args.includes("%caller"))).toBe(true);
      expect(calls.some((call) => call.command === "orca" && call.args[1] === "create")).toBe(false);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("opens an Orca attach tab when reusing an existing wrapper session", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-tmux-wrapper-reuse-`);
    const state = `${root}/state`;
    const calls: { command: string; args: readonly string[] }[] = [];
    const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: state });
    if (database.kind !== "ok") throw new Error(database.error);
    putTmuxSession(database.value, { tmuxSession: "wrapper-session", workingDirectory: "/work/tree", tmuxPane: "%main", role: "main" }, "$1");
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (command === "tmux" && args[0] === "list-panes" && String(args.at(-1)).includes("window_id")) return ok({ stdout: "%main|@1|0|0|0|59|120\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%main\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "split-window") return ok({ stdout: "%child\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "capture-pane") return ok({ stdout: "› Ask Codex to do anything\n", stderr: "", exitCode: 0 });
        if (command === "orca" && args[1] === "create") return ok({ stdout: JSON.stringify({ handle: "wrapper-attach-tab" }), stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };
    const original = getTmux();
    registerTmux({ ...original, sendText: async () => ok(undefined), sendKey: async () => ok(undefined), capturePane: async () => ok("› Ask Codex to do anything") });
    try {
      const result = await executeSpawn(["--worktree", "/work/tree", "--agent", "codex", "--prompt", "spawn", "--tmux", "true"], {
        MEGABRAIN_STATE_DIR: state, ORCA_TERMINAL_HANDLE: "orca-parent", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-wrapper-reuse", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      }, process, { resolveWorktree: async () => ok({ path: "/work/tree", branch: "main", ownership: "existing", workspaceId: null }) });
      expect(result.kind).toBe("ok");
      const stored = getDispatch(database.value, "dispatch-wrapper-reuse");
      if (stored.kind !== "ok" || stored.value === undefined) throw new Error("spawned dispatch missing from database");
      const meta = stored.value as Record<string, unknown>;
      expect(meta).toMatchObject({ tmuxSession: "wrapper-session", tmuxSessionOwned: false, tmuxHostTerminalId: "wrapper-attach-tab", tmuxHostTerminalHost: "orca" });
      expect(calls.some((call) => call.command === "orca" && call.args.includes("tmux attach -t 'wrapper-session'"))).toBe(true);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
