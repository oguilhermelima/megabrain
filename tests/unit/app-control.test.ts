import { describe, expect, test } from "bun:test";
import { parseAppTarget, parsePaneTarget } from "../../src/cli/commands/app.js";

describe("app layout target parsing", () => {
  test.each([
    ["chat:123", { kind: "chat", id: "123" }],
    ["session:codex:thread-1", { kind: "session", id: "codex:thread-1" }],
    ["terminal:t-1", { kind: "terminal", id: "t-1" }],
    ["worktree:/repo", { kind: "worktree", path: "/repo" }],
    ["file:/repo/a.ts:42", { kind: "file", path: "/repo/a.ts", line: 42 }],
    ["url:https://example.com", { kind: "url", url: "https://example.com" }],
    ["page:knowledge/topic", { kind: "page", page: "knowledge", sub: "topic" }],
  ] as const)("parses %s", (target, expected) => {
    expect(parseAppTarget(target)).toEqual(expected);
  });

  test.each(["chat:", "file:relative.ts", "file:/repo/a.ts:0", "url:file:///tmp/x", "page:unknown", "page:tasks/a/b"])("rejects invalid target %s", (target) => {
    expect(() => parseAppTarget(target)).toThrow();
  });

  test("accepts pane ids and target references, rejecting empty references", () => {
    expect(parsePaneTarget("pane-1")).toBe("pane-1");
    expect(() => parsePaneTarget("")).toThrow();
  });
});
