import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import {
  CALLER_IDENTITY_ENV_VARS,
  hasCallerIdentity,
  ownsDispatch,
  resolveCallerIdentity,
  resolveContext,
  type CallerEnvironment,
  type CallerIdentity,
} from "../../src/core/context.js";
import { callerEnvironment, executeQueueWrite, resolveCaller } from "../../src/cli/commands/queue-write.js";
import { executeContext } from "../../src/cli/commands/context.js";
import { executeSpawn, type SpawnDependencies, type SpawnWorktree } from "../../src/cli/commands/orchestrate-spawn.js";
import { executeOrchestrateClose } from "../../src/cli/commands/orchestrate-close.js";
import { executeOrchestrateLiveness, executeOrchestrateRead } from "../../src/cli/commands/orchestrate-read-liveness.js";
import { executeOrchestrateReply } from "../../src/cli/commands/orchestrate-reply.js";
import { executeOrchestrateReconcile, executeOrchestrateStop } from "../../src/cli/commands/orchestrate-stop-reconcile.js";
import { executeOrchestrateAck, executeOrchestrateWatch } from "../../src/cli/commands/orchestrate-parent.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";
import { callerFromEnvironment } from "../../src/cli/commands/orchestrate-list.js";
import { decorateDispatchRecord, parseDispatchRecord } from "../../src/core/dispatch.js";
import { tmuxCallerSession } from "../../src/cli/commands/orchestrate-prune.js";
import { callerSession as installDoctorCallerSession } from "../../src/cli/commands/install-doctor.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

type Call = Readonly<{ command: string; args: readonly string[] }>;

function fakeProcess(
  behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> = () => ok({ stdout: "", stderr: "", exitCode: 0 }),
): ProcessAdapter & { readonly calls: readonly Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return behavior(command, args);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return calls.length; },
  };
}

// A process that answers every `orca` subcommand this suite's verbs can reach, so ownership
// tests fail only on identity, never on a missing fixture. `childTerminalId` is the terminal the
// dispatch's *child* was assigned (unrelated to caller identity).
function orcaHostProcess(childTerminalId: string): ProcessAdapter & { readonly calls: readonly Call[] } {
  return fakeProcess((command, args) => {
    if (command === "orca" && args[0] === "terminal" && args[1] === "list") {
      return ok({ stdout: JSON.stringify({ result: { terminals: [{ handle: childTerminalId }] } }), stderr: "", exitCode: 0 });
    }
    if (command === "orca" && args[0] === "terminal" && args[1] === "read") {
      return ok({ stdout: JSON.stringify({ result: { text: "output" } }), stderr: "", exitCode: 0 });
    }
    return ok({ stdout: "{}", stderr: "", exitCode: 0 });
  });
}

async function tempStateDir(): Promise<string> {
  return mkdtemp(`${tmpdir()}/megabrain-caller-identity-`);
}

type JsonRecord = Record<string, unknown>;

// Mirrors the shape orchestrate-spawn's initialMeta produces, so verb fixtures look like a real
// dispatch rather than a hand-picked subset of fields.
function baseMeta(overrides: JsonRecord = {}): JsonRecord {
  const now = new Date().toISOString();
  return {
    dispatchId: "dispatch-1",
    parentHost: "orca",
    parentSessionId: "claude:test-uuid",
    parentTerminalId: null,
    parentWorkspaceId: null,
    parentTmuxSession: null,
    parentTmuxPane: null,
    childHost: "orca",
    workspaceId: null,
    terminalId: "child-term-1",
    worktreePath: "/tmp/worktree",
    branch: "feat/example",
    agent: "claude",
    agentId: "claude",
    model: "",
    effort: null,
    modelHonored: true,
    modelSubstitution: null,
    runtime: "host",
    spawnRuntime: "ide",
    tmuxSession: null,
    tmuxPane: null,
    label: "claude /tmp/worktree",
    chain: null,
    state: "running",
    promptDelivered: true,
    promptDelivery: "delivered",
    promptDeliveryReason: null,
    promptPublication: "published",
    promptTransport: "transported",
    promptReceipt: "received",
    promptState: "confirmed",
    processState: "running",
    terminalState: "owned",
    terminalReason: null,
    failureCount: 0,
    stage: null,
    reason: null,
    reconcileOutcome: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function writeDispatch(root: string, id: string, meta: JsonRecord): Promise<void> {
  const directory = `${root}/dispatches/${id}`;
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/meta.json`, `${JSON.stringify(meta)}\n`);
}

// The environment a structured Claude session (Orca, no terminal, no tmux) is measured to carry:
// ORCA_STRUCTURED_SESSION=1, CLAUDE_CODE_SESSION_ID set, nothing terminal-shaped.
function structuredClaudeEnvironment(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    MEGABRAIN_STATE_DIR: root,
    ORCA_STRUCTURED_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "test-uuid",
    ...extra,
  };
}

const identityRefusal = "this command requires a managed terminal identity; run it inside an Orca or Superset terminal";

function isOwnershipRefusal(result: Result<string>): boolean {
  return result.kind === "failed" && (result.error.includes(identityRefusal) || result.error.includes("is owned by"));
}

// ---------------------------------------------------------------------------
// The resolver precedence table
// ---------------------------------------------------------------------------

describe("resolveCallerIdentity", () => {
  test("nothing set resolves to unknown host and no id", () => {
    expect(resolveCallerIdentity({})).toEqual({ id: "", host: "unknown", terminalId: null, tmuxSession: null, tmuxPane: null });
  });

  test("MEGABRAIN_SESSION_ID is an explicit override that wins over every other source", () => {
    const environment: CallerEnvironment = {
      megabrainSessionId: "explicit-id",
      megabrainSessionHost: "orca",
      claudeCodeSessionId: "claude-uuid",
      codexThreadId: "codex-uuid",
      orcaTerminalHandle: "term-1",
      supersetTerminalId: "sup-1",
    };
    const identity = resolveCallerIdentity(environment);
    expect(identity.id).toBe("explicit-id");
    expect(identity.host).toBe("orca");
  });

  test("MEGABRAIN_SESSION_ID alone, with no host override, leaves the host to the next source", () => {
    const identity = resolveCallerIdentity({ megabrainSessionId: "explicit-id", orcaTerminalHandle: "term-1" });
    expect(identity).toEqual({ id: "explicit-id", host: "orca", terminalId: "term-1", tmuxSession: null, tmuxPane: null });
  });

  test("CLAUDE_CODE_SESSION_ID beats ORCA_TERMINAL_HANDLE for id, but the terminal still supplies the host and terminalId", () => {
    const identity = resolveCallerIdentity({ claudeCodeSessionId: "claude-uuid", orcaTerminalHandle: "term-1" });
    expect(identity).toEqual({ id: "claude:claude-uuid", host: "orca", terminalId: "term-1", tmuxSession: null, tmuxPane: null });
  });

  test("CODEX_THREAD_ID is used when no Claude session id is present", () => {
    const identity = resolveCallerIdentity({ codexThreadId: "thread-1", supersetTerminalId: "sup-1" });
    expect(identity).toEqual({ id: "codex:thread-1", host: "superset", terminalId: "sup-1", tmuxSession: null, tmuxPane: null });
  });

  test("Claude wins over Codex when both are somehow present", () => {
    const identity = resolveCallerIdentity({ claudeCodeSessionId: "claude-uuid", codexThreadId: "thread-1" });
    expect(identity.id).toBe("claude:claude-uuid");
  });

  test("a superset terminal handle wins over an orca terminal handle and a tmux pane", () => {
    const identity = resolveCallerIdentity(
      { supersetTerminalId: "sup-1", orcaTerminalHandle: "orca-1", tmux: "1", tmuxPane: "%1" },
      { tmuxSessionName: "work" },
    );
    expect(identity).toEqual({ id: "sup-1", host: "superset", terminalId: "sup-1", tmuxSession: null, tmuxPane: null });
  });

  test("an orca terminal handle wins over a tmux pane", () => {
    const identity = resolveCallerIdentity({ orcaTerminalHandle: "orca-1", tmux: "1", tmuxPane: "%1" }, { tmuxSessionName: "work" });
    expect(identity).toEqual({ id: "orca-1", host: "orca", terminalId: "orca-1", tmuxSession: null, tmuxPane: null });
  });

  test("the tmux fallback resolves id and host from the probed session name", () => {
    const identity = resolveCallerIdentity({ tmux: "1", tmuxPane: "%4" }, { tmuxSessionName: "work" });
    expect(identity).toEqual({ id: "work:%4", host: "tmux", terminalId: "work:%4", tmuxSession: "work", tmuxPane: "%4" });
  });

  test("tmux present without a probed session name resolves to nothing (never guesses a bare host)", () => {
    const identity = resolveCallerIdentity({ tmux: "1", tmuxPane: "%4" });
    expect(identity).toEqual({ id: "", host: "unknown", terminalId: null, tmuxSession: null, tmuxPane: null });
  });

  test("a structured Orca session (ORCA_STRUCTURED_SESSION=1) resolves host orca with no id", () => {
    const identity = resolveCallerIdentity({ orcaStructuredSession: "1" });
    expect(identity).toEqual({ id: "", host: "orca", terminalId: null, tmuxSession: null, tmuxPane: null });
  });

  test("the orca worktree probe alone (no env marker) resolves host orca with no id", () => {
    const identity = resolveCallerIdentity({}, { orcaWorktree: true });
    expect(identity).toEqual({ id: "", host: "orca", terminalId: null, tmuxSession: null, tmuxPane: null });
  });

  test("a structured session combined with an agent session id gives both a stable id and host orca", () => {
    const identity = resolveCallerIdentity({ orcaStructuredSession: "1", claudeCodeSessionId: "claude-uuid" });
    expect(identity).toEqual({ id: "claude:claude-uuid", host: "orca", terminalId: null, tmuxSession: null, tmuxPane: null });
  });

  test("a terminal handle wins over a bare structured-session marker for host", () => {
    const identity = resolveCallerIdentity({ orcaStructuredSession: "1", orcaTerminalHandle: "term-1" });
    expect(identity.host).toBe("orca");
    expect(identity.terminalId).toBe("term-1");
  });

  test("ORCA_STRUCTURED_SESSION must be exactly \"1\"", () => {
    expect(resolveCallerIdentity({ orcaStructuredSession: "true" }).host).toBe("unknown");
    expect(resolveCallerIdentity({ orcaStructuredSession: "0" }).host).toBe("unknown");
  });
});

describe("hasCallerIdentity", () => {
  test("a stable id counts as an identity", () => {
    expect(hasCallerIdentity({ id: "x", host: "orca", terminalId: null, tmuxSession: null, tmuxPane: null })).toBe(true);
  });
  test("a terminal handle alone counts as an identity", () => {
    expect(hasCallerIdentity({ id: "", host: "orca", terminalId: "term-1", tmuxSession: null, tmuxPane: null })).toBe(true);
  });
  test("neither counts as no identity at all", () => {
    expect(hasCallerIdentity({ id: "", host: "unknown", terminalId: null, tmuxSession: null, tmuxPane: null })).toBe(false);
  });
  test("host orca with no id (a bare structured session) is still no identity", () => {
    expect(hasCallerIdentity({ id: "", host: "orca", terminalId: null, tmuxSession: null, tmuxPane: null })).toBe(false);
  });
});

describe("ownsDispatch", () => {
  test("a matching stable id owns the dispatch", () => {
    const caller: CallerIdentity = { id: "claude:new", host: "orca", terminalId: "term-1", tmuxSession: null, tmuxPane: null };
    expect(ownsDispatch(caller, { parentHost: "orca", parentSessionId: "claude:new" })).toBe(true);
  });

  test("a legacy record owned by a terminal handle is accepted from that terminal even once the caller's agent session id has changed", () => {
    const caller: CallerIdentity = { id: "claude:new-session", host: "orca", terminalId: "term-1", tmuxSession: null, tmuxPane: null };
    expect(ownsDispatch(caller, { parentHost: "orca", parentSessionId: "term-1" })).toBe(true);
  });

  test("a different session (different id and different terminal) is refused", () => {
    const caller: CallerIdentity = { id: "claude:other", host: "orca", terminalId: "term-2", tmuxSession: null, tmuxPane: null };
    expect(ownsDispatch(caller, { parentHost: "orca", parentSessionId: "term-1" })).toBe(false);
  });

  test("host must also agree, even when the id matches", () => {
    const caller: CallerIdentity = { id: "term-1", host: "superset", terminalId: "term-1", tmuxSession: null, tmuxPane: null };
    expect(ownsDispatch(caller, { parentHost: "orca", parentSessionId: "term-1" })).toBe(false);
  });

  test("a caller with no identity at all never owns anything, even an unowned-looking record", () => {
    const caller: CallerIdentity = { id: "", host: "orca", terminalId: null, tmuxSession: null, tmuxPane: null };
    expect(ownsDispatch(caller, { parentHost: "orca", parentSessionId: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// context and spawn agree
// ---------------------------------------------------------------------------

describe("context and spawn agree for the same environment", () => {
  test("resolveContext and resolveCaller (used by spawn and every verb) resolve a structured session identically", async () => {
    const environment: CallerEnvironment = { orcaStructuredSession: "1", claudeCodeSessionId: "test-uuid" };
    const contextResult = resolveContext(environment, { orcaWorktree: false });
    const spawnCaller = resolveCallerIdentity(environment);
    expect(contextResult.host).toBe(spawnCaller.host);
    expect(contextResult.terminalId).toBe(spawnCaller.terminalId);
  });

  test("megabrain context and orchestrate spawn agree end to end on host for a structured session", async () => {
    const rawEnvironment: Record<string, string> = { ORCA_STRUCTURED_SESSION: "1", CLAUDE_CODE_SESSION_ID: "test-uuid" };
    // context's probe (`orca worktree current`) must not itself decide the answer here — make it
    // fail so agreement is driven purely by ORCA_STRUCTURED_SESSION, the same source spawn reads.
    const contextProcess = fakeProcess(() => failed("orca: not found"));
    const contextOutput = await executeContext(["--json"], rawEnvironment, contextProcess);
    expect(contextOutput.kind).toBe("ok");
    const contextJson = contextOutput.kind === "ok" ? JSON.parse(contextOutput.value) : undefined;

    const spawnCaller = await resolveCaller(rawEnvironment, fakeProcess());
    expect(contextJson.host).toBe(spawnCaller.host);
    expect(contextJson.terminalId).toBe(spawnCaller.terminalId);
  });

  test("resolveCaller (spawn's caller resolution) is the same function callerEnvironment feeds every verb", () => {
    const rawEnvironment: Record<string, string> = { ORCA_TERMINAL_HANDLE: "term-1" };
    const mapped = callerEnvironment(rawEnvironment);
    expect(resolveCallerIdentity(mapped)).toEqual({ id: "term-1", host: "orca", terminalId: "term-1", tmuxSession: null, tmuxPane: null });
  });
});

// ---------------------------------------------------------------------------
// Every parent verb accepts the structured-session caller that spawned the dispatch
// ---------------------------------------------------------------------------

describe("parent verbs accept the structured-session caller that spawned the dispatch", () => {
  test("close", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateClose(["dispatch-1", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("read", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateRead(["dispatch-1", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("liveness", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateLiveness(["dispatch-1", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("reply", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateReply(["dispatch-1", "--text", "hello", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("stop", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateStop(["dispatch-1", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("reconcile", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateReconcile(["dispatch-1", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("watch", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const result = await executeOrchestrateWatch(["dispatch-1", "--timeout", "0", "--json"], structuredClaudeEnvironment(root));
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("ack", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    // No delivery exists yet; the point is that ownership is accepted before that check runs.
    const result = await executeOrchestrateAck(["dispatch-1", "delivery-1", "--json"], structuredClaudeEnvironment(root), process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });
});

describe("a legacy record owned by a terminal handle is still accepted from that terminal", () => {
  test("close accepts a caller whose agent session id changed but whose orca terminal did not", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta({ parentHost: "orca", parentSessionId: "term-legacy", parentTerminalId: null }));
    const process = orcaHostProcess("child-term-1");
    const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "term-legacy", CLAUDE_CODE_SESSION_ID: "brand-new-session" };
    const result = await executeOrchestrateClose(["dispatch-1", "--json"], environment, process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });

  test("reply accepts the same legacy caller", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta({ parentHost: "orca", parentSessionId: "term-legacy" }));
    const process = orcaHostProcess("child-term-1");
    const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "term-legacy", CLAUDE_CODE_SESSION_ID: "brand-new-session" };
    const result = await executeOrchestrateReply(["dispatch-1", "--text", "hi", "--json"], environment, process);
    expect(isOwnershipRefusal(result)).toBe(false);
  });
});

describe("a different session is refused", () => {
  test("close refuses a caller with a different terminal and a different agent session", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta({ parentHost: "orca", parentSessionId: "term-legacy" }));
    const process = orcaHostProcess("child-term-1");
    const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "term-other" };
    const result = await executeOrchestrateClose(["dispatch-1", "--json"], environment, process);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("is owned by");
  });

  test("a caller with no identity at all is refused with the same message every verb uses", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "dispatch-1", baseMeta());
    const process = orcaHostProcess("child-term-1");
    const result = await executeOrchestrateClose(["dispatch-1", "--json"], { MEGABRAIN_STATE_DIR: root }, process);
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toBe(identityRefusal);
  });
});

// ---------------------------------------------------------------------------
// F: a tmux spawn from an unknown caller host must refuse, not record an empty owner
// ---------------------------------------------------------------------------

describe("spawn refuses a tmux spawn from an unknown caller host", () => {
  function spawnDependencies(worktreePath: string): SpawnDependencies {
    const resolved: SpawnWorktree = { path: worktreePath, branch: "feat/example", ownership: "existing", workspaceId: null };
    return { resolveWorktree: async () => ok(resolved) };
  }

  test("refuses before creating a tmux session or a dispatch record", async () => {
    const root = await tempStateDir();
    const worktree = await mkdtemp(`${tmpdir()}/megabrain-caller-identity-worktree-`);
    const process = fakeProcess();
    const environment = { MEGABRAIN_STATE_DIR: root, MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-f" };
    const result = await executeSpawn(
      ["--worktree", worktree, "--agent", "claude", "--prompt", "hello", "--tmux", "true"],
      environment,
      process,
      spawnDependencies(worktree),
    );
    expect(result.kind).toBe("failed");
    expect(process.calls.some((call) => call.command === "tmux")).toBe(false);
  });

  test("an explicit MEGABRAIN_SESSION_HOST still allows the tmux spawn to proceed past the identity check", async () => {
    const root = await tempStateDir();
    const worktree = await mkdtemp(`${tmpdir()}/megabrain-caller-identity-worktree-`);
    // capture-pane must answer with an idle composer, or waitForTmuxReadiness polls for the full
    // default timeout and the test times out on infrastructure unrelated to the assertion below.
    const process = fakeProcess((command, args) => {
      if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%1\n", stderr: "", exitCode: 0 });
      if (command === "tmux" && args[0] === "capture-pane") return ok({ stdout: "❯\n", stderr: "", exitCode: 0 });
      if (command === "tmux") return ok({ stdout: "%1\n", stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    const environment = {
      MEGABRAIN_STATE_DIR: root,
      MEGABRAIN_SPAWN_DISPATCH_ID: "dispatch-g",
      MEGABRAIN_SESSION_ID: "parent-1",
      MEGABRAIN_SESSION_HOST: "orca",
      MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      MEGABRAIN_AGENT_READY_TIMEOUT_MS: "50",
    };
    const result = await executeSpawn(
      ["--worktree", worktree, "--agent", "claude", "--prompt", "hello", "--tmux", "true"],
      environment,
      process,
      spawnDependencies(worktree),
    );
    // Whatever the eventual outcome, it must not be the F refusal — a known caller host is not an
    // unknown one.
    if (result.kind === "failed") expect(result.error).not.toContain("unknown caller host");
    expect(process.calls.some((call) => call.command === "tmux")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A child must not inherit its parent's caller identity (tmux copies the spawner's whole
// environment into a new pane; a host terminal's shell can too).
// ---------------------------------------------------------------------------

describe("spawn starts children without the parent's identity", () => {
  test("clears every caller-identity variable on the tmux launch line", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-caller-identity-tmux-clear-`);
    const dispatchId = "dispatch-clear-tmux";
    const commandTexts: string[] = [];
    const original = getTmux();
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async (_pane, text) => { commandTexts.push(text); return ok(undefined); },
      sendKey: async () => ok(undefined),
    });
    const worktree: SpawnWorktree = { path: "/work/tree", branch: "feat/example", ownership: "existing", workspaceId: null };
    const process = fakeProcess((command, args) => command === "tmux" && args[0] === "list-panes" ? ok({ stdout: "%1\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
    try {
      await executeSpawn(
        ["--worktree", "/work/tree", "--agent", "claude", "--prompt", "hi", "--tmux", "true"],
        {
          MEGABRAIN_STATE_DIR: root,
          MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId,
          MEGABRAIN_SESSION_ID: "parent-1",
          MEGABRAIN_SESSION_HOST: "orca",
          MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
          MEGABRAIN_AGENT_READY_TIMEOUT_MS: "50",
        },
        process,
        { resolveWorktree: async () => ok(worktree) },
      );
      const commandText = commandTexts.find((text) => !text.startsWith("[megabrain dispatch")) ?? "";
      expect(commandText).not.toBe("");
      for (const name of CALLER_IDENTITY_ENV_VARS) expect(commandText).toContain(`-u ${name}`);
      expect(commandText).toContain("MEGABRAIN_STATE_DIR=");
      expect(commandText).toContain("MEGABRAIN_DISPATCH_ID=");
      expect(commandText).toContain("MEGABRAIN_TMUX_SESSION=");
      expect(commandText).toContain("MEGABRAIN_TMUX_PANE=");
    } finally {
      registerTmux(original);
    }
  });

  test("clears every caller-identity variable on the host --command launch line", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-caller-identity-host-clear-`);
    const dispatchId = "dispatch-clear-host";
    const worktree: SpawnWorktree = { path: "/work/tree", branch: "feat/example", ownership: "existing", workspaceId: null };
    const process = fakeProcess((command, args) => {
      if (command === "orca" && args[0] === "terminal" && args[1] === "create") {
        return ok({ stdout: JSON.stringify({ handle: "child-terminal" }), stderr: "", exitCode: 0 });
      }
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    });
    await executeSpawn(
      ["--worktree", "/work/tree", "--agent", "claude", "--prompt", "hi", "--tmux", "false"],
      {
        MEGABRAIN_STATE_DIR: root,
        MEGABRAIN_SPAWN_DISPATCH_ID: dispatchId,
        MEGABRAIN_SESSION_ID: "parent-1",
        MEGABRAIN_SESSION_HOST: "orca",
        MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0",
      },
      process,
      { resolveWorktree: async () => ok(worktree) },
    );
    const sendCall = process.calls.find((call) => call.command === "orca" && call.args[0] === "terminal" && call.args[1] === "send" && call.args.some((arg) => arg.includes("MEGABRAIN_DISPATCH_ID")));
    const text = sendCall?.args[sendCall.args.indexOf("--text") + 1] ?? "";
    expect(text).not.toBe("");
    for (const name of CALLER_IDENTITY_ENV_VARS) expect(text).toContain(`-u ${name}`);
    expect(text).toContain("MEGABRAIN_STATE_DIR=");
    expect(text).toContain("MEGABRAIN_DISPATCH_ID=");
    expect(text).toContain("ORCA_TERMINAL_HANDLE='child-terminal'");
  });
});

// ---------------------------------------------------------------------------
// The remaining hand-rolled chains: orchestrate list, the dispatch owner filter, prune and
// install-doctor's own-pane safety checks.
// ---------------------------------------------------------------------------

describe("orchestrate list recognises a structured session as its own caller", () => {
  test("callerFromEnvironment resolves a structured Claude session instead of unknown", async () => {
    const environment = { ORCA_STRUCTURED_SESSION: "1", CLAUDE_CODE_SESSION_ID: "test-uuid" };
    const identity = await callerFromEnvironment(environment, fakeProcess());
    expect(identity).toEqual({ id: "claude:test-uuid", host: "orca" });
  });

  test("a dispatch spawned by that structured session is reported owned", async () => {
    const caller = await callerFromEnvironment({ ORCA_STRUCTURED_SESSION: "1", CLAUDE_CODE_SESSION_ID: "test-uuid" }, fakeProcess());
    const record = parseDispatchRecord({ dispatchId: "d", parentSessionId: "claude:test-uuid", parentHost: "orca", state: "running", processState: "running", terminalState: "owned" });
    expect(record.kind).toBe("ok");
    if (record.kind !== "ok") return;
    expect(decorateDispatchRecord(record.value, caller).ownedByCaller).toBe(true);
  });

  test("a dispatch spawned by a different session is not reported owned", async () => {
    const caller = await callerFromEnvironment({ ORCA_STRUCTURED_SESSION: "1", CLAUDE_CODE_SESSION_ID: "test-uuid" }, fakeProcess());
    const record = parseDispatchRecord({ dispatchId: "d", parentSessionId: "claude:other-uuid", parentHost: "orca", state: "running", processState: "running", terminalState: "owned" });
    expect(record.kind).toBe("ok");
    if (record.kind !== "ok") return;
    expect(decorateDispatchRecord(record.value, caller).ownedByCaller).toBe(false);
  });
});

describe("prune and doctor route their own-pane check through the shared resolver", () => {
  test("tmuxCallerSession resolves the probed session for a plain tmux caller", async () => {
    const environment = { TMUX: "server", TMUX_PANE: "%4" };
    const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message" ? ok({ stdout: "work\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
    expect(await tmuxCallerSession(environment, process)).toBe("work");
  });

  test("callerSession (install-doctor) resolves the same probed session", async () => {
    const environment = { TMUX: "server", TMUX_PANE: "%4" };
    const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message" ? ok({ stdout: "work\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
    expect(await installDoctorCallerSession(environment, process)).toBe("work");
  });

  // MEASURED regression (tests/test-dispatch-transcript.sh, container suite): a caller with
  // SUPERSET_TERMINAL_ID set (the parent's own identity override) who is ALSO physically running
  // inside a tmux pane must still be recognised as "in that pane" by these two physical checks —
  // an identity override must never suppress the probe. Before the fix this returned undefined/""
  // instead of the real pane session, and prune then treated the caller's own pane as safe to
  // release.
  test("tmuxCallerSession still probes when a terminal-handle override is also present", async () => {
    const environment = { TMUX: "caller-server", TMUX_PANE: "%0", SUPERSET_TERMINAL_ID: "parent-terminal" };
    const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message" ? ok({ stdout: "caller-session\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
    expect(await tmuxCallerSession(environment, process)).toBe("caller-session");
  });

  test("callerSession (install-doctor) still probes when a terminal-handle override is also present", async () => {
    const environment = { TMUX: "caller-server", TMUX_PANE: "%0", SUPERSET_TERMINAL_ID: "parent-terminal" };
    const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message" ? ok({ stdout: "caller-session\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
    expect(await installDoctorCallerSession(environment, process)).toBe("caller-session");
  });
});

// ---------------------------------------------------------------------------
// MEASURED regression (tests/test-queue-write-cli.sh, container suite): queue-write's own child
// self-identification historically probed tmux with `list-panes -a`, not `display-message`
// (unlike close/child-ack, which always used display-message) — a real deployment's minimal tmux
// fixture only answers list-panes. Routing this through the shared resolver's display-message-only
// probe silently dropped that fallback.
// ---------------------------------------------------------------------------

describe("a queue-write child resolves its own tmux session via list-panes when display-message is unavailable", () => {
  test("received finds its dispatch through tmux list-panes -a", async () => {
    const root = await tempStateDir();
    await writeDispatch(root, "tmux-target", {
      dispatchId: "tmux-target",
      runtime: "tmux",
      tmuxSession: "session-a",
      tmuxPane: "%1",
      state: "running",
      processState: "running",
    });
    // Mirrors the shell test's fake tmux binary exactly: only list-panes is implemented;
    // display-message (and everything else) answers with empty output.
    const process = fakeProcess((command, args) => command === "tmux" && args[0] === "list-panes" ? ok({ stdout: "session-a\t%1\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await executeQueueWrite("received", [], { MEGABRAIN_STATE_DIR: root, TMUX: "managed", TMUX_PANE: "%1" }, process);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.value).toContain("tmux-target");
  });
});

// The same self-attribution bug the turn-end hook has (findChild matching a tmux dispatch's
// terminalId/childHost against the caller that spawned it, which used to equal the caller's own
// identity) affects `megabrain done` identically, since it goes through the same findChild.
describe("megabrain done from the parent that spawned a tmux dispatch is not attributed to the child", () => {
  test("done refuses to attach to a dispatch the coordinator only parents, not is", async () => {
    const root = await tempStateDir();
    const original = getTmux();
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async () => ok(undefined),
      sendKey: async () => ok(undefined),
      capturePane: async () => ok("› Ask Codex to do anything"),
    });
    try {
      const worktreeDir = await mkdtemp(`${tmpdir()}/megabrain-done-no-self-worktree-`);
      const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" };
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%41\n", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      const spawnResult = await executeSpawn(["--worktree", worktreeDir, "--agent", "codex", "--prompt", "keep going", "--tmux", "true", "--json"], environment, process);
      expect(spawnResult.kind).toBe("ok");
      // The coordinator (still the same ORCA_TERMINAL_HANDLE, having spawned but never having run
      // inside the child's own tmux pane) must not be able to call itself done on that dispatch.
      const doneResult = await executeQueueWrite("done", ["finished"], environment, process);
      expect(doneResult.kind).toBe("failed");
      if (doneResult.kind !== "failed") return;
      expect(doneResult.error).toBe("no managed dispatch belongs to orca/coord-orca-term");
    } finally {
      registerTmux(original);
    }
  });
});
