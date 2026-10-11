import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { executeTerminalLifecycle } from "../../src/cli/commands/terminal-lifecycle.js";
import { executeTerminalList } from "../../src/cli/commands/terminal-list.js";

// Outside Orca and Superset a terminal is a tmux window: create, list, close and restart all work
// on the same stored record, and none of them mention a host the operator does not run.

type Call = Readonly<{ command: string; args: readonly string[] }>;
const output = (stdout: string): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode: 0 });

function fakeProcess(worktree: string, panes: { current: string }): ProcessAdapter & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "git") return output(`${worktree}\n`);
      if (command === "tmux" && args[0] === "new-session") return output("%7 4242\n");
      if (command === "tmux" && args[0] === "new-window") return output("%9 777\n");
      if (command === "tmux" && args[0] === "display-message") return output("work\n");
      if (command === "tmux" && args[0] === "list-panes") return output(panes.current);
      if (command === "tmux") return output("");
      if (command === "kill" || command === "ps") return output("");
      return failed(`unexpected call: ${command} ${args.join(" ")}`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

async function setup(): Promise<{ worktree: string; stateDir: string; panes: { current: string } }> {
  return { worktree: await mkdtemp(`${tmpdir()}/megabrain-tt-worktree-`), stateDir: await mkdtemp(`${tmpdir()}/megabrain-tt-state-`), panes: { current: "" } };
}

describe("terminal create with no Orca or Superset", () => {
  test("opens a detached session and tells the operator how to attach", async () => {
    const { worktree, stateDir, panes } = await setup();
    const process = fakeProcess(worktree, panes);
    const result = await executeTerminalLifecycle(["create", "--worktree", worktree, "--command", "node app.js", "--json"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const created = JSON.parse(result.value);
    expect(created).toMatchObject({ host: "tmux", pid: 4242 });
    expect(created.terminalId).toMatch(/^[^:]+:%7$/);
    expect(created.attach).toBe(`tmux attach -t ${created.terminalId.split(":")[0]}`);
    expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "new-session" && call.args.includes("-d"))).toBe(true);
    expect(process.calls.some((call) => call.command === "orca" || call.command === "superset")).toBe(false);
  });

  test("inside tmux it opens a window in the caller's session instead", async () => {
    const { worktree, stateDir, panes } = await setup();
    const process = fakeProcess(worktree, panes);
    const result = await executeTerminalLifecycle(["create", "--worktree", worktree, "--command", "node app.js", "--json"], { MEGABRAIN_STATE_DIR: stateDir, TMUX: "x", TMUX_PANE: "%3" }, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(result.value)).toMatchObject({ host: "tmux", terminalId: "work:%9", pid: 777 });
    expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "new-window")).toBe(true);
    expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "new-session")).toBe(false);
  });

  test("a failing tmux names tmux, never Orca or Superset", async () => {
    const { worktree, stateDir } = await setup();
    const process: ProcessAdapter = {
      async run(command) { return command === "git" ? output(`${worktree}\n`) : failed("tmux: command not found"); },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
    const result = await executeTerminalLifecycle(["create", "--worktree", worktree, "--command", "node app.js"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error).toContain("tmux");
      expect(result.error).not.toMatch(/Orca|Superset/);
    }
  });
});

describe("tmux terminals after create", () => {
  async function created() {
    const context = await setup();
    const env = { MEGABRAIN_STATE_DIR: context.stateDir, TMUX: "x", TMUX_PANE: "%3" };
    const process = fakeProcess(context.worktree, context.panes);
    const result = await executeTerminalLifecycle(["create", "--worktree", context.worktree, "--command", "node app.js", "--json"], env, process);
    if (result.kind !== "ok") throw new Error("create failed");
    return { ...context, env, process };
  }

  test("list marks a live pane alive and a vanished pane stale", async () => {
    const { env, process, panes } = await created();
    panes.current = "work:%9 777\n";
    const alive = await executeTerminalList(["--json"], env, process);
    expect(alive.kind === "ok" ? JSON.parse(alive.value)[0].status : "").toBe("alive");
    panes.current = "";
    const stale = await executeTerminalList(["--json"], env, process);
    expect(stale.kind === "ok" ? JSON.parse(stale.value)[0].status : "").toBe("stale");
  });

  test("close kills the pane and drops the record", async () => {
    const { env, process, panes } = await created();
    panes.current = "work:%9 777\n";
    const closed = await executeTerminalLifecycle(["close", "id:work:%9", "--json"], env, process);
    expect(closed.kind).toBe("ok");
    expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "kill-pane" && call.args.includes("%9"))).toBe(true);
    const listed = await executeTerminalList(["--json"], env, process);
    expect(listed.kind === "ok" ? JSON.parse(listed.value) : undefined).toEqual([]);
  });

  test("restart replaces the pane and keeps one record", async () => {
    const { env, process, panes } = await created();
    panes.current = "work:%9 777\n";
    const restarted = await executeTerminalLifecycle(["restart", "id:work:%9", "--json"], env, process);
    expect(restarted.kind).toBe("ok");
    expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "kill-pane")).toBe(true);
    expect(process.calls.filter((call) => call.command === "tmux" && call.args[0] === "new-window").length).toBe(2);
    const listed = await executeTerminalList(["--json"], env, process);
    expect(listed.kind === "ok" ? JSON.parse(listed.value).length : -1).toBe(1);
  });
});
