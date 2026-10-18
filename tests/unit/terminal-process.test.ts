import { describe, expect, test } from "bun:test";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import { agentOwnsForegroundProcess } from "../../src/core/terminal-process.js";

function processFor(stdout: string): ProcessAdapter {
  return {
    async run(command, args) {
      expect(command).toBe("ps");
      expect(args).toEqual(["-ww", "-p", "41414", "-o", "pid=,pgid=,tpgid=,args="]);
      return ok<ProcessOutput>({ stdout, stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 1; },
  };
}

describe("terminal foreground process proof", () => {
  test("accepts a live agent process in the foreground process group", async () => {
    expect(await agentOwnsForegroundProcess("claude", 41414, processFor("41414 41414 41414 /opt/claude/bin/claude --resume session\n"))).toBe(true);
  });

  test("rejects a shell even when it owns the foreground process group", async () => {
    expect(await agentOwnsForegroundProcess("codex", 41414, processFor("41414 41414 41414 -zsh\n"))).toBe(false);
  });

  test("rejects an agent process that is alive behind another foreground process", async () => {
    expect(await agentOwnsForegroundProcess("claude", 41414, processFor("41414 41414 9012 /opt/claude/bin/claude --resume session\n"))).toBe(false);
  });

  test("rejects a missing receiver", async () => {
    expect(await agentOwnsForegroundProcess("claude", 41414, processFor(""))).toBe(false);
  });
});
