import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { tmuxSessionName } from "../../src/cli/commands/context.js";
import { callerFromEnvironment } from "../../src/cli/commands/orchestrate-list.js";
import { caller, tmuxSessionForEnvironment } from "../../src/cli/commands/orchestrate-close.js";
import { session as childSession } from "../../src/cli/commands/child-ack.js";
import { callerSession } from "../../src/cli/commands/install-doctor.js";
import { childIdentity, dispatchId } from "../../src/cli/commands/check.js";
import { tmuxCallerSession } from "../../src/cli/commands/orchestrate-prune.js";
import { notifyChild } from "../../src/cli/commands/queue-write.js";
import { createTmuxSession, getTmux, registerTmux, sendTmuxPair, splitTmuxWindow, waitForTmuxSession, type TmuxProvider } from "../../src/hosts/tmux.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;

function processFor(result: Result<ProcessOutput> = ok({ stdout: "work\n", stderr: "", exitCode: 0 })): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return result;
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const environment = { TMUX: "server", TMUX_PANE: "%4" };

describe("tmux identity provider", () => {
  test("uses the exact tmux identity argument arrays", async () => {
    const process = processFor();
    const tmux = getTmux();

    expect((await tmux.sessionForPane("%4", process)).kind).toBe("ok");
    expect((await tmux.sessionExists("work", process)).kind).toBe("ok");
    expect((await tmux.panesForSession("work", process)).kind).toBe("ok");
    expect((await tmux.panePid("%4", process)).kind).toBe("ok");
    expect(process.calls).toEqual([
      { command: "tmux", args: ["display-message", "-p", "-t", "%4", "#{session_name}"] },
      { command: "tmux", args: ["has-session", "-t", "work"] },
      { command: "tmux", args: ["list-panes", "-t", "work", "-F", "#{pane_id}"] },
      { command: "tmux", args: ["display-message", "-p", "-t", "%4", "#{pane_pid}"] },
    ]);
  });

  test("returns unknown when tmux cannot answer an identity query", async () => {
    const process = processFor(failed("tmux: command not found"));
    const tmux = getTmux();

    expect(await tmux.sessionForPane("%4", process)).toMatchObject({ kind: "unknown" });
    expect(await tmux.sessionExists("work", process)).toMatchObject({ kind: "unknown" });
    expect(await tmux.panesForSession("work", process)).toMatchObject({ kind: "unknown" });
    expect(await tmux.panePid("%4", process)).toMatchObject({ kind: "unknown" });
  });

  test("a registered module answer is followed by two consumers", async () => {
    const original = getTmux();
    const fake: TmuxProvider = {
      id: "tmux",
      sessionForPane: async () => ok("module-session"),
    sessionExists: async () => ok(true),
    panesForSession: async () => ok(["%4"]),
    panePid: async () => ok("1234"),
      capturePane: async () => ok("captured"),
      sendText: async () => ok(undefined),
      sendKey: async () => ok(undefined),
    };
    registerTmux(fake);
    try {
      expect(await callerFromEnvironment(environment, processFor())).toEqual({ id: "module-session:%4", host: "tmux" });
      expect(await childIdentity(environment, processFor())).toEqual({ childHost: "tmux", tmux: { session: "module-session", pane: "%4" } });
    } finally {
      registerTmux(original);
    }
  });

  test("captures with the exact arguments, including the requested line count", async () => {
    const process = processFor();
    const tmux = getTmux();

    expect(await tmux.capturePane("%7", 200, process)).toEqual({ kind: "ok", value: "work\n" });
    expect(await tmux.capturePane("%7", 37, process)).toEqual({ kind: "ok", value: "work\n" });
    expect(process.calls).toEqual([
      { command: "tmux", args: ["capture-pane", "-p", "-t", "%7", "-S", "-200"] },
      { command: "tmux", args: ["capture-pane", "-p", "-t", "%7", "-S", "-37"] },
    ]);
  });

  test("sends text and the submit key as two separate calls", async () => {
    const process = processFor();
    const tmux = getTmux();

    expect(await tmux.sendText("%7", "pointer", process)).toEqual({ kind: "ok", value: undefined });
    expect(await tmux.sendKey("%7", "Tab", process)).toEqual({ kind: "ok", value: undefined });
    expect(process.calls).toEqual([
      { command: "tmux", args: ["send-keys", "-t", "%7", "-l", "pointer"] },
      { command: "tmux", args: ["send-keys", "-t", "%7", "Tab"] },
    ]);
  });

  test("keeps each text and submit key pair under one pane lock", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-tmux-pair-`);
    const calls: string[] = [];
    const original = getTmux();
    const fake: TmuxProvider = {
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => {
        calls.push(`text:${text}`);
        if (text === "first") await new Promise((resolve) => setTimeout(resolve, 20));
        return ok(undefined);
      },
      sendKey: async (_pane, key) => {
        calls.push(`key:${key}`);
        return ok(undefined);
      },
    };
    registerTmux(fake);
    try {
      await Promise.all([
        sendTmuxPair(root, "%7", "first", "Tab", {}, processFor()),
        sendTmuxPair(root, "%7", "second", "Enter", {}, processFor()),
      ]);
      expect(calls).toHaveLength(4);
      expect(calls.indexOf("key:Tab")).toBe(calls.indexOf("text:first") + 1);
      expect(calls.indexOf("key:Enter")).toBe(calls.indexOf("text:second") + 1);
    } finally {
      registerTmux(original);
      await rm(root, { recursive: true, force: true });
    }
  });

  test("creates and splits a tmux session with the runtime flags", async () => {
    const calls: Call[] = [];
    let sessionChecks = 0;
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        if (args[0] === "has-session") {
          sessionChecks += 1;
          return sessionChecks === 3 ? ok({ stdout: "", stderr: "", exitCode: 0 }) : failed("session is not ready");
        }
        if (args[0] === "split-window") return ok({ stdout: "%9\n", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };

    expect(await createTmuxSession("child", "/work/tree", "codex", process)).toEqual({ kind: "ok", value: undefined });
    expect(await splitTmuxWindow("child", "/work/tree", process)).toEqual({ kind: "ok", value: "%9" });
    expect(await waitForTmuxSession("child", process, { attempts: 3, waitMs: 0 })).toEqual({ kind: "ok", value: undefined });
    expect(calls).toEqual([
      { command: "tmux", args: ["new-session", "-d", "-A", "-s", "child", "-c", "/work/tree", "codex"] },
      { command: "tmux", args: ["split-window", "-d", "-t", "child", "-c", "/work/tree", "-P", "-F", "#{pane_id}"] },
      { command: "tmux", args: ["has-session", "-t", "child"] },
      { command: "tmux", args: ["has-session", "-t", "child"] },
      { command: "tmux", args: ["has-session", "-t", "child"] },
    ]);
  });

  test("creates a tmux session without a shell command when none is given", async () => {
    const calls: Call[] = [];
    const process: ProcessAdapter = {
      async run(command, args) {
        calls.push({ command, args: [...args] });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      async startDetached() { return failed("not used"); },
      invocationCount() { return calls.length; },
    };

    expect(await createTmuxSession("child", "/work/tree", undefined, process)).toEqual({ kind: "ok", value: undefined });
    expect(calls).toStrictEqual([
      { command: "tmux", args: ["new-session", "-d", "-A", "-s", "child", "-c", "/work/tree"] },
    ]);
  });

  test("the child notification follows the registered agent and tmux modules", async () => {
    const calls: Call[] = [];
    const original = getTmux();
    const fake: TmuxProvider = {
      id: "tmux",
      sessionForPane: async () => ok("module-session"),
      sessionExists: async () => ok(true),
      panesForSession: async () => ok(["%4"]),
      panePid: async () => ok("1234"),
      capturePane: async () => ok("captured"),
      sendText: async (pane, text) => { calls.push({ command: "tmux", args: ["send-keys", "-t", pane, "-l", text] }); return ok(undefined); },
      sendKey: async (pane, key) => { calls.push({ command: "tmux", args: ["send-keys", "-t", pane, key] }); return ok(undefined); },
    };
    registerTmux(fake);
    try {
      const result = await notifyChild("/tmp/unused", { runtime: "tmux", tmuxSession: "s", tmuxPane: "%4", agent: "codex" }, "dispatch", processFor());
      expect(result).toEqual({ outcome: "delivered", reason: "child-notified" });
      expect(calls).toEqual([
        { command: "tmux", args: ["send-keys", "-t", "%4", "-l", "[megabrain] reply available; run megabrain check"] },
        { command: "tmux", args: ["send-keys", "-t", "%4", "Tab"] },
      ]);
    } finally {
      registerTmux(original);
    }
  });

  test("an unknown child agent is not sent text followed by Enter", async () => {
    const process = processFor();
    const result = await notifyChild("/tmp/unused", { runtime: "tmux", tmuxSession: "s", tmuxPane: "%4", agent: "unregistered-agent" }, "dispatch", process);
    expect(result.outcome).toBe("failed");
    expect(process.calls).toEqual([]);
  });

  test("does not query tmux without a pane marker", async () => {
    const process = processFor();
    const noPane = { TMUX: "server" };

    expect(await tmuxSessionName(noPane, process)).toBeUndefined();
    expect(await callerFromEnvironment(noPane, process)).toEqual({ id: "", host: "unknown" });
    expect(await childSession(noPane, process)).toMatchObject({ kind: "failed" });
    expect(await callerSession(noPane, process)).toBe("");
    expect(process.calls).toEqual([]);
  });

  test("preserves unknown-session and missing-tmux consumer answers", async () => {
    const process = processFor(failed("tmux: command not found"));

    expect(await tmuxSessionName(environment, process)).toBeUndefined();
    expect(await callerFromEnvironment(environment, process)).toEqual({ id: "", host: "unknown" });
    expect(await caller(environment, process)).toEqual({ host: "tmux", tmuxPane: "%4" });
    expect(await tmuxSessionForEnvironment(environment, process)).toBeUndefined();
    expect(await childSession(environment, process)).toEqual({ kind: "failed", error: "tmux session could not be resolved", exitCode: 1 });
    expect(await callerSession(environment, process)).toBe("");
    expect(await childIdentity(environment, process)).toEqual({ childHost: "tmux", tmux: { session: undefined, pane: "%4" } });
    expect(await tmuxCallerSession(environment, process)).toBeUndefined();
  });
});
