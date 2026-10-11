import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { notifyChild } from "../../src/cli/commands/queue-write.js";
import { getTmux, registerTmux, type TmuxProvider } from "../../src/hosts/tmux.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function processFor(result: Result<ProcessOutput> = ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter {
  return {
    async run() { return result; },
    async startDetached() { return failed("not used"); },
    invocationCount: () => 0,
  };
}

function providerFor(calls: Call[], delay = 0): TmuxProvider {
  return {
    id: "tmux",
    sessionForPane: async () => ok("session"),
    sessionExists: async () => ok(true),
    panesForSession: async () => ok(["%4"]),
    panePid: async () => ok("1234"),
    capturePane: async () => ok("captured"),
    sendText: async (pane, text) => {
      calls.push({ command: "tmux", args: ["send-keys", "-t", pane, "-l", text] });
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return ok(undefined);
    },
    sendKey: async (pane, key) => {
      calls.push({ command: "tmux", args: ["send-keys", "-t", pane, key] });
      return ok(undefined);
    },
  };
}

describe("tmux send lifecycle", () => {
  test("uses literal argument arrays for every lifecycle command", async () => {
    const calls: Call[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return ok({ stdout: "megabrain-a\nmegabrain-b\n", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount: () => calls.length,
    };
    const tmux = getTmux();

    expect((await tmux.killPane("%1", process)).kind).toBe("ok");
    expect((await tmux.killPane("%2", process)).kind).toBe("ok");
    expect((await tmux.killSession("session-a", process)).kind).toBe("ok");
    expect((await tmux.killPane("%3", process)).kind).toBe("ok");
    expect((await tmux.killSession("session-b", process)).kind).toBe("ok");
    expect((await tmux.listSessions(process, "#{session_name}")).kind).toBe("ok");
    expect((await tmux.listSessions(process, "#{session_name}")).kind).toBe("ok");
    expect((await tmux.listSessions(process)).kind).toBe("ok");
    expect((await tmux.globalOption("terminal-features", process)).kind).toBe("ok");
    expect((await tmux.sessionOption("megabrain-a", "mouse", process)).kind).toBe("ok");
    expect((await tmux.sessionOption("megabrain-a", "status", process)).kind).toBe("ok");
    expect((await tmux.sessionOption("megabrain-a", "escape-time", process)).kind).toBe("ok");
    expect((await tmux.sessionOption("megabrain-a", "pane-active-border-style", process)).kind).toBe("ok");
    expect((await tmux.globalOption("terminal-features", process)).kind).toBe("ok");
    expect((await tmux.sourceFile("/tmp/megabrain.tmux.conf", process)).kind).toBe("ok");
    expect((await tmux.showEnvironment("session-a", "MEGABRAIN_STATE_DIR", process)).kind).toBe("ok");
    expect(calls).toEqual([
      { command: "tmux", args: ["kill-pane", "-t", "%1"] },
      { command: "tmux", args: ["kill-pane", "-t", "%2"] },
      { command: "tmux", args: ["kill-session", "-t", "session-a"] },
      { command: "tmux", args: ["kill-pane", "-t", "%3"] },
      { command: "tmux", args: ["kill-session", "-t", "session-b"] },
      { command: "tmux", args: ["list-sessions", "-F", "#{session_name}"] },
      { command: "tmux", args: ["list-sessions", "-F", "#{session_name}"] },
      { command: "tmux", args: ["list-sessions"] },
      { command: "tmux", args: ["show-options", "-gqv", "terminal-features"] },
      { command: "tmux", args: ["show-options", "-t", "megabrain-a", "-v", "mouse"] },
      { command: "tmux", args: ["show-options", "-t", "megabrain-a", "-v", "status"] },
      { command: "tmux", args: ["show-options", "-t", "megabrain-a", "-v", "escape-time"] },
      { command: "tmux", args: ["show-options", "-t", "megabrain-a", "-v", "pane-active-border-style"] },
      { command: "tmux", args: ["show-options", "-gqv", "terminal-features"] },
      { command: "tmux", args: ["source-file", "/tmp/megabrain.tmux.conf"] },
      { command: "tmux", args: ["show-environment", "-t", "session-a", "MEGABRAIN_STATE_DIR"] },
    ]);
  });

  test("returns unknown for lifecycle queries that cannot be determined", async () => {
    const tmux = getTmux();
    const process = processFor(failed("tmux unavailable"));

    expect(await tmux.listSessions(process)).toEqual({ kind: "unknown", reason: "tmux sessions could not be determined", error: "tmux sessions could not be determined", exitCode: 1 });
    expect(await tmux.globalOption("terminal-features", process)).toEqual({ kind: "unknown", reason: "tmux global option terminal-features could not be determined", error: "tmux global option terminal-features could not be determined", exitCode: 1 });
    expect(await tmux.sessionOption("session-a", "mouse", process)).toEqual({ kind: "unknown", reason: "tmux session option mouse for session session-a could not be determined", error: "tmux session option mouse for session session-a could not be determined", exitCode: 1 });
    expect(await tmux.showEnvironment("session-a", "MEGABRAIN_STATE_DIR", process)).toEqual({ kind: "unknown", reason: "tmux environment MEGABRAIN_STATE_DIR for session session-a could not be determined", error: "tmux environment MEGABRAIN_STATE_DIR for session session-a could not be determined", exitCode: 1 });
  });

  test("does not type to a pane before its idle state has been read", async () => {
    const root = mkdtempSync("/tmp/megabrain-tmux-panels-");
    const calls: Call[] = [];
    let active = 0;
    let maximum = 0;
    const original = getTmux();
    const fake = providerFor(calls);
    registerTmux({
      ...fake,
      sendText: async (pane, text) => {
        calls.push({ command: "tmux", args: ["send-keys", "-t", pane, "-l", text] });
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return ok(undefined);
      },
    });
    try {
      const results = await Promise.all([
        notifyChild(root, { runtime: "tmux", tmuxSession: "s", tmuxPane: "%4", agent: "codex" }, "first", processFor()),
        notifyChild(root, { runtime: "tmux", tmuxSession: "s", tmuxPane: "%5", agent: "codex" }, "second", processFor()),
      ]);
      expect(results.map((result) => result.transport)).toEqual(["deferred", "deferred"]);
      expect(maximum).toBe(0);
      expect(calls).toEqual([]);
    } finally {
      registerTmux(original);
    }
  });

  test("defers without touching a pane whose composer has not been inspected", async () => {
    const root = mkdtempSync("/tmp/megabrain-tmux-held-");
    const calls: Call[] = [];
    const original = getTmux();
    registerTmux(providerFor(calls));
    try {
      const result = await notifyChild(root, { runtime: "tmux", tmuxSession: "s", tmuxPane: "%4", agent: "codex" }, "dispatch", processFor(), { MEGABRAIN_LOCK_WAIT_SECONDS: "0" });
      expect(result).toEqual({ outcome: "deferred", reason: "child requires idle-gated delivery", transport: "deferred" });
      expect(calls).toEqual([]);
    } finally {
      registerTmux(original);
    }
  });

  test("returns the same pending delivery path for concurrent messages to one pane", async () => {
    const root = mkdtempSync("/tmp/megabrain-tmux-lock-");
    const calls: Call[] = [];
    const original = getTmux();
    registerTmux(providerFor(calls, 1));
    try {
      const meta = { runtime: "tmux", tmuxSession: "s", tmuxPane: "%4", agent: "codex" };
      const results = await Promise.all([
        notifyChild(root, meta, "first", processFor()),
        notifyChild(root, meta, "second", processFor()),
      ]);
      expect(results.map((result) => result.transport)).toEqual(["deferred", "deferred"]);
      expect(calls).toEqual([]);
    } finally {
      registerTmux(original);
    }
  });
});
