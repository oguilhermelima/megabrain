import { describe, expect, test } from "bun:test";
import { dispatchMessageHeader, formatDispatchMessage, formatFullDirection } from "../../src/core/chat-message-format.js";

const base = {
  dispatchId: "dispatch-12345678",
  chatName: "fix/chat-name-source",
  agent: "codex",
  type: "done",
  text: "Implemented it. Verified it. Nothing pending.",
  direction: "parent-bound" as const,
};

describe("dispatch message formatting", () => {
  test.each([
    ["done", "✅", "finished"], ["ask", "❓", "has a question"], ["stalled", "⚠️", "is stuck"],
    ["reply", "💬", "reply"], ["change", "🔀", "new direction"],
  ])("formats %s as %s %s", (type, icon, words) => {
    expect(dispatchMessageHeader({ ...base, type })).toBe(`${icon} codex · fix/chat-name-source ${words}`);
  });

  test("uses the coordinator identity for child-bound messages", () => {
    expect(dispatchMessageHeader({ ...base, direction: "child-bound", parentAgent: "claude", parentChatName: "main" }))
      .toBe("✅ claude · main finished");
  });

  test("uses the first sentence and removes leading bullet markers", () => {
    expect(formatDispatchMessage({ ...base, text: "- Chat names now show the branch. - Merged report has details.\nMore technical details." }))
      .toBe("✅ codex · fix/chat-name-source finished\nChat names now show the branch.\n→ details: megabrain orchestrate watch 12345678");
  });

  test("uses the shorter first line when it ends before the first sentence", () => {
    expect(formatDispatchMessage({ ...base, text: "A short summary line\nTechnical explanation follows. More details." }).split("\n")[1])
      .toBe("A short summary line");
  });

  test("cuts at a word boundary after 140 characters and adds an ellipsis", () => {
    const sentence = `${"clear words ".repeat(20)}finished.`;
    const summary = formatDispatchMessage({ ...base, text: sentence }).split("\n")[1]!;
    expect(summary).toBe(`${"clear words ".repeat(11)}clear…`);
    expect(summary.length).toBeLessThanOrEqual(140);
  });

  test("points parent-bound messages to the short dispatch id", () => {
    expect(formatDispatchMessage(base).split("\n")[2]).toBe("→ details: megabrain orchestrate watch 12345678");
  });

  test("points child-bound messages to the full text in check", () => {
    const result = formatDispatchMessage({ ...base, direction: "child-bound" });
    expect(result).toContain("\n→ full text: megabrain check");
  });

  test("keeps the full direction body after the new change header", () => {
    const direction = "Stop the current approach.\nUse this complete detailed direction.";
    expect(formatFullDirection({ ...base, type: "change" }, direction))
      .toBe(`🔀 codex · fix/chat-name-source new direction\n${direction}`);
  });
});
