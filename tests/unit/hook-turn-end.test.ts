import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { executeHookTurnEnd, type HookEnvironment } from "../../src/cli/commands/hook-turn-end.js";
import { appendMessage } from "../../src/cli/commands/queue-write.js";
import { executeChainRun } from "../../src/cli/commands/chain-run.js";
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

  // The whole path, end to end: a real `chain run` spawns a tmux dispatch carrying real chain
  // context (writeDispatchChainContext, chain-run.ts), that dispatch's pane then shows a
  // usage-limit refusal, the turn-end hook (as the dispatch's parent) detects it, marks the
  // dispatch limit-refused, and resumes the chain in-process — never shelling out to the
  // compiled binary — spawning the next step with the same prompt and runtime. Before the fix
  // this could never happen at all: meta.chain was always null (nothing wrote it), and even with
  // chain context present, continueRefusedChain's old "tmux"/"host" -> --tmux mapping made the
  // resumed spawn fail on "--tmux requires true or false" every time.
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
        await writeFile(join(root, "chains.json"), JSON.stringify({ chains: {}, defaultSteps: [{ agent: "codex", model: "m1" }, { agent: "agy", model: "m2" }] }));
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

          // Step 1: a real chain run, spawning the first step (codex) as a tmux dispatch.
          const runResult = await executeChainRun(["--worktree", worktreeDir, "--prompt", "keep going", "--tmux", "true", "--json"], hookEnvironment, process);
          expect(runResult.kind).toBe("ok");
          if (runResult.kind !== "ok") return;
          const runBody = JSON.parse(runResult.value);
          const dispatchId: string = runBody.dispatch.dispatchId;
          const firstMeta = await readMeta(root, dispatchId);
          expect(firstMeta).toMatchObject({ agent: "codex", runtime: "tmux", worktreePath: resolvedWorktree });
          expect(firstMeta.chain).toMatchObject({ name: "defaultSteps", step: 1, total: 2, usedDefault: true, prompt: "keep going" });
          refusedPane = firstMeta.tmuxPane as string;

          // Step 2: that dispatch's pane now shows a usage-limit refusal; the hook (as parent)
          // detects it and resumes the chain at step 2.
          const hookResult = await executeHookTurnEnd([], hookEnvironment, process, noStdin);
          expect(hookResult).toEqual({ kind: "ok", value: "{}\n" });
          expect(process.calls.some((call) => call.command.includes("megabrain"))).toBe(false);

          const refusedMeta = await readMeta(root, dispatchId);
          expect(refusedMeta.state).toBe("failed");
          expect(refusedMeta.reconcileOutcome).toBe("limit-refused");

          const dispatchIds = (await readdir(join(root, "dispatches"))).filter((id) => id !== dispatchId);
          expect(dispatchIds).toHaveLength(1);
          const resumedMeta = await readMeta(root, dispatchIds[0]);
          expect(resumedMeta).toMatchObject({ agent: "agy", runtime: "tmux", worktreePath: resolvedWorktree });
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

  test("does not append a stalled message while the terminal is proven and the child spoke recently", async () => {
    await withRoot("not-stalled", async (root) => {
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running", runtime: "tmux", tmuxSession: "work", tmuxPane: "%3" });
      await appendMessage(root, "d1", "child", "ask", "still thinking", "child-term", childEnv(root), fakeProcess());
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "has-session") return ok({ stdout: "", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "list-panes") return ok({ stdout: "%3\n", stderr: "", exitCode: 0 });
        if (command === "tmux" && args[0] === "display-message") return failed("no pid");
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
      const result = await executeHookTurnEnd([], childEnv(root), process, noStdin);
      expect(result).toEqual({ kind: "ok", value: "{}\n" });
      const messages = await (await import("node:fs/promises")).readdir(join(root, "dispatches", "d1", "messages"));
      expect(messages.some((name) => name.includes("stalled"))).toBe(false);
    });
  });

  test("appends the fallback stalled text when the terminal is missing and no payload text is given", async () => {
    await withRoot("stalled-missing-terminal", async (root) => {
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running", runtime: "tmux", tmuxSession: "work", tmuxPane: "%3" });
      const process = fakeProcess((command, args) => {
        if (command === "tmux" && args[0] === "has-session") return failed("no session");
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      });
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
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running", runtime: "tmux", tmuxSession: "work", tmuxPane: "%3" });
      const process = fakeProcess((command, args) => (command === "tmux" && args[0] === "has-session" ? failed("no session") : ok({ stdout: "", stderr: "", exitCode: 0 })));
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
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running", runtime: "tmux", tmuxSession: "work", tmuxPane: "%3" });
      const process = fakeProcess((command, args) => (command === "tmux" && args[0] === "has-session" ? failed("no session") : ok({ stdout: "", stderr: "", exitCode: 0 })));
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
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running", runtime: "tmux", tmuxSession: "work", tmuxPane: "%3" });
      const transcriptPath = join(root, "transcript.jsonl");
      const lines = Array.from({ length: 30 }, (_value, index) => `line ${index}`).join("\n");
      await writeFile(transcriptPath, lines);
      const process = fakeProcess((command, args) => (command === "tmux" && args[0] === "has-session" ? failed("no session") : ok({ stdout: "", stderr: "", exitCode: 0 })));
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
      await writeMeta(root, "d1", { ...childBase, state: "running", processState: "running", runtime: "tmux", tmuxSession: "work", tmuxPane: "%3" });
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
