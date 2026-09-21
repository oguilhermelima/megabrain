import { describe, expect, test } from "bun:test";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { tmuxSessionName } from "../../src/cli/commands/context.js";
import { callerFromEnvironment } from "../../src/cli/commands/orchestrate-list.js";
import { caller, tmuxSessionForEnvironment } from "../../src/cli/commands/orchestrate-close.js";
import { session as childSession } from "../../src/cli/commands/child-ack.js";
import { callerSession } from "../../src/cli/commands/install-doctor.js";
import { childIdentity, dispatchId } from "../../src/cli/commands/check.js";
import { tmuxCallerSession } from "../../src/cli/commands/orchestrate-prune.js";
import { getTmux, registerTmux, type TmuxProvider } from "../../src/hosts/tmux.js";

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
    };
    registerTmux(fake);
    try {
      expect(await callerFromEnvironment(environment, processFor())).toEqual({ id: "module-session:%4", host: "tmux" });
      expect(await childIdentity(environment, processFor())).toEqual({ childHost: "tmux", tmux: { session: "module-session", pane: "%4" } });
    } finally {
      registerTmux(original);
    }
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
