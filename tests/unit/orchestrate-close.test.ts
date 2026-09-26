import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDecision, closeOutput, hostCloseReason, parseCloseArgs } from "../../src/core/orchestrate-close.js";
import { executeOrchestrateClose } from "../../src/cli/commands/orchestrate-close.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

const meta = (values: Record<string, unknown> = {}) => ({ dispatchId: "d", state: "running", terminalState: "owned", runtime: "host", ...values });

describe("orchestrate close", () => {
  test("parses force-release and json", () => expect(parseCloseArgs(["d", "--force-release", "--json"])).toEqual({ kind: "ok", value: { dispatchId: "d", forceRelease: true, json: true } }));
  test("refuses the caller pane even with force-release", () => expect(closeDecision(meta({ runtime: "tmux", tmuxSession: "s", tmuxPane: "%1" }), { tmuxSession: "s", tmuxPane: "%1" }, true)).toEqual({ kind: "failed", error: "refusing to close dispatch d: target tmux pane %1 is the calling pane", exitCode: 1 }));
  test("refuses retained terminals without force and permits force", () => {
    expect(closeDecision(meta({ terminalState: "retained" }), {}, false)).toEqual({ kind: "ok", value: "retained" });
    expect(closeDecision(meta({ terminalState: "retained" }), {}, true)).toEqual({ kind: "ok", value: "close" });
  });
  test("recognizes duplicate closes", () => expect(closeDecision(meta({ state: "closed" }), {}, false)).toEqual({ kind: "ok", value: "duplicate" }));
  test("formats shared and host close output", () => {
    expect(closeOutput("d", false, "tmux", "orca", "shared-pane")).toBe("closed: d\ntmux pane removed; the shared tmux session and host terminal tab were kept.\n");
    expect(JSON.parse(closeOutput("d", true, "host", "orca", "unknown"))).toEqual({ dispatchId: "d", status: "closed" });
  });
  test("extracts and defaults host close reasons", () => {
    expect(hostCloseReason('{"error":{"message":"terminal close denied"}}')).toBe("terminal close denied");
    expect(hostCloseReason("\n\r")).toBe("the host gave no reason");
  });
});

// executeSpawn's tmux branch never calls host.create() for any tmux dispatch (shared-pane or
// exclusive) — there is never a host-terminal component to close. Before the tmux child-identity
// fix, a tmux dispatch's childHost/terminalId equalled the spawning caller's own identity, so
// closing the last pane of an "exclusive" tmux session (the common case: any tmux dispatch spawned
// by a non-tmux-hosted caller) "succeeded" only by that accident — closeHostTerminal resolved to
// the CALLER's own host terminal. With childHost correctly "tmux" now, that call would always fail
// (getHost("tmux") is undefined), breaking close outright unless the call is skipped for tmux.
describe("orchestrate close: exclusive tmux session (no host terminal component)", () => {
  function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = () => ok({ stdout: "", stderr: "", exitCode: 0 }), calls: { command: string; args: readonly string[] }[] = []): ProcessAdapter {
    return {
      async run(command, args) { calls.push({ command, args: [...args] }); return behavior(command, args); },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
  }

  test("closes an exclusive tmux dispatch spawned by a non-tmux-hosted coordinator", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-close-exclusive-`);
    try {
      const directory = join(root, "dispatches", "d1");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "meta.json"), JSON.stringify({
        dispatchId: "d1", parentSessionId: "coord-orca-term", parentHost: "orca",
        childHost: "tmux", terminalId: "tmux:megabrain-d1:%20", runtime: "tmux",
        tmuxSession: "megabrain-d1", tmuxPane: "%20", parentTmuxSession: null,
        state: "running", processState: "running", terminalState: "owned",
      }));
      const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term" };
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "list-panes" ? ok({ stdout: "%20\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await executeOrchestrateClose(["d1"], environment, process);
      expect(result.kind).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closes only a child pane in a wrapper-owned session", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-close-wrapper-session-`);
    const calls: { command: string; args: readonly string[] }[] = [];
    try {
      await mkdir(join(root, "dispatches", "d2"), { recursive: true });
      await writeFile(join(root, "dispatches", "d2", "meta.json"), JSON.stringify({
        dispatchId: "d2", parentSessionId: "coord-orca-term", parentHost: "orca", childHost: "tmux",
        terminalId: "tmux:wrapper-session:%2", runtime: "tmux", tmuxSession: "wrapper-session", tmuxPane: "%2",
        parentTmuxSession: null, tmuxSessionOwned: false, state: "running", processState: "running", terminalState: "owned",
      }));
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "list-panes"
        ? ok({ stdout: "%main\n%2\n", stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }), calls);
      const result = await executeOrchestrateClose(["d2"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term" }, process);
      expect(result.kind).toBe("ok");
      expect(calls.some((call) => call.command === "tmux" && call.args[0] === "kill-pane" && call.args.includes("%2"))).toBe(true);
      expect(calls.some((call) => call.command === "tmux" && call.args[0] === "kill-session")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("closes the empty Megabrain worktree session and its recorded Orca tab", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-close-owned-session-`);
    const calls: { command: string; args: readonly string[] }[] = [];
    try {
      await mkdir(join(root, "dispatches", "d3"), { recursive: true });
      await mkdir(join(root, "sessions"), { recursive: true });
      await writeFile(join(root, "dispatches", "d3", "meta.json"), JSON.stringify({
        dispatchId: "d3", parentSessionId: "coord-orca-term", parentHost: "orca", childHost: "tmux",
        terminalId: "tmux:megabrain-wt-tree-hash:%3", runtime: "tmux", tmuxSession: "megabrain-wt-tree-hash", tmuxPane: "%3",
        parentTmuxSession: null, tmuxSessionOwned: true, tmuxHostTerminalHost: "orca", tmuxHostTerminalId: "attach-tab",
        workspaceId: "workspace", state: "running", processState: "running", terminalState: "owned",
      }));
      await writeFile(join(root, "sessions", "megabrain-wt-tree-hash.json"), JSON.stringify({ tmuxSession: "megabrain-wt-tree-hash", megabrainOwned: true, hostTerminalId: "attach-tab", hostTerminalHost: "orca" }));
      let sessionAlive = true;
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%3\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "has-session") return sessionAlive ? ok({ stdout: "", stderr: "", exitCode: 0 }) : failed("no session", 1);
        if (command === "tmux" && args[0] === "kill-session") sessionAlive = false;
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      }, calls);
      const result = await executeOrchestrateClose(["d3"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term" }, process);
      expect(result.kind).toBe("ok");
      expect(calls.filter((call) => (call.command === "tmux" || call.command === "orca") && call.args[0] !== "capture-pane").map((call) => [call.command, call.args[0]])).toEqual([
        ["tmux", "has-session"], ["tmux", "list-panes"], ["tmux", "kill-session"], ["orca", "terminal"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves an unowned session instead of killing its final pane", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-close-unowned-session-`);
    const calls: { command: string; args: readonly string[] }[] = [];
    try {
      await mkdir(join(root, "dispatches", "d4"), { recursive: true });
      await writeFile(join(root, "dispatches", "d4", "meta.json"), JSON.stringify({
        dispatchId: "d4", parentSessionId: "coord-orca-term", parentHost: "orca", childHost: "tmux",
        terminalId: "tmux:wrapper-session:%4", runtime: "tmux", tmuxSession: "wrapper-session", tmuxPane: "%4",
        parentTmuxSession: null, tmuxSessionOwned: false, state: "running", processState: "running", terminalState: "owned",
      }));
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "list-panes"
        ? ok({ stdout: "%4\n", stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }), calls);
      const result = await executeOrchestrateClose(["d4"], { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term" }, process);
      expect(result.kind).toBe("failed");
      expect(calls.some((call) => call.command === "tmux" && ["kill-pane", "kill-session"].includes(String(call.args[0])))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
