import { describe, expect, test } from "bun:test";
import { addSupersedeSummary, parseParentChangeArgs, parseParentReplyArgs, replyStateError, supersedeDelivery } from "../../src/core/parent-reply.js";

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
  test("allows active states and refuses settled reply states", () => {
    expect(replyStateError("d", "running", false)).toBeUndefined();
    expect(replyStateError("d", "done", false)).toBeUndefined();
    expect(replyStateError("d", "failed", false)).toContain("settled");
    expect(replyStateError("d", "failed", true)).toContain("cannot receive a change");
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

