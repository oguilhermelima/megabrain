import { describe, expect, test } from "bun:test";
import { formatDispatchMessage } from "../../src/core/chat-message-format.js";

const base = {
  dispatchId: "dispatch-12345678",
  chatName: "fix-chat-names",
  agent: "claude",
  type: "done",
  text: "Implemented it. Verified it. Nothing pending.",
  direction: "parent-bound" as const,
};

describe("dispatch message formatting", () => {
  test("keeps bullet lines and limits the body to four lines of 120 characters", () => {
    const text = ["- one", "* two", "- three", "- four", "- five"].join("\n");
    const result = formatDispatchMessage({ ...base, text });
    expect(result).toContain("\n- one\n* two\n- three\n- four\nFull report: megabrain orchestrate watch dispatch-12345678");
  });

  test("splits prose into sentence bullets", () => {
    expect(formatDispatchMessage(base)).toContain("\n- Implemented it.\n- Verified it.\n- Nothing pending.");
  });

  test("truncates long lines with an ellipsis and adds the report pointer", () => {
    const result = formatDispatchMessage({ ...base, text: "x".repeat(121) });
    const line = result.split("\n")[1]!;
    expect(line).toHaveLength(120);
    expect(line.endsWith("…")).toBe(true);
    expect(result).toContain("Full report: megabrain orchestrate watch dispatch-12345678");
  });

  test("adds the report pointer only when content was cut", () => {
    expect(formatDispatchMessage({ ...base, text: "Done." })).not.toContain("Full report:");
    expect(formatDispatchMessage({ ...base, text: "a. b. c. d. e." })).toContain("Full report:");
  });

  test.each([
    ["done", "FINISHED"], ["ask", "QUESTION"], ["stalled", "STUCK"], ["reply", "REPLY"], ["change", "NEW DIRECTION"],
  ])("maps %s to %s", (type, label) => {
    expect(formatDispatchMessage({ ...base, type })).toContain(` - ${label}\n`);
  });

  test("uses the coordinator identity for child-bound messages", () => {
    const result = formatDispatchMessage({ ...base, direction: "child-bound", parentAgent: "codex", parentChatName: "megabrain/main" });
    expect(result.split("\n")[0]).toBe("[megabrain][codex][12345678 - megabrain/main] - FINISHED");
  });
});
