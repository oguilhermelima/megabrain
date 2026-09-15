import { describe, expect, test } from "bun:test";
import { formatAdopt, parseAdoptOptions } from "../../src/core/worktree-adopt.js";

describe("worktree adopt", () => {
  test("parses the target and json option", () => {
    expect(parseAdoptOptions(["feature/one", "--json"])).toEqual({ kind: "ok", value: { target: "feature/one", json: true } });
  });

  test("rejects missing and unknown arguments with usage status", () => {
    expect(parseAdoptOptions([])).toEqual({ kind: "failed", error: "Usage: megabrain worktree adopt <path|branch> [--json]", exitCode: 2 });
    expect(parseAdoptOptions(["one", "two"])).toEqual({ kind: "failed", error: "unknown worktree adopt option: two", exitCode: 2 });
  });

  test("formats text and json results byte-stably", () => {
    const result = { worktree: "/shared/one", branch: "feature/one", workspace: "workspace-1" };
    expect(formatAdopt(result, false)).toBe("worktree: /shared/one\nbranch: feature/one\nworkspace: workspace-1\n");
    expect(formatAdopt(result, true)).toBe(`${JSON.stringify(result, null, 2)}\n`);
  });
});
