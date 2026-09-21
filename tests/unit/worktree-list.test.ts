import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { executeWorktreeList } from "../../src/cli/commands/worktree-list.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import {
  formatWorktreeList,
  parseGitWorktrees,
  parseParentConfig,
  parsePullRequests,
  parseWorkspacePaths,
  type WorktreeListEntry,
} from "../../src/core/worktree-list.js";

const entries: WorktreeListEntry[] = [
  { path: "/shared/detached", branch: "detached", parent: null, inSuperset: false, inSharedRoot: true, pullRequest: null },
  { path: "/shared/one", branch: "feature/one", parent: null, inSuperset: true, inSharedRoot: true, pullRequest: { number: 7, state: "OPEN", url: "https://example.test/7" } },
];

type Fixture = {
  readonly root: string;
  readonly state: string;
  readonly shared: string;
  readonly repo: string;
  readonly linked: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "megabrain-worktree-list-unit-")));
  const state = join(root, "state");
  const shared = join(root, "shared");
  const repo = join(root, "repo");
  const linked = join(shared, "linked");
  await mkdir(join(state), { recursive: true });
  await mkdir(join(shared), { recursive: true });
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(join(state, "worktree-root"), `${shared}\n`);
  return { root, state, shared, repo, linked };
}

function processFor(routes: (command: string, args: readonly string[]) => Result<ProcessOutput>): ProcessAdapter {
  return {
    run: async (command, args) => routes(command, args),
    startDetached: async () => failed("not used"),
    invocationCount: () => 0,
  };
}

function output(stdout: string): Result<ProcessOutput> {
  return ok({ stdout, stderr: "", exitCode: 0 });
}

function gitWorktrees(repo: string, linked: string, outside: string): string {
  return [
    `worktree ${repo}`,
    "HEAD abc",
    "branch refs/heads/main",
    "",
    `worktree ${linked}`,
    "HEAD def",
    "branch refs/heads/feature/linked",
    "",
    `worktree ${outside}`,
    "HEAD ghi",
    "branch refs/heads/feature/outside",
    "",
  ].join("\n");
}

function commandOutput(command: string): Result<ProcessOutput> {
  if (command === "superset" || command === "orca" || command === "gh") return output("[]\n");
  return failed(`unexpected command: ${command}`);
}

async function listForRepo(fixture: Fixture, records: string, selector = fixture.repo): Promise<Result<string>> {
  const process = processFor((command, args) => {
    if (command !== "git") return commandOutput(command);
    const path = args[1];
    const gitArgs = args.slice(2);
    if (gitArgs[0] === "rev-parse" && gitArgs[gitArgs.length - 1] === "--show-toplevel") {
      return path === selector ? output(`${fixture.repo}\n`) : failed("not a git repository");
    }
    if (path === fixture.repo && gitArgs[0] === "rev-parse" && gitArgs.includes("--git-common-dir")) return output(`${fixture.repo}/.git\n`);
    if (path === fixture.repo && gitArgs[0] === "worktree") return output(records);
    if (path === fixture.repo && gitArgs[0] === "config") return failed("no parent config");
    return failed(`unexpected git call: ${args.join(" ")}`);
  });
  return executeWorktreeList(["--repo", selector, "--json"], { MEGABRAIN_STATE_DIR: fixture.state }, process);
}

function paths(result: Result<string>): string[] {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") return [];
  return (JSON.parse(result.value) as Array<{ readonly path: string }>).map((entry) => entry.path);
}

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

describe("executeWorktreeList", () => {
  test("lists a named repository whose worktrees are outside the shared root", async () => {
    const fixture = await createFixture();
    const outside = join(fixture.repo, "remove-cognito");
    const ignored = join(fixture.root, "ignored");
    await mkdir(outside);
    await mkdir(ignored);
    const result = await listForRepo(fixture, gitWorktrees(fixture.repo, outside, ignored));

    expect(paths(result)).toEqual([fixture.repo, outside]);
  });

  test("lists a named repository whose linked worktree is under the shared root", async () => {
    const fixture = await createFixture();
    const ignored = join(fixture.root, "ignored");
    await mkdir(ignored);
    const result = await listForRepo(fixture, gitWorktrees(fixture.repo, fixture.linked, ignored));

    expect(paths(result)).toEqual([fixture.repo, fixture.linked]);
  });

  test("refuses a repository Git cannot resolve and names the selector", async () => {
    const fixture = await createFixture();
    const result = await listForRepo(fixture, "", "missing-repo");

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("missing-repo");
  });

  test("keeps the shared-root scan when no repository is named", async () => {
    const fixture = await createFixture();
    const repoUnderRoot = join(fixture.shared, "repo");
    const inside = join(repoUnderRoot, "inside");
    await mkdir(join(repoUnderRoot, ".git"), { recursive: true });
    await mkdir(inside);
    const process = processFor((command, args) => {
      if (command !== "git") return commandOutput(command);
      const path = args[1];
      const gitArgs = args.slice(2);
      if (path === repoUnderRoot && gitArgs[0] === "worktree") return output(gitWorktrees(repoUnderRoot, inside, join(fixture.root, "ignored")));
      if (path === repoUnderRoot && gitArgs[0] === "config") return failed("no parent config");
      return failed(`unexpected git call: ${args.join(" ")}`);
    });
    const result = await executeWorktreeList(["--json"], { MEGABRAIN_STATE_DIR: fixture.state }, process);

    expect(paths(result)).toEqual([repoUnderRoot, inside]);
  });
});
