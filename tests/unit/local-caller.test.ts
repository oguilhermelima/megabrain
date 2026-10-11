import { guardedStateDatabase } from "./state-db-guard.js";
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { hasCallerIdentity, ownsDispatch, resolveCallerIdentity } from "../../src/core/context.js";
import { resolveCaller, appendMessage } from "../../src/cli/commands/queue-write.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { executeOrchestrateClose } from "../../src/cli/commands/orchestrate-close.js";
import { executeOrchestrateReply } from "../../src/cli/commands/orchestrate-reply.js";
import { executeOrchestrateWatch } from "../../src/cli/commands/orchestrate-parent.js";
import { executeHookTurnEnd } from "../../src/cli/commands/hook-turn-end.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { createDispatch, getDispatch } from "../../src/adapters/state-db.js";
import { composerTmux } from "./composer-tmux.js";

// A caller outside Orca, Superset and tmux is not unknown: its terminal is simply local, and the
// agent session it runs (or, failing that, its shell) is its identity.

type Call = Readonly<{ command: string; args: readonly string[] }>;
type Counted = ProcessAdapter & { readonly calls: readonly Call[]; readonly detached: number };

function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> = () => ok({ stdout: "", stderr: "", exitCode: 0 })): Counted {
  const calls: Call[] = [];
  const state = { detached: 0 };
  return {
    calls,
    get detached() { return state.detached; },
    async run(command, args) { calls.push({ command, args: [...args] }); return behavior(command, args); },
    async startDetached() { state.detached += 1; return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

const shellTty = "ttys042";
function plainShellProcess(): Counted {
  return fakeProcess((command, args) => {
    if (command === "ps" && args.includes("tty=")) return ok({ stdout: `${shellTty}\n`, stderr: "", exitCode: 0 });
    if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%41\n", stderr: "", exitCode: 0 });
    return ok({ stdout: "", stderr: "", exitCode: 0 });
  });
}

async function tempDir(prefix: string): Promise<string> { return mkdtemp(`${tmpdir()}/megabrain-local-${prefix}-`); }

function database(root: string) {
  const handle = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (handle.kind !== "ok") throw new Error(handle.error);
  return handle.value;
}

function localMeta(dispatchId: string, parentSessionId: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    dispatchId, parentHost: "local", parentSessionId, parentTerminalId: null, parentTmuxSession: null, parentTmuxPane: null,
    childHost: "tmux", terminalId: "tmux:s:%9", worktreePath: "/tmp/worktree", branch: "feat/local", agent: "claude", agentId: "claude",
    runtime: "tmux", tmuxSession: "s", tmuxPane: "%9", state: "running", processState: "running", terminalState: "owned",
    promptReceipt: "received", promptState: "confirmed", createdAt: now, updatedAt: now,
  };
}

describe("the resolver gives a caller with no terminal host the host local", () => {
  test("nothing set is local with no id, and still not an identity", () => {
    const identity = resolveCallerIdentity({});
    expect(identity).toEqual({ id: "", host: "local", terminalId: null, tmuxSession: null, tmuxPane: null });
    expect(hasCallerIdentity(identity)).toBe(false);
  });

  test("a Claude session without a terminal is local and identified by the session", () => {
    const identity = resolveCallerIdentity({ claudeCodeSessionId: "abc" });
    expect(identity).toMatchObject({ id: "claude:abc", host: "local" });
    expect(hasCallerIdentity(identity)).toBe(true);
  });

  test("a Codex thread without a terminal is local and identified by the thread", () => {
    expect(resolveCallerIdentity({ codexThreadId: "thr" })).toMatchObject({ id: "codex:thr", host: "local" });
  });

  test("with no agent id the shell identity from the probe is the id", () => {
    const identity = resolveCallerIdentity({}, { shellIdentity: "shell:ttys042" });
    expect(identity).toMatchObject({ id: "shell:ttys042", host: "local" });
    expect(hasCallerIdentity(identity)).toBe(true);
  });

  test("an agent session outranks the shell identity", () => {
    expect(resolveCallerIdentity({ claudeCodeSessionId: "abc" }, { shellIdentity: "shell:ttys042" }).id).toBe("claude:abc");
  });

  test("a terminal handle still wins over the shell identity", () => {
    expect(resolveCallerIdentity({ orcaTerminalHandle: "t1" }, { shellIdentity: "shell:ttys042" })).toMatchObject({ id: "t1", host: "orca" });
  });

  test("resolveCaller derives the shell identity from the controlling tty of its parent shell", async () => {
    const caller = await resolveCaller({}, plainShellProcess());
    expect(caller).toMatchObject({ id: `shell:${shellTty}`, host: "local" });
  });

  test("resolveCaller falls back to the shell pid when the shell has no tty", async () => {
    const caller = await resolveCaller({}, fakeProcess((command) => command === "ps" ? ok({ stdout: "??\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 })));
    expect(caller.host).toBe("local");
    expect(caller.id).toMatch(/^shell:pid[0-9]+$/);
  });

  test("a local caller owns its own local dispatch and nobody else's", () => {
    const caller = resolveCallerIdentity({ claudeCodeSessionId: "abc" });
    expect(ownsDispatch(caller, { parentHost: "local", parentSessionId: "claude:abc" })).toBe(true);
    expect(ownsDispatch(caller, { parentHost: "local", parentSessionId: "claude:other" })).toBe(false);
    expect(ownsDispatch(caller, { parentHost: "orca", parentSessionId: "claude:abc" })).toBe(false);
  });
});

describe("orchestrate spawn from a plain terminal", () => {
  async function spawnFrom(environment: Record<string, string>, process: Counted): Promise<{ result: Result<string>; root: string }> {
    const root = await tempDir("spawn");
    const worktree = await tempDir("worktree");
    const original = getTmux();
    registerTmux({ ...original, id: "tmux", ...composerTmux() });
    try {
      const result = await executeSpawn(
        ["--worktree", worktree, "--agent", "codex", "--prompt", "keep going", "--tmux", "true", "--json"],
        { MEGABRAIN_STATE_DIR: root, MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-local-1", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0", ...environment },
        process,
      );
      return { result, root };
    } finally { registerTmux(original); }
  }

  test("an agent session with no Orca, Superset or tmux variables spawns and is recorded as a local parent", async () => {
    const { result, root } = await spawnFrom({ CLAUDE_CODE_SESSION_ID: "abc" }, plainShellProcess());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(result.value)).toMatchObject({ deliveryChannel: "hook-and-watch" });
    const stored = getDispatch(database(root), "dispatch-local-1");
    expect(stored.kind === "ok" ? stored.value : undefined).toMatchObject({ parentHost: "local", parentSessionId: "claude:abc" });
  });

  test("with no agent id the dispatch is owned by the shell identity", async () => {
    const { result, root } = await spawnFrom({}, plainShellProcess());
    expect(result.kind).toBe("ok");
    const stored = getDispatch(database(root), "dispatch-local-1");
    expect(stored.kind === "ok" ? stored.value : undefined).toMatchObject({ parentHost: "local", parentSessionId: `shell:${shellTty}` });
  });

  test("a refusal never tells the operator to use Orca or Superset", async () => {
    const { result } = await spawnFrom({ MEGABRAIN_SESSION_HOST: "" }, fakeProcess(() => failed("no tmux")));
    if (result.kind === "failed") expect(result.error).not.toMatch(/Orca|Superset/);
  });
});

describe("parent verbs accept the local caller that spawned the dispatch", () => {
  const environment = (root: string): Record<string, string> => ({ MEGABRAIN_STATE_DIR: root, CLAUDE_CODE_SESSION_ID: "abc" });
  const notOwnership = (result: Result<string>): boolean => result.kind !== "failed" || !/is owned by|managed terminal identity/.test(result.error);

  test("watch", async () => {
    const root = await tempDir("watch");
    createDispatch(database(root), localMeta("dispatch-w1", "claude:abc"));
    expect(notOwnership(await executeOrchestrateWatch(["dispatch-w1", "--timeout", "0", "--json"], environment(root), plainShellProcess()))).toBe(true);
  });

  test("reply", async () => {
    const root = await tempDir("reply");
    createDispatch(database(root), localMeta("dispatch-r1", "claude:abc"));
    expect(notOwnership(await executeOrchestrateReply(["dispatch-r1", "--text", "go"], environment(root), plainShellProcess()))).toBe(true);
  });

  test("close", async () => {
    const root = await tempDir("close");
    createDispatch(database(root), localMeta("dispatch-c1", "claude:abc"));
    expect(notOwnership(await executeOrchestrateClose(["dispatch-c1", "--json"], environment(root), plainShellProcess()))).toBe(true);
  });

  test("a different local session is refused", async () => {
    const root = await tempDir("other");
    createDispatch(database(root), localMeta("dispatch-o1", "claude:someone-else"));
    const result = await executeOrchestrateWatch(["dispatch-o1", "--timeout", "0", "--json"], environment(root), plainShellProcess());
    expect(result.kind).toBe("failed");
  });
});

describe("the parent Stop hook surfaces mail for a local parent", () => {
  test("a child question is queued, never typed, and the hook blocks once with it", async () => {
    const root = await tempDir("hook");
    createDispatch(database(root), localMeta("dispatch-h1", "claude:abc"));
    const process = plainShellProcess();
    const env = { MEGABRAIN_STATE_DIR: root, HOME: root, MEGABRAIN_ROOT: root, CLAUDE_CODE_SESSION_ID: "abc" };
    const appended = await appendMessage(root, "dispatch-h1", "child", "ask", "which database?", "child-session", env, process);
    expect(appended.kind).toBe("ok");
    expect(process.detached).toBe(0);
    expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "send-keys")).toBe(false);

    const first = await executeHookTurnEnd([], env, process, async () => "");
    expect(first.kind).toBe("ok");
    const parsed = first.kind === "ok" ? JSON.parse(first.value) : {};
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("megabrain orchestrate watch dispatch-h1");

    const second = await executeHookTurnEnd([], env, process, async () => "");
    expect(second.kind === "ok" ? JSON.parse(second.value) : {}).toEqual({});
  });
});
