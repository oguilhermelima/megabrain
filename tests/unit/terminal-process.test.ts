import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  test("accepts Codex under a shell wrapper in the pane foreground group", async () => {
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "tmux") return ok<ProcessOutput>({ stdout: "42000\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-axo") return ok<ProcessOutput>({ stdout: "42000 1 42000 42000 bash -lc 'codex -- prompt'\n42014 42000 42000 42000 codex -- prompt\n", stderr: "", exitCode: 0 });
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 2; },
    };
    const check = agentOwnsForegroundProcess as unknown as (agent: string, pid: number, process: ProcessAdapter, terminal: { host: string; tmuxPane: string }) => Promise<boolean>;
    expect(await check("codex", 42014, process, { host: "tmux", tmuxPane: "%4" })).toBe(true);
  });

  test("rejects Codex when the pane wrapper remains after the agent exits", async () => {
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "tmux") return ok<ProcessOutput>({ stdout: "42000\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-axo") return ok<ProcessOutput>({ stdout: "42000 1 42000 42000 bash -lc 'codex -- prompt'\n", stderr: "", exitCode: 0 });
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 2; },
    };
    const check = agentOwnsForegroundProcess as unknown as (agent: string, pid: number, process: ProcessAdapter, terminal: { host: string; tmuxPane: string }) => Promise<boolean>;
    expect(await check("codex", 42014, process, { host: "tmux", tmuxPane: "%4" })).toBe(false);
  });

  test("rejects a Codex descendant in a background process group", async () => {
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "tmux") return ok<ProcessOutput>({ stdout: "42000\n", stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-axo") return ok<ProcessOutput>({ stdout: "42000 1 42000 42000 bash -lc 'codex -- prompt'\n42014 42000 42014 42000 codex -- prompt\n", stderr: "", exitCode: 0 });
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 2; },
    };
    const check = agentOwnsForegroundProcess as unknown as (agent: string, pid: number, process: ProcessAdapter, terminal: { host: string; tmuxPane: string }) => Promise<boolean>;
    expect(await check("codex", 42014, process, { host: "tmux", tmuxPane: "%4" })).toBe(false);
  });
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

  test("accepts a Codex process in the Orca terminal's foreground group from its captured tree", async () => {
    const tree = readFileSync(new URL("../fixtures/orca-codex-foreground-tree.txt", import.meta.url), "utf8");
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "orca") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "captured-terminal", pid: 48005 }] }), stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-axo") return ok<ProcessOutput>({ stdout: tree, stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-ww") return ok<ProcessOutput>({ stdout: "48932 48932 48005 /opt/codex/bin/codex agent\n", stderr: "", exitCode: 0 });
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 2; },
    };
    const check = agentOwnsForegroundProcess as unknown as (agent: string, pid: number, process: ProcessAdapter, terminal: { host: string; terminalId: string }) => Promise<boolean>;
    expect(await check("codex", 48932, process, { host: "orca", terminalId: "captured-terminal" })).toBe(true);
  });

  test("accepts a live terminal-owned Codex child outside the terminal root process group", async () => {
    const tree = readFileSync(new URL("../fixtures/orca-codex-foreground-tree.txt", import.meta.url), "utf8")
      .replace("48932 48019 48932 48932 codex", "48932 48019 48019 48932 codex");
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "orca") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "captured-terminal", pid: 48005 }] }), stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-axo") return ok<ProcessOutput>({ stdout: tree, stderr: "", exitCode: 0 });
        if (command === "ps" && args[0] === "-ww") return ok<ProcessOutput>({ stdout: "48932 48932 48005 /opt/codex/bin/codex agent\n", stderr: "", exitCode: 0 });
        return failed(`unexpected ${command} ${args.join(" ")}`);
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 2; },
    };
    const check = agentOwnsForegroundProcess as unknown as (agent: string, pid: number, process: ProcessAdapter, terminal: { host: string; terminalId: string }) => Promise<boolean>;
    expect(await check("codex", 48932, process, { host: "orca", terminalId: "captured-terminal" })).toBe(true);
  });

  test("falls back to process-group proof when Orca does not report a terminal PID", async () => {
    const process: ProcessAdapter = {
      async run(command, args) {
        if (command === "orca") return ok<ProcessOutput>({ stdout: JSON.stringify({ terminals: [{ handle: "captured-terminal" }] }), stderr: "", exitCode: 0 });
        expect(command).toBe("ps");
        expect(args).toEqual(["-ww", "-p", "41414", "-o", "pid=,pgid=,tpgid=,args="]);
        return ok<ProcessOutput>({ stdout: "41414 41414 41414 /opt/codex/bin/codex agent\n", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 2; },
    };
    const check = agentOwnsForegroundProcess as unknown as (agent: string, pid: number, process: ProcessAdapter, terminal: { host: string; terminalId: string }) => Promise<boolean>;
    expect(await check("codex", 41414, process, { host: "orca", terminalId: "captured-terminal" })).toBe(true);
  });
});
