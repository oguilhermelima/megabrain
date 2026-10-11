import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { executeTerminalLifecycle } from "../../src/cli/commands/terminal-lifecycle.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;
const output = (stdout: string): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode: 0 });

function fakeProcess(worktree: string, opener: (command: string) => Result<{ pid: number }>): ProcessAdapter & { readonly calls: Call[]; readonly started: Call[] } {
  const calls: Call[] = [];
  const started: Call[] = [];
  return {
    calls,
    started,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "git") return output(`${worktree}\n`);
      if (command === "tmux" && args[0] === "new-session") return output("%7 4242\n");
      if (command === "tmux" && args[0] === "new-window") return output("%9 777\n");
      if (command === "tmux" && args[0] === "display-message") return output("work\n");
      if (command === "tmux") return output("");
      return failed(`unexpected call: ${command} ${args.join(" ")}`);
    },
    async startDetached(command, args) { started.push({ command, args: [...args] }); return opener(command); },
    invocationCount() { return calls.length; },
  };
}

async function setup(): Promise<{ worktree: string; stateDir: string }> {
  return { worktree: await mkdtemp(`${tmpdir()}/megabrain-tcv-worktree-`), stateDir: await mkdtemp(`${tmpdir()}/megabrain-tcv-state-`) };
}

const create = (worktree: string) => ["create", "--worktree", worktree, "--command", "node app.js", "--json"];

describe("terminal create opens a viewer for a caller outside every host", () => {
  test("the new session gets a viewer in the selected terminal", async () => {
    const { worktree, stateDir } = await setup();
    const process = fakeProcess(worktree, () => ok({ pid: 9 }));
    const result = await executeTerminalLifecycle([...create(worktree), "--terminal", "alacritty"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : result.reason);
    const created = JSON.parse(result.value) as { terminalId: string; attach: string; viewer: { terminal: string; opened: boolean; attachCommand: string; error: string | null } };
    const session = created.terminalId.split(":")[0] ?? "";
    expect(process.started).toEqual([{ command: "alacritty", args: ["-e", "tmux", "attach", "-t", session] }]);
    expect(created.viewer).toEqual({ terminal: "alacritty", opened: true, attachCommand: `tmux attach -t ${session}`, error: null });
  });

  test("--terminal none prints the attach command and opens nothing", async () => {
    const { worktree, stateDir } = await setup();
    const process = fakeProcess(worktree, () => ok({ pid: 9 }));
    const result = await executeTerminalLifecycle([...create(worktree), "--terminal", "none"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    if (result.kind !== "ok") throw new Error("create failed");
    expect(process.started).toEqual([]);
    expect(JSON.parse(result.value).viewer).toMatchObject({ terminal: "none", opened: false, error: null });
  });

  test("an opener failure keeps the terminal and reports the error", async () => {
    const { worktree, stateDir } = await setup();
    const process = fakeProcess(worktree, () => failed("alacritty: executable not found"));
    const result = await executeTerminalLifecycle([...create(worktree), "--terminal", "alacritty"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    if (result.kind !== "ok") throw new Error("create failed");
    const created = JSON.parse(result.value);
    expect(created.terminalId).toMatch(/^[^:]+:%7$/);
    expect(created.viewer).toMatchObject({ terminal: "alacritty", opened: false });
    expect(created.viewer.error).toContain("executable not found");
  });

  test("a tmux caller gets no extra window without an explicit terminal", async () => {
    const { worktree, stateDir } = await setup();
    const process = fakeProcess(worktree, () => ok({ pid: 9 }));
    const result = await executeTerminalLifecycle(create(worktree), { MEGABRAIN_STATE_DIR: stateDir, TMUX: "x", TMUX_PANE: "%3", TERM_PROGRAM: "ghostty" }, process);
    if (result.kind !== "ok") throw new Error("create failed");
    expect(process.started).toEqual([]);
    expect(JSON.parse(result.value).viewer).toBeUndefined();
  });

  test("text output carries the viewer line", async () => {
    const { worktree, stateDir } = await setup();
    const process = fakeProcess(worktree, () => ok({ pid: 9 }));
    const result = await executeTerminalLifecycle(["create", "--worktree", worktree, "--command", "node app.js", "--terminal", "none"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    if (result.kind !== "ok") throw new Error("create failed");
    expect(result.value).toContain("viewer: none (not opened); attach with: tmux attach -t ");
  });
});
