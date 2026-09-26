import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeHookTurnEnd, type HookEnvironment } from "../../src/cli/commands/hook-turn-end.js";
import { appendMessage } from "../../src/cli/commands/queue-write.js";
import { executeChainRun } from "../../src/cli/commands/chain-run.js";
import { executeSpawn } from "../../src/cli/commands/orchestrate-spawn.js";
import { getTmux, registerTmux } from "../../src/hosts/tmux.js";

type Call = Readonly<{ command: string; args: readonly string[] }>;
type Behavior = (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>>;

function fakeProcess(behavior: Behavior = () => ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter & { readonly calls: readonly Call[] } {
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

async function withRoot<T>(prefix: string, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(`${tmpdir()}/megabrain-hook-${prefix}-`);
  try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function environment(root: string, extra: Record<string, string | undefined> = {}): HookEnvironment {
  return { MEGABRAIN_STATE_DIR: root, HOME: root, MEGABRAIN_ROOT: root, ...extra };
}

async function writeMeta(root: string, dispatchId: string, meta: Record<string, unknown>): Promise<void> {
  const directory = join(root, "dispatches", dispatchId);
  await mkdir(directory, { recursive: true });
  await mkdir(join(directory, "messages"), { recursive: true });
  await mkdir(join(directory, "deliveries"), { recursive: true });
  await writeFile(join(directory, "meta.json"), JSON.stringify({ dispatchId, ...meta }));
}

async function readMeta(root: string, dispatchId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, "dispatches", dispatchId, "meta.json"), "utf8"));
}

const noStdin = async (): Promise<string> => "";

// A dispatch this session is the CHILD of: matches findChild's superset terminal-identity branch.
const childBase = { childHost: "superset", terminalId: "child-term", parentSessionId: "coordinator", parentHost: "superset" };
const childEnv = (root: string, extra: Record<string, string | undefined> = {}) => environment(root, { SUPERSET_TERMINAL_ID: "child-term", ...extra });

// A dispatch this session PARENTS: matches the hook's own require-parent equality check. Uses
// Orca as the parent host (not Superset) so sendParentPointer's host branch needs no workspace id.
const parentedBase = { childHost: "orca", terminalId: "other-term", parentSessionId: "coord-term", parentHost: "orca" };
const parentEnv = (root: string, extra: Record<string, string | undefined> = {}) => environment(root, { ORCA_TERMINAL_HANDLE: "coord-term", ...extra });

describe("executeHookTurnEnd: not inside an orchestrated terminal", () => {
  test("finishes with the default response when neither Superset nor Orca terminal identity is set", async () => {
    const result = await executeHookTurnEnd([], environment("/does-not-matter"), fakeProcess(), noStdin);
    expect(result).toEqual({ kind: "ok", value: "{}\n" });
  });

  test("uses the cursor continue response even with no terminal identity", async () => {
    const result = await executeHookTurnEnd([], environment("/does-not-matter", { MEGABRAIN_HOOK_AGENT: "cursor" }), fakeProcess(), noStdin);
    expect(result).toEqual({ kind: "ok", value: '{"continue":true}\n' });
  });
});

describe("executeHookTurnEnd: parent-notify scan (this session is not itself a dispatch child)", () => {
  test("is a no-op with no dispatches at all", async () => {
    await withRoot("no-dispatches", async (root) => {
      await mkdir(join(root, "dispatches"), { recursive: true });
      const result = await executeHookTurnEnd([], parentEnv(root), fakeProcess(), noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
    });
  });

  test("nudges the parent once for a single finished dispatch that still owns its terminal", async () => {
    await withRoot("done-single", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, state: "done", terminalState: "owned" });
      const process = fakeProcess((command, args) => {
        if (command === "orca" && args[0] === "terminal" && args[1] === "send") return ok({ stdout: "{}", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      const result = await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
      const send = process.calls.find((call) => call.command === "orca" && call.args.includes("send"));
      expect(send?.args).toContain("dispatch d1 finished but still owns its terminal; run megabrain orchestrate close d1");
    });
  });

  test("batches several finished dispatches into one nudge naming every id", async () => {
    await withRoot("done-many", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, state: "done", terminalState: "owned" });
      await writeMeta(root, "d2", { ...parentedBase, state: "done", terminalState: "owned" });
      const process = fakeProcess((command, args) => {
        if (command === "orca" && args[0] === "terminal" && args[1] === "send") return ok({ stdout: "{}", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      const sends = process.calls.filter((call) => call.command === "orca" && call.args.includes("send"));
      expect(sends).toHaveLength(1);
      expect(sends[0]?.args).toContain("2 finished dispatches still own terminals: d1, d2; run megabrain orchestrate close <id> for each");
    });
  });

  test("does not nudge for a finished dispatch that already released its terminal", async () => {
    await withRoot("done-released", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, state: "done", terminalState: "released" });
      const process = fakeProcess();
      await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      expect(process.calls.some((call) => call.args.includes("send"))).toBe(false);
    });
  });

  test("ignores a dispatch parented by a different session", async () => {
    await withRoot("not-mine", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, parentSessionId: "someone-else", state: "done", terminalState: "owned" });
      const process = fakeProcess();
      await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      expect(process.calls.some((call) => call.args.includes("send"))).toBe(false);
    });
  });

  test("suppresses the nudge while a watcher is actively polling the dispatch", async () => {
    await withRoot("active-waiter", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, state: "done", terminalState: "owned" });
      await mkdir(join(root, "dispatches", "d1"), { recursive: true });
      await writeFile(join(root, "dispatches", "d1", "waiter.json"), JSON.stringify({ pid: process.pid, parentSessionId: "coord-term", parentHost: "orca" }));
      const fake = fakeProcess();
      await executeHookTurnEnd([], parentEnv(root), fake, noStdin);
      expect(fake.calls.some((call) => call.args.includes("send"))).toBe(false);
    });
  });

  test("marks an open dispatch limit-refused when its pane shows the usage-limit marker", async () => {
    await withRoot("limit-refused", async (root) => {
      await writeMeta(root, "d1", {
        ...parentedBase, state: "running", processState: "running", runtime: "tmux", tmuxPane: "%9",
        chain: null,
      });
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "capture-pane") {
          return ok({ stdout: "You've hit your usage limit for this model.\nSwitch to another model now, or wait.\n", stderr: "", exitCode: 0 });
        }
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      const meta = await readMeta(root, "d1");
      expect(meta.state).toBe("failed");
      expect(meta.processState).toBe("failed");
      expect(meta.reconcileOutcome).toBe("limit-refused");
      expect(meta.reason).toBe("agent refused the dispatch: You've hit your usage limit for");
    });
  });

  test("leaves an open dispatch untouched when its pane shows no usage-limit marker", async () => {
    await withRoot("no-refusal", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, state: "running", processState: "running", runtime: "tmux", tmuxPane: "%9" });
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "capture-pane") return ok({ stdout: "still working on it\n", stderr: "", exitCode: 0 });
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      const meta = await readMeta(root, "d1");
      expect(meta.state).toBe("running");
      expect(meta.reconcileOutcome ?? null).toBeNull();
    });
  });

  test("never checks for a refusal once the child has confirmed its prompt receipt", async () => {
    await withRoot("has-receipt", async (root) => {
      await writeMeta(root, "d1", { ...parentedBase, state: "running", processState: "running", runtime: "tmux", tmuxPane: "%9" });
      await appendMessage(root, "d1", "child", "received", "prompt received", "child-term", parentEnv(root), fakeProcess());
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "capture-pane") {
          return ok({ stdout: "You've hit your usage limit for this model.\nSwitch to another model now, or wait.\n", stderr: "", exitCode: 0 });
        }
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      await executeHookTurnEnd([], parentEnv(root), process, noStdin);
      expect(process.calls.some((call) => call.command === "tmux" && call.args[0] === "capture-pane")).toBe(false);
      const meta = await readMeta(root, "d1");
      expect(meta.state).toBe("running");
    });
  });

  // The whole path, end to end: a chain-run dispatch carries real chain context
  // (writeDispatchChainContext, chain-run.ts), its pane then shows a usage-limit refusal, the
  // turn-end hook (as the dispatch's parent) detects it, marks the dispatch limit-refused, and
  // resumes the chain in-process — never shelling out to the compiled binary — spawning the next
  // step with the same prompt and runtime, through the real orchestrate spawn. Before the fix
  // this could never happen at all: meta.chain was always null (nothing wrote it), and even with
  // chain context present, continueRefusedChain's old "tmux"/"host" -> --tmux mapping made the
  // resumed spawn fail on "--tmux requires true or false" every time.
  //
  // Step 1 (the original chain run) uses a fake spawn dependency that writes its own dispatch
  // meta directly, rather than the real orchestrate spawn: a real tmux spawn from a non-tmux
  // caller (ORCA_TERMINAL_HANDLE here) records the CHILD's terminalId/childHost as the CALLER's
  // own identity (src/cli/commands/orchestrate-spawn.ts's initialMeta — a preexisting property of
  // spawn unrelated to this fix), which would make findChild match this coordinator as the
  // dispatch's own child instead of its parent, since it has never actually run inside that
  // dispatch's tmux pane. The fake spawn mirrors this test's realistic intent (a distinct child
  // identity) while still exercising the real chain selection, walkChainSteps, and
  // writeDispatchChainContext. Step 2 (the resumed spawn, inside continueRefusedChain) goes
  // through the real orchestrate spawn, since that is exactly what this test verifies.
  test("resumes a refused chain-run dispatch on the next step, in-process, with the same prompt and runtime", async () => {
    const original = getTmux();
    let nextPane = 20;
    let refusedPane: string | undefined;
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async () => ok(undefined),
      sendKey: async () => ok(undefined),
      capturePane: async (pane) => (pane === refusedPane ? ok("You've hit your usage limit for this model.\nSwitch to another model now, or wait.\n") : ok("› Ask Codex to do anything")),
    });
    try {
      await withRoot("chain-continue-e2e", async (root) => {
        await writeFile(join(root, "chains.json"), JSON.stringify({ chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }, { agent: "codex", model: "m2" }] }));  // both codex: agy has no tmux liveness classifier (src/agents/agy.ts), irrelevant here
        const worktreeDir = await mkdtemp(`${tmpdir()}/megabrain-hook-chain-worktree-`);
        try {
          const resolvedWorktree = await realpath(worktreeDir);
          const hookEnvironment = environment(root, { ORCA_TERMINAL_HANDLE: "coord-term", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" });
          const process = fakeProcess((command, args) => {
            if (command === "git" && args.includes("--show-toplevel")) return ok({ stdout: `${resolvedWorktree}\n`, stderr: "", exitCode: 0 });
            if (command === "git" && args.includes("symbolic-ref")) return ok({ stdout: "feat/chain\n", stderr: "", exitCode: 0 });
            if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: `%${nextPane++}\n`, stderr: "", exitCode: 0 });
            return ok({ stdout: "", stderr: "", exitCode: 0 });
          });

          // Step 1: a chain run, faking only the spawn (see WHY above) so the first step's
          // dispatch has a realistic, distinct child identity.
          const firstDispatchId = "dispatch-1-codex";
          const fakeSpawn = async (): Promise<Result<string>> => {
            const pane = `%${nextPane++}`;
            await writeMeta(root, firstDispatchId, {
              parentSessionId: "coord-term", parentHost: "orca", childHost: "tmux", terminalId: `${firstDispatchId}-terminal`,
              worktreePath: resolvedWorktree, agent: "codex", model: "m1", runtime: "tmux", tmuxSession: `megabrain-${firstDispatchId}`, tmuxPane: pane,
              state: "spawning", processState: "starting", label: null,
            });
            return ok(JSON.stringify({ dispatchId: firstDispatchId }));
          };
          const runResult = await executeChainRun(["--worktree", worktreeDir, "--prompt", "keep going", "--tmux", "true", "--json"], hookEnvironment, process, { spawn: fakeSpawn });
          expect(runResult.kind).toBe("ok");
          if (runResult.kind !== "ok") return;
          const firstMeta = await readMeta(root, firstDispatchId);
          expect(firstMeta).toMatchObject({ agent: "codex", runtime: "tmux", worktreePath: resolvedWorktree });
          expect(firstMeta.chain).toMatchObject({ name: "defaultSteps", step: 1, total: 2, usedDefault: true, prompt: "keep going" });
          refusedPane = firstMeta.tmuxPane as string;

          // Step 2: that dispatch's pane now shows a usage-limit refusal; the hook (as parent)
          // detects it and resumes the chain at step 2, through the real orchestrate spawn.
          const hookResult = await executeHookTurnEnd([], hookEnvironment, process, noStdin);
          expect(hookResult).toEqual({ kind: "ok", value: "{}\n" });
          expect(process.calls.some((call) => call.command.includes("megabrain"))).toBe(false);

          const refusedMeta = await readMeta(root, firstDispatchId);
          expect(refusedMeta.state).toBe("failed");
          expect(refusedMeta.reconcileOutcome).toBe("limit-refused");

          const dispatchIds = (await readdir(join(root, "dispatches"))).filter((id) => id !== firstDispatchId);
          expect(dispatchIds).toHaveLength(1);
          const resumedMeta = await readMeta(root, dispatchIds[0]);
          expect(resumedMeta).toMatchObject({ agent: "codex", model: "m2", runtime: "tmux", worktreePath: resolvedWorktree });
          expect(resumedMeta.chain).toMatchObject({ name: "defaultSteps", step: 2, total: 2, usedDefault: true, prompt: "keep going" });
        } finally {
          await rm(worktreeDir, { recursive: true, force: true });
        }
      });
    } finally {
      registerTmux(original);
    }
  });
});

describe("executeHookTurnEnd: this session is itself a dispatch child", () => {
  test("blocks (reason: reply available) when the parent has queued a reply", async () => {
    await withRoot("reply-available", async (root) => {
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running" });
      const fp = fakeProcess();
      await appendMessage(root, "d1", "parent", "reply", "do the other thing", "coord-term", childEnv(root), fp);
      const result = await executeHookTurnEnd([], childEnv(root), fp, noStdin);
      expect(result).toEqual({ kind: "ok", value: '{"decision":"block","reason":"megabrain reply available; run megabrain check and act on it"}\n' });
    });
  });

  test("cursor gets {\"continue\":true} instead of a block decision when a reply is available", async () => {
    await withRoot("reply-available-cursor", async (root) => {
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running" });
      const fp = fakeProcess();
      await appendMessage(root, "d1", "parent", "reply", "do the other thing", "coord-term", childEnv(root), fp);
      const result = await executeHookTurnEnd([], childEnv(root, { MEGABRAIN_HOOK_AGENT: "cursor" }), fp, noStdin);
      expect(result).toEqual({ kind: "ok", value: '{"continue":true}\n' });
    });
  });

  test("finishes quietly for a state that is already awaiting reply, done, closed, or orphaned", async () => {
    for (const state of ["waiting_for_reply", "done", "closed", "orphaned"]) {
      await withRoot(`state-${state}`, async (root) => {
        await writeMeta(root, "d1", { ...childBase, state, processState: "running" });
        const process = fakeProcess();
        const result = await executeHookTurnEnd([], childEnv(root), process, noStdin);
        expect(result).toEqual({ kind: "ok", value: "{}\n" });
        expect((await (await import("node:fs/promises")).readdir(join(root, "dispatches", "d1", "messages"))).length).toBe(0);
      });
    }
  });

  // WHY host-runtime, not tmux: the hook's own top gate (`SUPERSET_TERMINAL_ID ||
  // ORCA_TERMINAL_HANDLE`, faithfully ported from the shell) means a tmux-runtime dispatch's own
  // agent process can NEVER reach this "I am a child, is my own turn stalled" path in the first
  // place — orchestrate-spawn.ts's tmux launch line explicitly clears every
  // CALLER_IDENTITY_ENV_VARS entry (including both of those) before starting the agent, so it has
  // neither. Earlier versions of these tests combined a superset-identified caller with a
  // tmux-runtime dispatch record to exercise stalledIsDue's tmux branch; findChild's tmux-identity
  // fix correctly makes that combination unmatchable now (a tmux-runtime record can only ever be
  // matched by tmuxSession+tmuxPane), which is what surfaced that the combination described a
  // scenario no real dispatch can reach. These now use the host branch of terminalStatus
  // (hostList, orchestrate-terminal.ts), which is what a real host-runtime child's own hook run
  // actually exercises.
  test("does not append a stalled message while the terminal is proven and the child spoke recently", async () => {
    await withRoot("not-stalled", async (root) => {
      await writeMeta(root, "d1", { ...childBase, workspaceId: "workspace-child", state: "running", processState: "running" });
      await appendMessage(root, "d1", "child", "ask", "still thinking", "child-term", childEnv(root), fakeProcess());
      const process = fakeProcess((command, args) => command === "superset" && args[0] === "terminals" && args[1] === "list"
        ? ok({ stdout: JSON.stringify({ sessions: [{ terminalId: "some-other-terminal" }] }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await executeHookTurnEnd([], childEnv(root), process, noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
      const messages = await (await import("node:fs/promises")).readdir(join(root, "dispatches", "d1", "messages"));
      expect(messages.some((name) => name.includes("stalled"))).toBe(false);
    });
  });

  test("appends the fallback stalled text when the terminal is missing and no payload text is given", async () => {
    await withRoot("stalled-missing-terminal", async (root) => {
      await writeMeta(root, "d1", { ...childBase, workspaceId: "workspace-child", state: "running", processState: "running" });
      const process = fakeProcess((command, args) => command === "superset" && args[0] === "terminals" && args[1] === "list"
        ? ok({ stdout: JSON.stringify({ sessions: [] }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await executeHookTurnEnd([], childEnv(root), process, noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
      const directory = join(root, "dispatches", "d1", "messages");
      const names = (await (await import("node:fs/promises")).readdir(directory)).filter((name) => name.includes("stalled"));
      expect(names).toHaveLength(1);
      const recorded = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
      expect(recorded).toMatchObject({ from: "child", type: "stalled", text: "child turn ended without ask or done", sessionId: "child-term" });
    });
  });

  test("uses the payload's last_assistant_message, passed as argv[0], over the fallback text", async () => {
    await withRoot("stalled-argv-payload", async (root) => {
      await writeMeta(root, "d1", { ...childBase, workspaceId: "workspace-child", state: "running", processState: "running" });
      const process = fakeProcess((command, args) => command === "superset" && args[0] === "terminals" && args[1] === "list"
        ? ok({ stdout: JSON.stringify({ sessions: [] }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const payload = JSON.stringify({ last_assistant_message: "here is my final answer" });
      await executeHookTurnEnd([payload], childEnv(root), process, noStdin);
      const directory = join(root, "dispatches", "d1", "messages");
      const names = (await (await import("node:fs/promises")).readdir(directory)).filter((name) => name.includes("stalled"));
      const recorded = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
      expect(recorded.text).toBe("here is my final answer");
    });
  });

  test("reads the payload from stdin when no argv payload is given", async () => {
    await withRoot("stalled-stdin-payload", async (root) => {
      await writeMeta(root, "d1", { ...childBase, workspaceId: "workspace-child", state: "running", processState: "running" });
      const process = fakeProcess((command, args) => command === "superset" && args[0] === "terminals" && args[1] === "list"
        ? ok({ stdout: JSON.stringify({ sessions: [] }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const stdin = async () => JSON.stringify({ lastAssistantMessage: "from stdin" });
      await executeHookTurnEnd([], childEnv(root), process, stdin);
      const directory = join(root, "dispatches", "d1", "messages");
      const names = (await (await import("node:fs/promises")).readdir(directory)).filter((name) => name.includes("stalled"));
      const recorded = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
      expect(recorded.text).toBe("from stdin");
    });
  });

  test("falls back to the tail of the transcript file when the payload text is empty", async () => {
    await withRoot("stalled-transcript", async (root) => {
      await writeMeta(root, "d1", { ...childBase, workspaceId: "workspace-child", state: "running", processState: "running" });
      const transcriptPath = join(root, "transcript.jsonl");
      const lines = Array.from({ length: 30 }, (_value, index) => `line ${index}`).join("\n");
      await writeFile(transcriptPath, lines);
      const process = fakeProcess((command, args) => command === "superset" && args[0] === "terminals" && args[1] === "list"
        ? ok({ stdout: JSON.stringify({ sessions: [] }), stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const payload = JSON.stringify({ transcript_path: transcriptPath });
      await executeHookTurnEnd([payload], childEnv(root), process, noStdin);
      const directory = join(root, "dispatches", "d1", "messages");
      const names = (await (await import("node:fs/promises")).readdir(directory)).filter((name) => name.includes("stalled"));
      const recorded = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
      expect(recorded.text).toBe(Array.from({ length: 20 }, (_value, index) => `line ${index + 10}`).join("\n"));
    });
  });
});

describe("executeHookTurnEnd: never fails or blocks the agent", () => {
  test("still resolves ok() with the default response when every process call throws", async () => {
    await withRoot("throwing", async (root) => {
      await writeMeta(root, "d1", { ...childBase, workspaceId: "workspace-child", state: "running", processState: "running" });
      const throwing: ProcessAdapter = {
        run: async () => { throw new Error("boom"); },
        startDetached: async () => { throw new Error("boom"); },
        invocationCount: () => 0,
      };
      const result = await executeHookTurnEnd([], childEnv(root), throwing, noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
    });
  });

  test("still resolves ok() when the environment names a state directory that does not exist", async () => {
    const result = await executeHookTurnEnd([], environment("/nowhere/at/all/does-not-exist", { SUPERSET_TERMINAL_ID: "coord-term" }), fakeProcess(), noStdin);
    expect(result).toEqual({ kind: "ok", value: "{}\n" });
  });
});

// The parent that spawns a tmux dispatch must never be attributed as that dispatch's own child on
// its very next turn-end hook run: before the fix, orchestrate spawn recorded the child's
// terminalId as the caller's own id and childHost as the caller's own host (a bookkeeping
// shortcut for "who spawned this"), and findChild matched on exactly those two fields — so the
// coordinator's own hook run would misidentify itself as the dispatch it just spawned, and append
// a "child stalled" message into that dispatch's own queue. A real spawn (no fake dependency
// needed here anymore, unlike the chain-continuation scenario above) from an Orca terminal proves
// the fix holds for the actual production path.
describe("executeHookTurnEnd: the parent is never mistaken for its own just-spawned tmux child", () => {
  test("a real tmux spawn is not attributed to itself on the coordinator's next turn-end hook", async () => {
    const original = getTmux();
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async () => ok(undefined),
      sendKey: async () => ok(undefined),
      capturePane: async () => ok("› Ask Codex to do anything"),
    });
    try {
      await withRoot("no-self-attribution", async (root) => {
        const worktreeDir = await mkdtemp(`${tmpdir()}/megabrain-hook-no-self-worktree-`);
        try {
          const hookEnvironment = environment(root, { ORCA_TERMINAL_HANDLE: "coord-orca-term", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" });
          const process = fakeProcess((command, args) => {
            if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%40\n", stderr: "", exitCode: 0 });
            return ok({ stdout: "", stderr: "", exitCode: 0 });
          });
          const spawnResult = await executeSpawn(["--worktree", worktreeDir, "--agent", "codex", "--prompt", "keep going", "--tmux", "true", "--json"], hookEnvironment, process);
          expect(spawnResult.kind).toBe("ok");
          if (spawnResult.kind !== "ok") return;
          const dispatchId: string = JSON.parse(spawnResult.value).dispatchId;
          const spawnedMeta = await readMeta(root, dispatchId);
          expect(spawnedMeta.childHost).toBe("tmux");
          expect(spawnedMeta.terminalId).not.toBe(spawnedMeta.parentSessionId);

          const hookResult = await executeHookTurnEnd([], hookEnvironment, process, noStdin);
          expect(hookResult).toEqual({ kind: "ok", value: "{}\n" });

          const messages = (await readdir(join(root, "dispatches", dispatchId, "messages"))).filter((name) => name.includes("stalled"));
          expect(messages).toHaveLength(0);
          const afterMeta = await readMeta(root, dispatchId);
          expect(afterMeta.state).toBe("spawning");
          expect(afterMeta.reconcileOutcome ?? null).toBeNull();
        } finally {
          await rm(worktreeDir, { recursive: true, force: true });
        }
      });
    } finally {
      registerTmux(original);
    }
  });
});

// D1: the hook's top gate used to require SUPERSET_TERMINAL_ID or ORCA_TERMINAL_HANDLE — which a
// real tmux dispatch's agent process never has (orchestrate-spawn.ts's tmux launch line clears
// every CALLER_IDENTITY_ENV_VARS entry before starting it, and before that fix it inherited the
// PARENT's handle by accident, which is what let turn-end detection "work" for tmux children
// pre-L2). A caller that is genuinely inside a tmux pane (TMUX and TMUX_PANE both set) must also
// pass the gate; a caller with neither a terminal marker nor a tmux pane still exits immediately.
describe("executeHookTurnEnd: a caller inside a tmux pane passes the top gate", () => {
  test("a real tmux child's turn ends without done, recorded exactly as a host child's would be", async () => {
    await withRoot("tmux-child-stalled", async (root) => {
      await writeMeta(root, "d1", {
        childHost: "tmux", terminalId: "tmux:work:%3", parentSessionId: "coord-term", parentHost: "orca",
        runtime: "tmux", tmuxSession: "work", tmuxPane: "%3", state: "running", processState: "running",
      });
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "display-message" && args.includes("#{session_name}")) return ok({ stdout: "work\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "has-session") return failed("no session");
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      const childEnvironment = environment(root, { TMUX: "child-tmux-server", TMUX_PANE: "%3" });
      const result = await executeHookTurnEnd([], childEnvironment, process, noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
      const directory = join(root, "dispatches", "d1", "messages");
      const names = (await readdir(directory)).filter((name) => name.includes("stalled"));
      expect(names).toHaveLength(1);
      const recorded = JSON.parse(await readFile(join(directory, names[0]), "utf8"));
      expect(recorded).toMatchObject({ from: "child", type: "stalled", text: "child turn ended without ask or done", sessionId: "work:%3" });
    });
  });

  test("a limit-refused dispatch continues its chain when the parent itself runs inside a tmux pane", async () => {
    const original = getTmux();
    let refusedPane: string | undefined;
    registerTmux({
      ...original,
      id: "tmux",
      sendText: async () => ok(undefined),
      sendKey: async () => ok(undefined),
      capturePane: async (pane) => (pane === refusedPane ? ok("You've hit your usage limit for this model.\nSwitch to another model now, or wait.\n") : ok("› Ask Codex to do anything")),
    });
    try {
      await withRoot("tmux-parent-continue", async (root) => {
        await writeFile(join(root, "chains.json"), JSON.stringify({ chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }, { agent: "codex", model: "m2" }] }));
        const worktreeDir = await mkdtemp(`${tmpdir()}/megabrain-hook-tmux-parent-worktree-`);
        try {
          const resolvedWorktree = await realpath(worktreeDir);
          // The coordinator itself runs inside tmux pane %0 of session "coord-session" — no
          // SUPERSET_TERMINAL_ID or ORCA_TERMINAL_HANDLE at all, exactly the shape this lead's own
          // structured-session-over-tmux setup has.
          const coordinatorEnvironment = environment(root, { TMUX: "coord-tmux-server", TMUX_PANE: "%0", MEGABRAIN_PROMPT_RECEIPT_TIMEOUT_SECONDS: "0" });
          let nextPane = 30;
          const process = fakeProcess((command, args) => {
            if (command === "tmux" && args[0] === "display-message" && args.includes("#{session_name}")) return ok({ stdout: "coord-session\n", stderr: "", exitCode: 0 });
            if (command === "tmux" && args[0] === "display-message" && args.includes("#{pane_current_path}")) return ok({ stdout: `${resolvedWorktree}\n`, stderr: "", exitCode: 0 });
            if (command === "git" && args.includes("--show-toplevel")) return ok({ stdout: `${resolvedWorktree}\n`, stderr: "", exitCode: 0 });
            if (command === "git" && args.includes("symbolic-ref")) return ok({ stdout: "feat/chain\n", stderr: "", exitCode: 0 });
            if (command === "tmux" && args[0] === "split-window") return ok({ stdout: `%${nextPane++}\n`, stderr: "", exitCode: 0 });
            if (command === "tmux" && args[0] === "list-panes") {
              const format = args[args.indexOf("-F") + 1] ?? "";
              const stdout = format.includes("|") ? "%0|@0|0|0|0|80|80\n" : "%0\n";
              return ok({ stdout, stderr: "", exitCode: 0 });
            }
            if (command === "tmux" && args[0] === "has-session") return ok({ stdout: "", stderr: "", exitCode: 0 });
            return ok({ stdout: "", stderr: "", exitCode: 0 });
          });

          const runResult = await executeChainRun(["--worktree", worktreeDir, "--prompt", "keep going", "--tmux", "true", "--json"], coordinatorEnvironment, process);
          expect(runResult.kind).toBe("ok");
          if (runResult.kind !== "ok") return;
          const dispatchId: string = JSON.parse(runResult.value).dispatch.dispatchId;
          const firstMeta = await readMeta(root, dispatchId);
          expect(firstMeta.chain).toMatchObject({ name: "defaultSteps", step: 1, total: 2, usedDefault: true, prompt: "keep going" });
          // The child's own pane must never equal the coordinator's own pane (%0).
          expect(firstMeta.tmuxPane).not.toBe("%0");
          refusedPane = firstMeta.tmuxPane as string;

          const hookResult = await executeHookTurnEnd([], coordinatorEnvironment, process, noStdin);
          expect(hookResult).toEqual({ kind: "ok", value: "{}\n" });
          expect(process.calls.some((call) => call.command.includes("megabrain"))).toBe(false);

          const refusedMeta = await readMeta(root, dispatchId);
          expect(refusedMeta.state).toBe("failed");
          expect(refusedMeta.reconcileOutcome).toBe("limit-refused");

          const dispatchIds = (await readdir(join(root, "dispatches"))).filter((id) => id !== dispatchId);
          expect(dispatchIds).toHaveLength(1);
          const resumedMeta = await readMeta(root, dispatchIds[0]);
          expect(resumedMeta).toMatchObject({ agent: "codex", model: "m2", runtime: "tmux", worktreePath: resolvedWorktree });
          expect(resumedMeta.chain).toMatchObject({ name: "defaultSteps", step: 2, total: 2, usedDefault: true, prompt: "keep going" });
        } finally {
          await rm(worktreeDir, { recursive: true, force: true });
        }
      });
    } finally {
      registerTmux(original);
    }
  });
});
