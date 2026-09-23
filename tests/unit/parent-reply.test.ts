import { describe, expect, test } from "bun:test";
import { addSupersedeSummary, normalizeDispatchState, parseParentChangeArgs, parseParentReplyArgs, replyStateError, supersedeDelivery } from "../../src/core/parent-reply.js";

describe("parent reply arguments", () => {
  test("parses reply text, json and supersede", () => {
    expect(parseParentReplyArgs(["dispatch", "--text", "answer", "--supersede", "--json"])).toEqual({ kind: "ok", value: { dispatchId: "dispatch", text: "answer", json: true, supersede: true } });
  });

  test("rejects missing text and unknown options", () => {
    expect(parseParentReplyArgs(["dispatch"])).toEqual({ kind: "failed", error: "--text is required", exitCode: 2 });
    expect(parseParentReplyArgs(["dispatch", "--nope"])).toEqual({ kind: "failed", error: "unknown orchestrate reply option: --nope", exitCode: 2 });
  });

  test("parses change and rejects absent dispatch", () => {
    expect(parseParentChangeArgs(["dispatch", "--text", "replacement", "--json"])).toEqual({ kind: "ok", value: { dispatchId: "dispatch", text: "replacement", json: true, supersede: true } });
    expect(parseParentChangeArgs([]).kind).toBe("failed");
  });
});

describe("parent reply decisions", () => {
  // The shell's megabrain_dispatch_reply_state_allowed is exactly the dispatch:*->running
  // transition table, with no exception for "done": dispatch:done only reaches
  // done/failed/orphaned/closed, never running, so a reply to a done dispatch is refused there.
  test("allows active states and refuses settled reply states, including done", () => {
    expect(replyStateError("d", "running", false)).toBeUndefined();
    expect(replyStateError("d", "waiting_for_reply", false)).toBeUndefined();
    expect(replyStateError("d", "spawning", false)).toBeUndefined();
    expect(replyStateError("d", "orphaned", false)).toBeUndefined();
    expect(replyStateError("d", "done", false)).toContain("settled");
    expect(replyStateError("d", "done", false)).toContain("open a new dispatch for a reply");
    expect(replyStateError("d", "failed", false)).toContain("settled");
    expect(replyStateError("d", "closed", false)).toContain("settled");
    expect(replyStateError("d", "circuit_broken", false)).toContain("settled");
    expect(replyStateError("d", "failed", true)).toContain("cannot receive a change");
    // change never gets the "settled" wording, even for done: the shell's megabrain_dispatch_change
    // only ever prints "cannot receive a change in state $state".
    expect(replyStateError("d", "done", true)).toBe("dispatch d cannot receive a change in state done");
    expect(replyStateError("d", "done", true)).not.toContain("settled");
  });

  // megabrain_dispatch_meta_normalize (shell) rewrites a persisted "stalled" or "timeout" state to
  // "running" before any reader — including the reply state guard — ever sees it. A dispatch
  // stored as "stalled" must therefore be treated exactly like "running": reply is accepted and
  // (per orchestrate-reply.ts's own state!="done" guard) resumes the dispatch.
  test("normalizes legacy stalled/timeout states to running before any other reader sees them", () => {
    expect(normalizeDispatchState("stalled")).toBe("running");
    expect(normalizeDispatchState("timeout")).toBe("running");
    expect(normalizeDispatchState("running")).toBe("running");
    expect(normalizeDispatchState("done")).toBe("done");
    expect(normalizeDispatchState("")).toBe("");
  });

  test("a normalized stalled dispatch is accepted for reply, unlike a raw done or a raw unknown state", () => {
    expect(replyStateError("d", normalizeDispatchState("stalled"), false)).toBeUndefined();
    expect(replyStateError("d", normalizeDispatchState("timeout"), false)).toBeUndefined();
    // Without normalization "stalled" is not a recognised dispatch state at all (it never appears
    // in dispatchStates), so a caller that forgot to normalize would see the generic refusal below
    // rather than an accepted, resumed reply.
    expect(replyStateError("d", "stalled", false)).toContain("cannot receive a reply in state stalled");
  });

  test("supersedes unread and consumed deliveries differently", () => {
    expect(supersedeDelivery("outstanding", null, [1], false)).toEqual({ queued: 1, delivered: 0, deliveredSequences: [] });
    expect(supersedeDelivery("outstanding", "child", [2], false)).toEqual({ queued: 0, delivered: 1, deliveredSequences: [2] });
    expect(supersedeDelivery("acknowledged", "child", [3], false)).toEqual({ queued: 0, delivered: 1, deliveredSequences: [3] });
    expect(supersedeDelivery("outstanding", null, [4], true)).toEqual({ queued: 0, delivered: 0, deliveredSequences: [] });
  });

  test("combines supersede counts without losing sequence order", () => {
    expect(addSupersedeSummary({ queued: 1, delivered: 0, deliveredSequences: [] }, { queued: 0, delivered: 2, deliveredSequences: [4, 5] })).toEqual({ queued: 1, delivered: 2, deliveredSequences: [4, 5] });
  });
});

