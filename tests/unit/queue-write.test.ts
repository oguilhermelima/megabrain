import { guardedStateDatabase } from "./state-db-guard.js";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../src/core/queue-write.js";
import { findChild, updateMeta } from "../../src/cli/commands/queue-write.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { archiveDispatch, createDispatch, getDispatch, isDispatchArchived } from "../../src/adapters/state-db.js";
import { appendMessage, claimOutbox, createDelivery, finishNotification, listDeliveries, listMessages, listNudges, listOutbox } from "../../src/adapters/state-db.js";
import type { DatabaseHandle } from "../../src/db/db.js";

function requireOk<T>(result: Result<T>): T {
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value;
}

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
    ["parent", "withdrawal", false, "actionable"],
    ["parent", "interrupt", false, "protocol"],
    ["parent", "interrupt-result", false, "protocol"],
    ["parent", "idle-result", false, undefined],
    ["parent", "composer-clear", false, undefined],
    ["parent", "delivery-result", false, undefined],
    ["parent", "delivery-confirmation", false, undefined],
    ["child", "unknown", false, undefined],
  ] as const)("classifies %s:%s", (from, type, priorDone, expected) => {
    expect(classifyQueueMail(from, type, priorDone)).toBe(expected);
    expect(recipientForQueueMessage(from, type, priorDone)).toBe(from === "parent" ? type === "reply" ? "child" : undefined : expected === undefined ? undefined : "parent");
  });

  test("allocates the next sequence from message filenames", () => {
    expect(nextMessageSequence(["0001-child-ask.json", "0009-parent-reply.json", "garbage.json"])).toBe(10);
    expect(nextMessageSequence([])).toBe(1);
  });
});

describe("Claude child session identity", () => {
  test("records the Claude session id when the child confirms receipt", async () => {
    const root = await mkdtemp(`${tmpdir()}/megabrain-child-session-`);
    try {
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (database.kind !== "ok") throw new Error(database.error);
      const created = createDispatch(database.value, { dispatchId: "claude-child-session", state: "running", agent: "claude" });
      if (created.kind !== "ok") throw new Error(created.error);
      const process: ProcessAdapter = {
        async run(command, args) { return failed(`unexpected process call ${command} ${args.join(" ")}`); },
        async startDetached() { return failed("not used"); },
        invocationCount() { return 0; },
      };
      const received = await updateMeta(root, "claude-child-session", "received", {
        HOME: root,
        MEGABRAIN_STATE_DIR: root,
        CLAUDE_CODE_SESSION_ID: "child-session-fixture",
      }, process);
      expect(received.kind).toBe("ok");
      expect(getDispatch(database.value, "claude-child-session")).toMatchObject({ kind: "ok", value: { agentSessionId: "child-session-fixture" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
    const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (database.kind !== "ok") throw new Error(database.error);
    const created = createDispatch(database.value, { dispatchId, state: "running", ...meta });
    if (created.kind !== "ok") throw new Error(created.error);
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

  test("finds the real child by stable tmuxSessionId and tmuxPane after a rename", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "real-child", {
        runtime: "tmux", terminalId: "coord-orca-term", childHost: "orca",
        tmuxSession: "old-session-name", tmuxSessionId: "$3", tmuxPane: "%5",
      });
      const environment = { MEGABRAIN_STATE_DIR: root, TMUX: "some-server", TMUX_PANE: "%5" };
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message"
        ? ok({ stdout: args.at(-1) === "#{session_name}" ? "renamed-session\n" : "$3\n", stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await findChild(root, environment, process);
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("real-child");
    });
  });

  test("keeps matching legacy records without tmuxSessionId by session name", async () => {
    await withRoot(async (root) => {
      await writeDispatch(root, "legacy-child", { runtime: "tmux", tmuxSession: "dispatch-session", tmuxPane: "%5" });
      const environment = { MEGABRAIN_STATE_DIR: root, TMUX: "some-server", TMUX_PANE: "%5" };
      const process = fakeProcess((command, args) => command === "tmux" && args[0] === "display-message"
        ? ok({ stdout: args.at(-1) === "#{session_name}" ? "dispatch-session\n" : "$3\n", stderr: "", exitCode: 0 })
        : ok({ stdout: "", stderr: "", exitCode: 0 }));
      const result = await findChild(root, environment, process);
      expect("kind" in result).toBe(false);
      if ("kind" in result) return;
      expect(result.dispatch).toBe("legacy-child");
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
    const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
    if (database.kind !== "ok") throw new Error(database.error);
    const created = createDispatch(database.value, { dispatchId, state: "running", ...meta });
    if (created.kind !== "ok") throw new Error(created.error);
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

describe("queue facade transactions", () => {
  async function withDatabase<T>(body: (handle: DatabaseHandle) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "megabrain-queue-atomic-"));
    try {
      const opened = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (opened.kind !== "ok") throw new Error(opened.error);
      const dispatch = createDispatch(opened.value, { dispatchId: "atomic", state: "running" });
      if (dispatch.kind !== "ok") throw new Error(dispatch.error);
      return await body(opened.value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("message, delivery, and outbox all roll back when delivery insertion fails", async () => {
    await withDatabase(async (handle) => {
      const delivery = {
        id: "duplicate-delivery", dispatchId: "atomic", recipient: "parent",
        messageSeqs: [1], status: "outstanding", createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(), acknowledgedAt: null, fencedAt: null,
        consumer: null, consumerGeneration: null,
      };
      const seeded = createDelivery(handle, delivery);
      expect(seeded.kind).toBe("ok");

      const result = appendMessage(handle, "atomic", { from: "child", type: "ask", text: "question" }, {
        delivery,
        outbox: { id: "atomic-outbox", targetKind: "parent", target: "parent-terminal", payload: { text: "mail" } },
      });
      expect(result.kind).toBe("failed");
      if (result.kind !== "failed") return;
      expect(result.error).toContain("UNIQUE");
      expect(requireOk(listMessages(handle, "atomic"))).toHaveLength(0);
      expect(requireOk(listDeliveries(handle, "atomic"))).toHaveLength(1);
      expect(requireOk(listOutbox(handle))).toHaveLength(0);
    });
  });

  test("outbox finish and nudge event roll back together when the nudge insert fails", async () => {
    await withDatabase(async (handle) => {
      const appended = appendMessage(handle, "atomic", { from: "child", type: "ask", text: "question" }, {
        outbox: { id: "atomic-outbox", targetKind: "parent", target: "parent-terminal", payload: { text: "mail" } },
      });
      expect(appended.kind).toBe("ok");
      const claimed = claimOutbox(handle, "atomic-outbox", "test-worker", 30);
      expect(claimed.kind).toBe("ok");
      const result = finishNotification(handle, "atomic-outbox", "sent", {
        dispatchId: "missing-dispatch", pointer: "mail", outcome: "delivered", reason: "sent",
      });
      expect(result.kind).toBe("failed");
      expect(requireOk(listOutbox(handle))[0]?.status).toBe("sending");
      expect(requireOk(listNudges(handle, "atomic"))).toHaveLength(0);
    });
  });

  test("derives protocol delivery from messages visible inside the append transaction", async () => {
    await withDatabase(async (handle) => {
      const appendDone = (text: string) => appendMessage(handle, "atomic", { from: "child", type: "done", text }, {
        derive: (previous) => previous.some((message) => message.from === "child" && message.type === "done") ? {} : {
          delivery: {
            id: `delivery-${text}`, recipient: "parent", messageSeqs: [], status: "outstanding",
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), consumer: null, consumerGeneration: null,
          },
        },
      });
      expect(appendDone("first").kind).toBe("ok");
      expect(appendDone("retry").kind).toBe("ok");
      expect(requireOk(listMessages(handle, "atomic")).map(({ seq }) => seq)).toEqual([1, 2]);
      expect(requireOk(listDeliveries(handle, "atomic")).map(({ id }) => id)).toEqual(["delivery-first"]);
    });
  });

  test("reads archived_at through the facade and rejects unknown dispatches", async () => {
    await withDatabase(async (handle) => {
      expect(requireOk(isDispatchArchived(handle, "atomic"))).toBe(false);
      expect(requireOk(archiveDispatch(handle, "atomic", "2026-09-01T00:00:00.000Z"))).toBe(true);
      expect(requireOk(isDispatchArchived(handle, "atomic"))).toBe(true);
      const missing = isDispatchArchived(handle, "missing");
      expect(missing.kind).toBe("failed");
      if (missing.kind === "failed") expect(missing.error).toBe("dispatch not found: missing");
    });
  });
});

describe("a receipt failure never blocks the child's own reports", () => {
  const idleProcess: ProcessAdapter = {
    async run(command, args) { return failed(`unexpected process call ${command} ${args.join(" ")}`); },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };

  async function withDispatch(meta: Record<string, unknown>, body: (root: string, read: () => Record<string, unknown>) => Promise<void>): Promise<void> {
    const root = await mkdtemp(`${tmpdir()}/megabrain-receipt-recovery-`);
    try {
      const database = guardedStateDatabase({ MEGABRAIN_STATE_DIR: root });
      if (database.kind !== "ok") throw new Error(database.error);
      requireOk(createDispatch(database.value, { dispatchId: "receipt-recovery", agent: "claude", ...meta }));
      await body(root, () => {
        const record = getDispatch(database.value, "receipt-recovery");
        if (record.kind !== "ok" || record.value === undefined) throw new Error("dispatch missing");
        return record.value;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const environment = (root: string) => ({ HOME: root, MEGABRAIN_STATE_DIR: root });

  test.each(["prompt-not-received", "no-receipt-unproven"])("done after %s completes the dispatch and clears the failure", async (reason) => {
    await withDispatch({ state: "failed", processState: "start-unproven", terminalState: "owned", reason, promptReceipt: "not-received" }, async (root, read) => {
      expect((await updateMeta(root, "receipt-recovery", "done", environment(root), idleProcess)).kind).toBe("ok");
      expect(read()).toMatchObject({ state: "done", processState: "succeeded", terminalState: "owned", reason: null, recoveredFrom: reason });
    });
  });

  test("ask after a receipt failure waits for the reply instead of being refused", async () => {
    await withDispatch({ state: "failed", processState: "running", terminalState: "owned", reason: "no-receipt-after-turn" }, async (root, read) => {
      expect((await updateMeta(root, "receipt-recovery", "ask", environment(root), idleProcess)).kind).toBe("ok");
      expect(read()).toMatchObject({ state: "waiting_for_reply", reason: null, recoveredFrom: "no-receipt-after-turn" });
    });
  });

  test("received after prompt-not-received puts the dispatch back to running", async () => {
    await withDispatch({ state: "failed", processState: "start-unproven", terminalState: "owned", reason: "prompt-not-received", promptReceipt: "not-received" }, async (root, read) => {
      expect((await updateMeta(root, "receipt-recovery", "received", environment(root), idleProcess)).kind).toBe("ok");
      expect(read()).toMatchObject({ state: "running", processState: "running", promptReceipt: "received", promptState: "confirmed", reason: null, recoveredFrom: "prompt-not-received" });
    });
  });

  test.each(["received", "ask", "done"] as const)("%s clears receiptMissing on a running dispatch", async (type) => {
    await withDispatch({ state: "running", processState: "running", terminalState: "owned", receiptMissing: { reason: "no-receipt-after-turn" } }, async (root, read) => {
      expect((await updateMeta(root, "receipt-recovery", type, environment(root), idleProcess)).kind).toBe("ok");
      expect(read().receiptMissing).toBeNull();
    });
  });

  test("a failure that is not about the receipt still refuses done", async () => {
    await withDispatch({ state: "failed", processState: "failed", terminalState: "released", reason: "readiness-timeout" }, async (root, read) => {
      const refused = await updateMeta(root, "receipt-recovery", "done", environment(root), idleProcess);
      expect(refused).toMatchObject({ kind: "failed", error: "illegal dispatch state transition: failed -> done" });
      expect(read()).toMatchObject({ state: "failed", reason: "readiness-timeout" });
    });
  });
});
