import { describe, expect, test } from "bun:test";
import {
  formatWorktreeList,
  parseGitWorktrees,
  parseParentConfig,
  parsePullRequests,
  parseWorkspacePaths,
  type WorktreeListEntry,
} from "../../src/core/worktree-list.js";

const entries: WorktreeListEntry[] = [
  { path: "/shared/detached", branch: "detached", parent: null, inSuperset: false, pullRequest: null },
  { path: "/shared/one", branch: "feature/one", parent: null, inSuperset: true, pullRequest: { number: 7, state: "OPEN", url: "https://example.test/7" } },
];

describe("parseGitWorktrees", () => {
  test("parses linked and detached records and keeps repository identity", () => {
    expect(parseGitWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /shared/detached\nHEAD def\ndetached\n\n", "/repo/.git")).toEqual([
      { path: "/repo", branch: "main", repository: "/repo/.git" },
      { path: "/shared/detached", branch: "detached", repository: "/repo/.git" },
    ]);
  });

  test("flushes a final porcelain record without a trailing blank line", () => {
    expect(parseGitWorktrees("worktree /repo\nHEAD abc\nbranch refs/heads/main\n", "/repo/.git")).toEqual([
      { path: "/repo", branch: "main", repository: "/repo/.git" },
    ]);
  });
});

describe("worktree metadata", () => {
  test("parses parent config by repository and branch", () => {
    expect(parseParentConfig("branch.feature/child.megabrain-parent parent\n", "/repo/.git")).toEqual([
      { repository: "/repo/.git", branch: "feature/child", parent: "parent" },
    ]);
  });

  test("accepts the supported Superset workspace shapes", () => {
    expect(parseWorkspacePaths({ result: { workspaces: [{ worktreePath: "/shared/one" }] } })).toEqual(new Set(["/shared/one"]));
    expect(parseWorkspacePaths([{ path: "/shared/two" }])).toEqual(new Set(["/shared/two"]));
    expect(parseWorkspacePaths({ invalid: true })).toEqual(new Set());
  });

  test("matches pull requests by head branch and ignores malformed entries", () => {
    expect(parsePullRequests([{ headRefName: "feature/one", number: 7, state: "OPEN", url: "https://example.test/7" }, { number: "bad" }])).toEqual(new Map([
      ["feature/one", { number: 7, state: "OPEN", url: "https://example.test/7" }],
    ]));
  });
});

describe("formatWorktreeList", () => {
  test("formats byte-stable JSON, flat, and tree output", () => {
    expect(formatWorktreeList(entries, { json: true, flat: false })).toBe(`${JSON.stringify(entries, null, 2)}\n`);
    expect(formatWorktreeList(entries, { json: false, flat: true })).toBe(
      "PATH                                                 BRANCH                           IN_SUPERSET\n" +
      "/shared/detached                                      detached                         no\n" +
      "/shared/one                                           feature/one                      yes\n",
    );
    expect(formatWorktreeList(entries, { json: false, flat: false })).toBe(
      "BRANCH                                               PATH\n" +
      "detached /shared/detached\n" +
      "feature/one /shared/one [OPEN]\n",
    );
  });
});
