import { describe, expect, test } from "bun:test";
import { classifyQueueMail, nextMessageSequence, parseChildMessage, recipientForQueueMessage } from "../../src/core/queue-write.js";

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
    ["ask", [], "Usage: megabrain ask \"question\"\n"],
    ["ask", [""], "Usage: megabrain ask \"question\"\n"],
    ["ask", ["--text"], "Usage: megabrain ask \"question\"\n"],
    ["ask", ["--text", ""], "Usage: megabrain ask \"question\"\n"],
    ["ask", ["question", "--text", "other"], "Usage: megabrain ask \"question\"\n"],
    ["done", [], "Usage: megabrain done \"summary\"\n"],
    ["done", [""], "Usage: megabrain done \"summary\"\n"],
    ["done", ["--text"], "Usage: megabrain done \"summary\"\n"],
    ["done", ["--text", ""], "Usage: megabrain done \"summary\"\n"],
    ["done", ["summary", "--text", "other"], "Usage: megabrain done \"summary\"\n"],
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
