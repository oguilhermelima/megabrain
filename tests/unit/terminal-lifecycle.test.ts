import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTerminalSelector, type TerminalLifecycleRecord } from "../../src/core/terminal-lifecycle.js";
import { executeTerminalLifecycle } from "../../src/cli/commands/terminal-lifecycle.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput>): ProcessAdapter {
  return {
    async run(command, args) { return behavior(command, args); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

const records: TerminalLifecycleRecord[] = [
  { terminalId: "one", host: "superset", workspaceId: "ws", worktree: "/work/one", title: "DEV one", command: "run one", createdAt: "now", pid: 10, rootPid: 10, port: 3000 },
  { terminalId: "two", host: "orca", workspaceId: null, worktree: "/work/two", title: "DEV two", command: "run two", createdAt: "now", pid: 20, rootPid: 20, port: null },
];

describe("terminal selector resolution", () => {
  test("resolves every supported selector against managed records", () => {
    expect(resolveTerminalSelector(records, "id:one")?.terminalId).toBe("one");
    expect(resolveTerminalSelector(records, "title:DEV two")?.terminalId).toBe("two");
    expect(resolveTerminalSelector(records, "port:3000")?.terminalId).toBe("one");
    expect(resolveTerminalSelector(records, "worktree:/work/two")?.terminalId).toBe("two");
  });

  test("returns no match for malformed, missing, and foreign selectors", () => {
    expect(resolveTerminalSelector(records, "id:missing")).toBeUndefined();
    expect(resolveTerminalSelector(records, "port:9000")).toBeUndefined();
    expect(resolveTerminalSelector(records, "name:one")).toBeUndefined();
    expect(resolveTerminalSelector(records, "id:")).toBeUndefined();
  });

  test("keeps shell contract of selecting the first ambiguous record", () => {
    const ambiguous = [...records, { ...records[0], terminalId: "three" }];
    expect(resolveTerminalSelector(ambiguous, "title:DEV one")?.terminalId).toBe("one");
  });
});

describe("terminal create reads the Orca handle, not the request id", () => {
  test("records the terminal's own handle when orca terminal create --json also carries a top-level request id", async () => {
    const worktreePath = await mktemp();
    const process = fakeProcess((command, args) => {
      if (command === "git" && args.includes("rev-parse")) return ok({ stdout: `${worktreePath}\n`, stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "list") return ok({ stdout: JSON.stringify({ result: { terminals: [{ handle: "probe-parent" }] } }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "create") {
        return ok({
          stdout: JSON.stringify({ ok: true, id: "req-b19b1e0b-0000-0000-0000-000000000000", result: { terminal: { handle: "orca-handle-1", pid: 4242 } } }),
          stderr: "",
          exitCode: 0,
        });
      }
      return failed(`unexpected call: ${command} ${args.join(" ")}`);
    });
    const stateDir = await mktemp();
    const result = await executeTerminalLifecycle(
      ["create", "--worktree", worktreePath, "--command", "node app.js", "--json"],
      { MEGABRAIN_STATE_DIR: stateDir, MEGABRAIN_SESSION_HOST: "orca" },
      process,
    );
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const parsed = JSON.parse(result.value) as { terminalId: string };
    expect(parsed.terminalId).toBe("orca-handle-1");
  });

  test("creates from an Orca-backed tmux child when Orca does not stream startup output", async () => {
    const worktreePath = await mktemp();
    const stateDir = await mktemp();
    let launch = "";
    const process = fakeProcess((command, args) => {
      if (command === "git" && args.includes("rev-parse")) return ok({ stdout: `${worktreePath}\n`, stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "list") return ok({ stdout: JSON.stringify({ result: { terminals: [{ handle: "probe-parent" }] } }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "create") {
        launch = args[args.indexOf("--command") + 1] ?? "";
        return ok({ stdout: JSON.stringify({ result: { terminal: { handle: "child-handle" } } }), stderr: "", exitCode: 0 });
      }
      if (command === "ps" && args.includes("-A")) {
        const marker = /([A-Z0-9_]+)=\$\$/.exec(launch)?.[1];
        return ok({ stdout: marker === undefined ? "" : `4242 /bin/sh ${marker}=4242\n`, stderr: "", exitCode: 0 });
      }
      if (command === "orca" && args[0] === "terminal" && args[1] === "read") {
        return ok({ stdout: JSON.stringify({ result: { terminal: { tail: [] } } }), stderr: "", exitCode: 0 });
      }
      return failed(`unexpected call: ${command} ${args.join(" ")}`);
    });

    const result = await executeTerminalLifecycle(
      ["create", "--worktree", worktreePath, "--command", "node app.js", "--json"],
      { MEGABRAIN_STATE_DIR: stateDir, MEGABRAIN_TERMINAL_HOST: "orca", MEGABRAIN_TERMINAL_PARENT_ID: "probe-parent", TMUX: "private", TMUX_PANE: "%8" },
      process,
    );

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(result.value)).toMatchObject({ terminalId: "child-handle", pid: 4242, host: "orca" });
  });

  test("refuses a stale Orca parent before creating a terminal", async () => {
    const worktreePath = await mktemp();
    let creates = 0;
    const process = fakeProcess((command, args) => {
      if (command === "git" && args.includes("rev-parse")) return ok({ stdout: `${worktreePath}\n`, stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "list") return ok({ stdout: JSON.stringify({ result: { terminals: [{ handle: "a-live-terminal" }] } }), stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "create") creates += 1;
      return failed(`unexpected call: ${command} ${args.join(" ")}`);
    });

    const result = await executeTerminalLifecycle(
      ["create", "--worktree", worktreePath, "--command", "node app.js", "--json"],
      { MEGABRAIN_STATE_DIR: await mktemp(), MEGABRAIN_SESSION_HOST: "orca", ORCA_TERMINAL_HANDLE: "probe-parent" },
      process,
    );

    expect(result).toMatchObject({ kind: "failed", error: "terminal create requires a live Orca terminal; ORCA_TERMINAL_HANDLE=probe-parent was not found" });
    expect(creates).toBe(0);
  });

  test("names the missing parent terminal identity before creating from a tmux child", async () => {
    const worktreePath = await mktemp();
    let creates = 0;
    const process = fakeProcess((command, args) => {
      if (command === "git" && args.includes("rev-parse")) return ok({ stdout: `${worktreePath}\n`, stderr: "", exitCode: 0 });
      if (command === "orca" && args[0] === "terminal" && args[1] === "create") creates += 1;
      return failed(`unexpected call: ${command} ${args.join(" ")}`);
    });

    const result = await executeTerminalLifecycle(
      ["create", "--worktree", worktreePath, "--command", "node app.js", "--json"],
      { MEGABRAIN_STATE_DIR: await mktemp(), MEGABRAIN_TERMINAL_HOST: "orca", TMUX: "private", TMUX_PANE: "%8" },
      process,
    );

    expect(result).toMatchObject({ kind: "failed", error: "terminal create requires an Orca parent terminal; missing ORCA_TERMINAL_HANDLE or MEGABRAIN_TERMINAL_PARENT_ID" });
    expect(creates).toBe(0);
  });
});

async function mktemp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "megabrain-terminal-"));
}
