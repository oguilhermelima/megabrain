import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../src/core/queue-write.js";
import { findChild } from "../../src/cli/commands/queue-write.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";

describe("parseChildMessage", () => {
  test.each([
    ["received", [], "prompt received"],
    ["ask", ["a question"], "a question"],
    ["ask", ["--text", "a question"], "a question"],
    ["done", ["finished"], "finished"],
    ["done", ["--text", "finished"], "finished"],
  ] as const)("accepts %s", (type, args, text) => {
    expect(parseChildMessage(type, args)).toEqual({ kind: "ok", value: text });
  });

  test.each([
    ["received", ["extra"], "Usage: megabrain received\n"],
    ["received", ["--text", "hello"], "Usage: megabrain received\n"],
    ["ask", [], "Usage: megabrain ask \"question\" | megabrain ask --text \"question\"\n"],
    ["ask", [""], "Usage: megabrain ask \"question\" | megabrain ask --text \"question\"\n"],
    ["ask", ["--text"], "Usage: megabrain ask \"question\" | megabrain ask --text \"question\"\n"],
    ["ask", ["--text", ""], "Usage: megabrain ask \"question\" | megabrain ask --text \"question\"\n"],
    ["ask", ["question", "--text", "other"], "Usage: megabrain ask \"question\" | megabrain ask --text \"question\"\n"],
    ["done", [], "Usage: megabrain done \"summary\" | megabrain done --text \"summary\"\n"],
    ["done", [""], "Usage: megabrain done \"summary\" | megabrain done --text \"summary\"\n"],
    ["done", ["--text"], "Usage: megabrain done \"summary\" | megabrain done --text \"summary\"\n"],
    ["done", ["--text", ""], "Usage: megabrain done \"summary\" | megabrain done --text \"summary\"\n"],
    ["done", ["summary", "--text", "other"], "Usage: megabrain done \"summary\" | megabrain done --text \"summary\"\n"],
  ] as const)("rejects invalid %s arguments", (type, args, error) => {
    expect(parseChildMessage(type, args)).toEqual({ kind: "failed", error, exitCode: 2 });
  });
});

describe("queue message decisions", () => {
  test.each([
    ["child", "ask", false, "actionable"],
    ["child", "done", false, "actionable"],
    ["child", "done", true, "protocol"],
    ["child", "received", false, "protocol"],
    ["parent", "reply", false, undefined],
    ["parent", "interrupt", false, "protocol"],
    ["child", "unknown", false, undefined],
  ] as const)("classifies %s:%s", (from, type, priorDone, expected) => {
    expect(classifyQueueMail(from, type, priorDone)).toBe(expected);
    expect(recipientForQueueMessage(from, type, priorDone)).toBe(from === "parent" ? "child" : expected === undefined ? undefined : "parent");
  });

  test("allocates the next sequence from message filenames", () => {
    expect(nextMessageSequence(["0001-child-ask.json", "0009-parent-reply.json", "garbage.json"])).toBe(10);
    expect(nextMessageSequence([])).toBe(1);
  });
});

// findChild is what the turn-end hook (every agent turn), `megabrain done`/`ask`/`received`, and
// `orchestrate spawn`'s own prompt-publication step use to answer "is the CURRENT session itself
// a managed dispatch's child". A tmux-runtime dispatch record's terminalId/childHost describe who
// SPAWNED it (a caller-identity bookkeeping field, orchestrate-spawn.ts's initialMeta), which for
// a non-tmux-hosted caller equals that caller's OWN identity — so before this fix, a coordinator
// that spawned a tmux dispatch would match its own just-spawned dispatch here, misidentifying
// itself as that dispatch's child. tmux records must only ever be matched by tmuxSession+tmuxPane.
describe("findChild: tmux-runtime records", () => {
  function fakeProcess(behavior: (command: string, args: readonly string[]) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = () => ok({ stdout: "", stderr: "", exitCode: 0 })): ProcessAdapter {
    return {
      async run(command, args) { return behavior(command, args); },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
  }

  async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(`${tmpdir()}/megabrain-findchild-`);
    try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
  }

  async function writeDispatch(root: string, dispatchId: string, meta: Record<string, unknown>): Promise<void> {
    const directory = join(root, "dispatches", dispatchId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "meta.json"), JSON.stringify({ dispatchId, ...meta }));
  }

  test("does not match a tmux dispatch by terminalId, even a legacy record carrying the parent's own id", async () => {
    await withRoot(async (root) => {
      // This is exactly what orchestrate-spawn.ts wrote before this fix (and what any
      // already-on-disk dispatch still carries): terminalId/childHost equal to the spawning
      // caller's own identity.
      await writeDispatch(root, "legacy-tmux", {
        runtime: "tmux", terminalId: "coord-orca-term", childHost: "orca",
        tmuxSession: "dispatch-session", tmuxPane: "%5",
      });
      const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "coord-orca-term" };
      const result = await findChild(root, environment, fakeProcess());
      expect("kind" in result).toBe(true);
      if (!("kind" in result)) return;
      expect(result).toEqual({ kind: "failed", error: "no managed dispatch belongs to orca/coord-orca-term", exitCode: 1 });
    });
  });

  test("still finds the real child by tmuxSession and tmuxPane", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "real-child", {
        runtime: "tmux", terminalId: "coord-orca-term", childHost: "orca",
        tmuxSession: "dispatch-session", tmuxPane: "%5",
      });
      const environment = { MEGABRAIN_STATE_DIR: root, TMUX: "some-server", TMUX_PANE: "%5" };
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message" ? ok({ stdout: "dispatch-session\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await findChild(root, environment, process);
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("real-child");
    });
  });

  test("host-runtime dispatches are unaffected: terminalId/childHost matching still works", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "host-child", { runtime: "host", terminalId: "child-orca-term", childHost: "orca" });
      const environment = { MEGABRAIN_STATE_DIR: root, ORCA_TERMINAL_HANDLE: "child-orca-term" };
      const result = await findChild(root, environment, fakeProcess());
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("host-child");
    });
  });
});

// MEGABRAIN_DISPATCH_ID is meant to short-circuit the identity scan for the common case (a child
// asking about its own dispatch), not to bypass ownership entirely. A stale value left over from a
// different dispatch (env inherited across an exec, or copy-pasted) names a dispatch that still
// exists on disk but was never spawned for/by this caller. The shell implementation this replaces
// fell back to the identity scan in that case; the ported fast path regressed to trusting the id
// outright, which the reproduction in tests/test-dispatch-prune.sh caught.
describe("findChild: MEGABRAIN_DISPATCH_ID fast path only short-circuits for the caller's own dispatch", () => {
  function fakeProcess(): ProcessAdapter {
    return {
      async run() { return ok({ stdout: "", stderr: "", exitCode: 0 }); },
      async startDetached() { return failed("not used"); },
      invocationCount() { return 0; },
    };
  }

  async function withRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(`${tmpdir()}/megabrain-findchild-direct-`);
    try { return await body(root); } finally { await rm(root, { recursive: true, force: true }); }
  }

  async function writeDispatch(root: string, dispatchId: string, meta: Record<string, unknown>): Promise<void> {
    const directory = join(root, "dispatches", dispatchId);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "meta.json"), JSON.stringify({ dispatchId, ...meta }));
  }

  test("falls back to the identity scan when MEGABRAIN_DISPATCH_ID names a dispatch that is not the caller's", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "wrong-dispatch", { runtime: "host", terminalId: "other-terminal", childHost: "superset" });
      await writeDispatch(root, "fallback-dispatch", { runtime: "host", terminalId: "child-terminal", childHost: "superset" });
      const environment = { MEGABRAIN_STATE_DIR: root, SUPERSET_TERMINAL_ID: "child-terminal", MEGABRAIN_DISPATCH_ID: "wrong-dispatch" };
      const result = await findChild(root, environment, fakeProcess());
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("fallback-dispatch");
    });
  });

  test("falls back to the identity scan when MEGABRAIN_DISPATCH_ID names an absent dispatch", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "fallback-dispatch", { runtime: "host", terminalId: "child-terminal", childHost: "superset" });
      const environment = { MEGABRAIN_STATE_DIR: root, SUPERSET_TERMINAL_ID: "child-terminal", MEGABRAIN_DISPATCH_ID: "deleted-dispatch" };
      const result = await findChild(root, environment, fakeProcess());
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("fallback-dispatch");
    });
  });

  test("still short-circuits (never scans siblings) when MEGABRAIN_DISPATCH_ID names the caller's own dispatch", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "direct-dispatch", { runtime: "host", terminalId: "child-terminal", childHost: "superset" });
      // A second dispatch that would also match this caller's identity, and would make a full
      // scan ambiguous — proving the fast path truly short-circuits instead of merely routing
      // through the scan with a candidate list of one that happens to be right.
      await writeDispatch(root, "sibling-dispatch", { runtime: "host", terminalId: "child-terminal", childHost: "superset" });
      const environment = { MEGABRAIN_STATE_DIR: root, SUPERSET_TERMINAL_ID: "child-terminal", MEGABRAIN_DISPATCH_ID: "direct-dispatch" };
      const result = await findChild(root, environment, fakeProcess());
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("direct-dispatch");
    });
  });

  test("applies the same tmuxSession+tmuxPane rule to a tmux-runtime dispatch named directly", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "real-child", {
        runtime: "tmux", terminalId: "coord-orca-term", childHost: "orca",
        tmuxSession: "dispatch-session", tmuxPane: "%5",
      });
      const environment = { MEGABRAIN_STATE_DIR: root, TMUX: "some-server", TMUX_PANE: "%5", MEGABRAIN_DISPATCH_ID: "real-child" };
      const process: ProcessAdapter = {
        async run(command, args) { return command === "tmux" && args[0] === "display-message" ? ok({ stdout: "dispatch-session\n", stderr: "", exitCode: 0 }) : ok({ stdout: "", stderr: "", exitCode: 0 }); },
        async startDetached() { return failed("not used"); },
        invocationCount() { return 0; },
      };
      const result = await findChild(root, environment, process);
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("real-child");
    });
  });
});
