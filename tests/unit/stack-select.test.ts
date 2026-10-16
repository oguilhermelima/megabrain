import { describe, expect, test } from "bun:test";
import { linearStack, selectStack } from "../../src/cli/commands/stack.js";

type Row = Parameters<typeof selectStack>[0][number];

function row(branch: string, parentBranch: string | null, finishedAt: string | null = null): Row {
  return {
    path: `/shared/${branch.replaceAll("/", "-")}`, repo: "/repo", repoName: "repo", branch, createdAt: "2026-10-16T00:00:00.000Z",
    createdBy: null, purpose: null, origin: "created", finishedAt, parentBranch,
  };
}

function branches(result: ReturnType<typeof selectStack>): string[] {
  if (result.kind !== "ok") throw new Error(result.kind === "failed" ? result.error : "unexpected");
  return result.value.branches.map((item) => item.branch);
}

describe("stack selection", () => {
  test("without a member, the single chain from the default branch is kept", () => {
    const rows = [row("a", "main"), row("b", "a"), row("c", "b")];
    expect(branches(selectStack(rows, "main"))).toEqual(["a", "b", "c"]);
  });

  test("a member picks its own chain when two stacks start on the default branch", () => {
    const rows = [row("a", "main"), row("b", "a"), row("x", "main"), row("y", "x"), row("z", "y")];
    expect(branches(selectStack(rows, "main"))).toEqual([]);
    expect(branches(selectStack(rows, "main", "b"))).toEqual(["a", "b"]);
    expect(branches(selectStack(rows, "main", "x"))).toEqual(["x", "y", "z"]);
  });

  test("a root with no recorded parent is found from its tip", () => {
    const rows = [row("root", null), row("mid", "root"), row("tip", "mid")];
    expect(branches(selectStack(rows, "main"))).toEqual([]);
    expect(branches(selectStack(rows, "main", "tip"))).toEqual(["root", "mid", "tip"]);
  });

  test("a root based on a branch that is not a registered worktree keeps that base", () => {
    const rows = [row("root", "release/1"), row("tip", "root")];
    const selected = selectStack(rows, "main", "root");
    expect(branches(selected)).toEqual(["root", "tip"]);
    if (selected.kind === "ok") expect(selected.value.branches[0]?.parentBranch).toBe("release/1");
  });

  test("the walk up stops at the default branch even when it is registered", () => {
    const rows = [row("main", null), row("a", "main"), row("b", "a")];
    expect(branches(selectStack(rows, "main", "b"))).toEqual(["a", "b"]);
  });

  test("finished worktrees are not members", () => {
    const rows = [row("a", "main"), row("b", "a", "2026-10-15T00:00:00.000Z"), row("c", "b")];
    expect(branches(selectStack(rows, "main", "a"))).toEqual(["a"]);
    expect(branches(selectStack(rows, "main", "c"))).toEqual(["c"]);
  });

  test("a fork shows the path to the member and marks the other children as forks", () => {
    const rows = [row("a", "main"), row("b1", "a"), row("b2", "a"), row("c", "b1")];
    const selected = selectStack(rows, "main", "c");
    expect(branches(selected)).toEqual(["a", "b1", "c"]);
    if (selected.kind === "ok") expect(selected.value.forks).toEqual([{ branch: "b2", parent: "a" }]);
  });

  test("a member with two children stops there and marks both as forks", () => {
    const rows = [row("a", "main"), row("b1", "a"), row("b2", "a")];
    const selected = selectStack(rows, "main", "a");
    expect(branches(selected)).toEqual(["a"]);
    if (selected.kind === "ok") expect(selected.value.forks).toEqual([{ branch: "b1", parent: "a" }, { branch: "b2", parent: "a" }]);
  });

  test("pr, sync and merge refuse a forked stack and name the fork point", () => {
    const rows = [row("a", "main"), row("b1", "a"), row("b2", "a")];
    const selected = selectStack(rows, "main", "b1");
    if (selected.kind !== "ok") throw new Error(selected.error);
    const linear = linearStack(selected.value);
    expect(linear.kind).toBe("failed");
    if (linear.kind === "failed") {
      expect(linear.error).toContain("forks at a");
      expect(linear.error).toContain("b2");
    }
    const straight = selectStack([row("a", "main"), row("b", "a")], "main", "b");
    if (straight.kind !== "ok") throw new Error(straight.error);
    expect(linearStack(straight.value).kind).toBe("ok");
  });

  test("a parent cycle ends the walk instead of looping", () => {
    const rows = [row("p", "q"), row("q", "p")];
    const selected = selectStack(rows, "main", "p");
    expect(branches(selected)).toEqual(["q", "p"]);
  });

  test("a member that is not a registered worktree is refused", () => {
    const selected = selectStack([row("a", "main")], "main", "ghost");
    expect(selected.kind).toBe("failed");
    if (selected.kind === "failed") expect(selected.error).toContain("ghost");
  });
});
