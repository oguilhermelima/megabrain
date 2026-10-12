import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { stableAncestorIdentity } from "../../src/adapters/ancestor.js";
import { resolveCaller } from "../../src/cli/commands/queue-write.js";
import { executeOrchestrateAdopt } from "../../src/cli/commands/orchestrate-adopt.js";
import { executeOrchestrateWatch } from "../../src/cli/commands/orchestrate-parent.js";
import { guardedStateDatabase } from "./state-db-guard.js";
import { createDispatch, getDispatch } from "../../src/adapters/state-db.js";

// A caller whose runtime runs every command in a fresh shell must keep one owner: the identity is
// the nearest ancestor that is not a shell or wrapper, tied to its start time so a reused pid
// cannot match.

type Row = Readonly<{ ppid: number; lstart: string; command: string; tty?: string }>;
type Table = Readonly<Record<number, Row>>;

const started = "Mon Oct 12 01:08:48 2026";

// Answers the two ps shapes the resolver is allowed to use: one row per pid with parent, start
// time and command, and the controlling tty.
function psProcess(table: Table): ProcessAdapter {
  return {
    async run(command: string, args: readonly string[]): Promise<Result<ProcessOutput>> {
      if (command !== "ps") return ok({ stdout: "", stderr: "", exitCode: 0 });
      const pid = Number(args[args.indexOf("-p") + 1]);
      const row = table[pid];
      if (row === undefined) return ok({ stdout: "", stderr: "", exitCode: 1 });
      if (args.includes("tty=")) return ok({ stdout: `${row.tty ?? "??"}\n`, stderr: "", exitCode: 0 });
      if (args.includes("lstart=") && !args.includes("ppid=")) return ok({ stdout: `${row.lstart}\n`, stderr: "", exitCode: 0 });
      return ok({ stdout: ` ${row.ppid} ${row.lstart} ${row.command}\n`, stderr: "", exitCode: 0 });
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

function runtimeTable(shellPid: number, runtimeStart = started): Table {
  return {
    [shellPid]: { ppid: 900001, lstart: "Mon Oct 12 02:00:00 2026", command: "/bin/zsh -c megabrain orchestrate watch x" },
    900001: { ppid: 900000, lstart: runtimeStart, command: "node /opt/runtime/server.js" },
    900000: { ppid: 1, lstart: started, command: "/sbin/launchd" },
  };
}

describe("stableAncestorIdentity", () => {
  test("two transient shells under one runtime resolve to the same owner", async () => {
    const first = await stableAncestorIdentity(51001, psProcess(runtimeTable(51001)));
    const second = await stableAncestorIdentity(51002, psProcess(runtimeTable(51002)));
    expect(first).toBe(`proc:900001:${runtimeTable(1)[900001]?.lstart}`);
    expect(second).toBe(first);
  });

  test("a reused pid with a different start time does not match", async () => {
    const before = await stableAncestorIdentity(51001, psProcess(runtimeTable(51001)));
    const after = await stableAncestorIdentity(51001, psProcess(runtimeTable(51001, "Tue Oct 13 09:00:00 2026")));
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
  });

  test("shells, wrappers and megabrain's own node are skipped", async () => {
    const table: Table = {
      60001: { ppid: 60002, lstart: started, command: "/bin/sh -c x" },
      60002: { ppid: 60003, lstart: started, command: "env FOO=1 megabrain watch" },
      60003: { ppid: 60004, lstart: started, command: "node /usr/lib/megabrain/cli.js watch" },
      60004: { ppid: 60005, lstart: started, command: "-bash" },
      60005: { ppid: 60006, lstart: started, command: "tmux: client" },
      60006: { ppid: 1, lstart: started, command: "/Applications/Dash.app/Contents/MacOS/Dash" },
    };
    expect(await stableAncestorIdentity(60001, psProcess(table))).toBe(`proc:60006:${started}`);
  });

  test("a walk that reaches launchd without a candidate answers nothing", async () => {
    const table: Table = {
      61001: { ppid: 61002, lstart: started, command: "/bin/sh -c x" },
      61002: { ppid: 1, lstart: started, command: "bash" },
    };
    expect(await stableAncestorIdentity(61001, psProcess(table))).toBeUndefined();
  });
});

describe("resolveCaller owner precedence", () => {
  test("an explicit MEGABRAIN_SESSION_ID wins over the ancestor", async () => {
    const caller = await resolveCaller({ MEGABRAIN_SESSION_ID: "dashboard-7" }, psProcess(runtimeTable(process.ppid)));
    expect(caller).toMatchObject({ id: "dashboard-7", host: "local" });
  });

  test("an agent session id wins over MEGABRAIN_SESSION_ID's absence and the ancestor", async () => {
    const caller = await resolveCaller({ CLAUDE_CODE_SESSION_ID: "abc" }, psProcess(runtimeTable(process.ppid)));
    expect(caller.id).toBe("claude:abc");
  });

  test("with no ids the owner is the stable ancestor, not the transient shell", async () => {
    const caller = await resolveCaller({}, psProcess(runtimeTable(process.ppid)));
    expect(caller).toMatchObject({ id: `proc:900001:${runtimeTable(1)[900001]?.lstart}`, host: "local" });
  });

  test("no ancestor falls back to the tty, then to no identity", async () => {
    const withTty: Table = { [process.ppid]: { ppid: 1, lstart: started, command: "zsh", tty: "ttys042" } };
    expect((await resolveCaller({}, psProcess(withTty))).id).toBe("shell:ttys042");
    const noTty: Table = { [process.ppid]: { ppid: 1, lstart: started, command: "zsh" } };
    expect((await resolveCaller({}, psProcess(noTty))).id).toBe("");
  });
});

describe("a dead local owner can be adopted", () => {
  async function seed(owner: string): Promise<{ root: string; id: string }> {
    const root = await mkdtemp(`${tmpdir()}/megabrain-stable-owner-`);
    const handle = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (handle.kind !== "ok") throw new Error(handle.error);
    const now = new Date().toISOString();
    createDispatch(handle.value, {
      dispatchId: "dispatch-stable-1", parentHost: "local", parentSessionId: owner, parentTerminalId: null, parentTmuxSession: null, parentTmuxPane: null,
      childHost: "tmux", terminalId: "tmux:s:%9", worktreePath: "/tmp/worktree", branch: "feat/x", agent: "codex", agentId: "codex",
      runtime: "tmux", tmuxSession: "s", tmuxPane: "%9", state: "running", processState: "running", terminalState: "owned",
      promptReceipt: "received", promptState: "confirmed", createdAt: now, updatedAt: now,
    });
    return { root, id: "dispatch-stable-1" };
  }
  const deadOwner = `proc:777777:${started}`;
  const alive = (pid: number, lstart: string): Table => ({ ...runtimeTable(process.ppid), [pid]: { ppid: 1, lstart, command: "Dash" } });

  test("adopt succeeds without --force when the owner process is gone", async () => {
    const { root, id } = await seed(deadOwner);
    const result = await executeOrchestrateAdopt([id, "--json"], { MEGABRAIN_STATE_DIR: root }, psProcess(runtimeTable(process.ppid)));
    expect(result.kind).toBe("ok");
    const handle = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (handle.kind !== "ok") throw new Error(handle.error);
    const stored = getDispatch(handle.value, id);
    expect(stored.kind === "ok" ? stored.value : undefined).toMatchObject({ parentSessionId: `proc:900001:${runtimeTable(1)[900001]?.lstart}` });
  });

  test("a recycled pid counts as gone", async () => {
    const { root, id } = await seed(deadOwner);
    const result = await executeOrchestrateAdopt([id], { MEGABRAIN_STATE_DIR: root }, psProcess(alive(777777, "Wed Oct 14 00:00:00 2026")));
    expect(result.kind).toBe("ok");
  });

  test("a live owner still needs --force", async () => {
    const { root, id } = await seed(deadOwner);
    const result = await executeOrchestrateAdopt([id], { MEGABRAIN_STATE_DIR: root }, psProcess(alive(777777, started)));
    expect(result.kind === "failed" ? result.error : "").toContain("--force");
  });

  test("the ownership refusal names adopt", async () => {
    const { root, id } = await seed(deadOwner);
    const result = await executeOrchestrateWatch([id, "--timeout", "0", "--json"], { MEGABRAIN_STATE_DIR: root, MEGABRAIN_SESSION_ID: "someone-else" }, psProcess(runtimeTable(process.ppid)));
    expect(result.kind === "failed" ? result.error : "").toContain(`megabrain orchestrate adopt ${id}`);
  });

  test("watch resolves the stable local owner from a fresh shell", async () => {
    const owner = `proc:900001:${runtimeTable(1)[900001]?.lstart}`;
    const { root, id } = await seed(owner);
    const result = await executeOrchestrateWatch([id, "--timeout", "0", "--json"], { MEGABRAIN_STATE_DIR: root }, psProcess(runtimeTable(process.ppid)));
    expect(result.kind).toBe("ok");
  });
});
