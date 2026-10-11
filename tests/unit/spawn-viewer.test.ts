import { afterEach, describe, expect, test } from "bun:test";
import { failed, ok } from "../../src/core/result.js";
import { cleanupRun, appendReceived, type Call, type SpawnRun, runComposerSpawn } from "./spawn-harness.js";

type Viewer = { terminal: string; opened: boolean; attachCommand: string; error: string | null };

const runs: SpawnRun[] = [];
afterEach(async () => { while (runs.length > 0) await cleanupRun(runs.pop() as SpawnRun); });

let counter = 0;
async function spawn(
  environment: Record<string, string>,
  extraArgs: readonly string[],
  detached: (command: string, args: readonly string[]) => ReturnType<typeof ok<{ pid: number }>> | ReturnType<typeof failed>,
  behavior?: Parameters<typeof runComposerSpawn>[4],
): Promise<{ run: SpawnRun; viewer: Viewer | undefined; started: Call[] }> {
  counter += 1;
  const id = `dispatch-viewer-${counter}`;
  const started: Call[] = [];
  const run = await runComposerSpawn(
    id,
    { agent: "codex", onSubmit: (_prompt, root) => appendReceived(root, id) },
    environment,
    ["--json", ...extraArgs],
    behavior,
    {},
    (command, args) => {
      // The supervisor worker is also started detached; it is not a viewer.
      if (args[0] === "__supervise-worker") return ok({ pid: 1 });
      started.push({ command, args: [...args] });
      return detached(command, args) as ReturnType<typeof ok<{ pid: number }>>;
    },
  );
  runs.push(run);
  if (run.result.kind !== "ok") throw new Error(`spawn failed: ${run.result.kind === "failed" ? run.result.error : run.result.reason}`);
  const parsed = JSON.parse(run.result.value) as { viewer?: Viewer };
  return { run, viewer: parsed.viewer, started };
}

function sessionOf(run: SpawnRun): string {
  const created = run.process.calls.find((call) => call.command === "tmux" && call.args[0] === "new-session");
  if (created === undefined) throw new Error("no tmux session was created");
  return created.args[created.args.indexOf("-s") + 1] ?? "";
}

const local = { MEGABRAIN_SESSION_HOST: "local", MEGABRAIN_SESSION_ID: "claude:local-caller" };

describe("spawn opens a viewer in the operator's own terminal", () => {
  test("a local caller gets a viewer attached to the child's tmux session", async () => {
    const { run, viewer, started } = await spawn(local, ["--terminal", "alacritty"], () => ok({ pid: 4242 }));
    const session = sessionOf(run);
    expect(started).toEqual([{ command: "alacritty", args: ["-e", "tmux", "attach", "-t", session] }]);
    expect(viewer).toEqual({ terminal: "alacritty", opened: true, attachCommand: `tmux attach -t ${session}`, error: null });
  });

  test("the terminal comes from MEGABRAIN_TERMINAL when no flag is given", async () => {
    const { run, viewer, started } = await spawn({ ...local, MEGABRAIN_TERMINAL: "xterm" }, [], () => ok({ pid: 1 }));
    expect(started).toEqual([{ command: "xterm", args: ["-e", "tmux", "attach", "-t", sessionOf(run)] }]);
    expect(viewer?.terminal).toBe("xterm");
  });

  test("--terminal none opens nothing and prints the attach command", async () => {
    const { run, viewer, started } = await spawn(local, ["--terminal", "none"], () => ok({ pid: 1 }));
    expect(started).toEqual([]);
    expect(viewer).toEqual({ terminal: "none", opened: false, attachCommand: `tmux attach -t ${sessionOf(run)}`, error: null });
  });

  test("an opener failure keeps the spawn successful and reports the error", async () => {
    const { run, viewer } = await spawn(local, ["--terminal", "alacritty"], () => failed("alacritty: executable not found"));
    expect(viewer?.opened).toBe(false);
    expect(viewer?.terminal).toBe("alacritty");
    expect(viewer?.error).toContain("alacritty: executable not found");
    expect(viewer?.attachCommand).toBe(`tmux attach -t ${sessionOf(run)}`);
  });

  test("a rejected terminal name is an argument error before anything starts", async () => {
    counter += 1;
    const run = await runComposerSpawn(`dispatch-viewer-${counter}`, { agent: "codex" }, local, ["--terminal", "nonsense"]);
    runs.push(run);
    expect(run.result.kind === "failed" ? run.result.error : "").toContain("unknown terminal 'nonsense'");
    expect(run.process.calls.some((call) => call.args[0] === "new-session")).toBe(false);
  });

  test("a tmux caller keeps its split and gets no extra window", async () => {
    const callerSession = (command: string, args: readonly string[]) =>
      command === "tmux" && args[0] === "display-message" ? ok({ stdout: args.includes("#{pane_current_path}") ? "/work/tree\n" : "operator\n", stderr: "", exitCode: 0 }) : undefined;
    const { viewer, started } = await spawn(
      { MEGABRAIN_SESSION_HOST: "tmux", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1", TERM_PROGRAM: "ghostty" },
      [],
      () => ok({ pid: 1 }),
      (command, args) => callerSession(command, args) ?? ok({ stdout: command === "tmux" && args[0] === "list-panes" ? "%9\n" : "", stderr: "", exitCode: 0 }),
    );
    expect(started).toEqual([]);
    expect(viewer).toBeUndefined();
  });

  test("a tmux caller naming a terminal explicitly still gets a viewer", async () => {
    const { viewer, started } = await spawn(
      { MEGABRAIN_SESSION_HOST: "tmux", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1" },
      ["--terminal", "alacritty"],
      () => ok({ pid: 1 }),
      (command, args) => ok({ stdout: command === "tmux" && args[0] === "display-message" ? "operator\n" : command === "tmux" && args[0] === "list-panes" ? "%9\n" : "", stderr: "", exitCode: 0 }),
    );
    expect(started.map((call) => call.command)).toEqual(["alacritty"]);
    expect(viewer?.opened).toBe(true);
  });

  test("text output names the viewer and the attach command", async () => {
    counter += 1;
    const id = `dispatch-viewer-${counter}`;
    const run = await runComposerSpawn(id, { agent: "codex", onSubmit: (_prompt, root) => appendReceived(root, id) }, local, ["--terminal", "none"]);
    runs.push(run);
    expect(run.result.kind).toBe("ok");
    const text = run.result.kind === "ok" ? run.result.value : "";
    expect(text).toContain(`viewer: none (not opened); attach with: tmux attach -t ${sessionOf(run)}`);
  });
});
