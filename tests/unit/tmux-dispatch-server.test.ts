import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { getTmux, registerTmux, splitTmuxPane } from "../../src/hosts/tmux.js";
import { composerTmux } from "./composer-tmux.js";

// A fake adapter: no test here touches a real tmux server, the default one or megabrain-app.
const APP_TMUX = "/private/tmp/tmux-501/megabrain-app,4242,0";

type Call = { command: string; args: readonly string[] };

function recordingProcess(calls: Call[]): ProcessAdapter {
  return {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      const rest = command === "tmux" && args[0] === "-L" ? args.slice(2) : args;
      if (command === "tmux" && rest[0] === "split-window") return ok({ stdout: "%child\n", stderr: "", exitCode: 0 });
      if (command === "tmux" && rest[0] === "display-message" && rest.at(-1) === "#{session_id}") return ok({ stdout: "$7\n", stderr: "", exitCode: 0 });
      if (command === "tmux" && rest[0] === "list-panes" && String(rest.at(-1)).includes("window_id")) return ok({ stdout: "%child|@1|0|0|0|59|120\n", stderr: "", exitCode: 0 });
      if (command === "tmux" && rest[0] === "list-panes") return ok({ stdout: "%child\n", stderr: "", exitCode: 0 });
      if (command === "tmux" && rest[0] === "capture-pane") return ok({ stdout: "› Ask Codex to do anything\n", stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

function tmuxCalls(calls: readonly Call[]): readonly Call[] {
  return calls.filter((call) => call.command === "tmux");
}

describe("dispatch panes stay off the app tmux server", () => {
  test("a provider call made from an app terminal addresses the dispatch server explicitly", async () => {
    const calls: Call[] = [];
    const previous = globalThis.process.env.TMUX;
    globalThis.process.env.TMUX = APP_TMUX;
    try {
      const split = await splitTmuxPane("work", "%1", "/work/tree", recordingProcess(calls));
      expect(split).toEqual({ kind: "ok", value: "%child" });
      const alive = await getTmux().sessionExists("work", recordingProcess(calls));
      expect(alive.kind).toBe("ok");
    } finally {
      if (previous === undefined) delete globalThis.process.env.TMUX; else globalThis.process.env.TMUX = previous;
    }
    const issued = tmuxCalls(calls);
    expect(issued.length).toBe(2);
    for (const call of issued) expect(call.args.slice(0, 2)).toEqual(["-L", "default"]);
  });

  test("a provider call from any other tmux server is left alone", async () => {
    const calls: Call[] = [];
    const previous = globalThis.process.env.TMUX;
    globalThis.process.env.TMUX = "/private/tmp/tmux-501/default,4242,0";
    try {
      await splitTmuxPane("work", "%1", "/work/tree", recordingProcess(calls));
    } finally {
      if (previous === undefined) delete globalThis.process.env.TMUX; else globalThis.process.env.TMUX = previous;
    }
    expect(tmuxCalls(calls)[0]?.args[0]).toBe("split-window");
  });

  test("spawn from an app terminal opens its own dispatch session instead of splitting the caller pane", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-tmux-appserver-`);
    const calls: Call[] = [];
    const original = getTmux();
    registerTmux({ ...original, ...composerTmux() });
    try {
      const result = await executeSpawn(["--worktree", root, "--agent", "codex", "--prompt", "spawn", "--tmux", "true"], {
        MEGABRAIN_STATE_DIR: `${root}/state`, MEGABRAIN_PROMPT_ARGV_GRACE_MS: "0", MEGABRAIN_SESSION_ID: "app-parent",
        TMUX: APP_TMUX, TMUX_PANE: "%caller", MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-app-server",
      }, recordingProcess(calls), { resolveWorktree: async () => ok({ path: root, branch: "main", ownership: "existing", workspaceId: null }) });
      expect(result.kind).toBe("ok");
      const issued = tmuxCalls(calls);
      expect(issued.length).toBeGreaterThan(0);
      for (const call of issued) {
        expect(call.args.slice(0, 2)).toEqual(["-L", "default"]);
        expect(call.args).not.toContain("%caller");
      }
      expect(issued.some((call) => call.args.includes("new-session"))).toBe(true);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });
});
