import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter, type ProcessAdapter, type ProcessOutput } from "../../src/adapters/proc.js";
import { executeGithub } from "../../src/cli/commands/github.js";
import { route } from "../../src/cli/router.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { assertUnitStateDirectory } from "./state-db-guard.js";

// gh's own output for `pr list`, `issue list`, `pr view` and `issue view`, captured from real
// repositories and redacted to operator/sample and fake logins.
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/github/${name}`, import.meta.url), "utf8");

const PR_FIELDS = "number,title,state,author,labels,assignees,createdAt,updatedAt,url,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,comments,additions,deletions";
const ISSUE_FIELDS = "number,title,state,author,labels,assignees,createdAt,updatedAt,url,comments,milestone";

type GhCall = readonly string[];
type GhAnswer = (args: GhCall) => Result<ProcessOutput>;

let root = "";
let env: Record<string, string>;
let calls: GhCall[] = [];
let answer: GhAnswer = () => failed("gh was not expected");

const real = createProcessAdapter();
const fakeGh: ProcessAdapter = {
  run: async (command, args, options) => {
    if (command !== "gh") return real.run(command, args, options);
    calls.push(args);
    return answer(args);
  },
  startDetached: async () => failed("unexpected detached process"),
  invocationCount: () => calls.length,
};

const stdout = (text: string): Result<ProcessOutput> => ok({ stdout: text, stderr: "", exitCode: 0 });

function byCommand(args: GhCall): Result<ProcessOutput> {
  const [noun, verb] = args;
  if (noun === "pr" && verb === "list") return stdout(fixture("pr-list.json"));
  if (noun === "issue" && verb === "list") return stdout(fixture("issue-list.json"));
  if (noun === "pr" && verb === "view") return stdout(fixture("pr-view.json"));
  if (noun === "issue" && verb === "view") return stdout(fixture("issue-view.json"));
  return failed(`unexpected gh ${args.join(" ")}`);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await real.run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
}

async function repository(name: string, remote: string | null): Promise<string> {
  const path = join(root, name);
  mkdirSync(path);
  await git(path, "init", "-q", "-b", "main");
  if (remote !== null) await git(path, "remote", "add", "origin", remote);
  return path;
}

async function github(args: readonly string[], now = 1_800_000_000_000): Promise<Result<string>> {
  return executeGithub(args, env, fakeGh, () => now);
}

function parsed<T>(result: Result<string>): T {
  if (result.kind !== "ok") throw new Error(`expected success, got: ${result.error}`);
  return JSON.parse(result.value) as T;
}

type Check = { name: string; state: string };
type PullRequest = {
  number: number; title: string; state: string; isDraft: boolean;
  author: { login: string; name: string | null; isBot: boolean } | null;
  labels: { name: string; color: string; description: string }[];
  assignees: { login: string; name: string | null }[];
  createdAt: string; updatedAt: string; url: string; headRefName: string; baseRefName: string;
  reviewDecision: string | null; checks: Check[]; comments: number; additions: number; deletions: number;
};
type Issue = {
  number: number; title: string; state: string;
  author: { login: string; name: string | null; isBot: boolean } | null;
  labels: { name: string; color: string; description: string }[];
  assignees: { login: string; name: string | null }[];
  createdAt: string; updatedAt: string; url: string; comments: number;
  milestone: { title: string; dueOn: string | null } | null;
};
type Listing<T> = { repository: { nameWithOwner: string; url: string; path: string }; state: string; limit: number; fetchedAt: string; items: T[] };
type Detail = {
  repository: { nameWithOwner: string; url: string; path: string };
  number: number; title: string; state: string; isDraft?: boolean; url: string; body: string;
  author: { login: string } | null; createdAt: string | null;
  comments: { author: { login: string } | null; body: string; createdAt: string; url: string }[];
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-github-")));
  env = { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: join(root, "state") };
  mkdirSync(env.HOME as string);
  assertUnitStateDirectory(env);
  calls = [];
  answer = byCommand;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("github prs", () => {
  test("asks gh for the repository's open pull requests with every field the pages use", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const listing = parsed<Listing<PullRequest>>(await github(["prs", path, "--json"]));
    expect(calls).toEqual([["pr", "list", "-R", "operator/sample", "--state", "open", "--limit", "30", "--json", PR_FIELDS]]);
    expect(listing.repository).toEqual({ nameWithOwner: "operator/sample", url: "https://github.com/operator/sample", path });
    expect(listing.state).toBe("open");
    expect(listing.limit).toBe(30);
    expect(listing.fetchedAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(listing.items.map((item) => item.number)).toEqual([14700, 14699, 14707, 84]);
  });

  test("normalizes states, drafts, reviews, authors, labels and comment counts", async () => {
    const path = await repository("sample", "https://github.com/operator/sample.git");
    const [open, pending, merged, closed] = parsed<Listing<PullRequest>>(await github(["prs", path, "--state", "all", "--json"])).items;
    expect(open).toMatchObject({
      number: 14700,
      state: "open",
      isDraft: false,
      reviewDecision: "review_required",
      comments: 1,
      additions: 32,
      deletions: 0,
      headRefName: "docs/gh-skill-gh-api-field-passing",
      baseRefName: "trunk",
      url: "https://github.com/operator/sample/pull/14700",
      author: { login: "fake-maintainer", name: "Fake Maintainer", isBot: false },
      assignees: [],
    });
    expect(open?.labels).toEqual([
      { name: "external", color: "2700AF", description: "pull request originating outside of the CLI core team" },
      { name: "unmet-requirements", color: "ee2329", description: "" },
    ]);
    expect(pending?.reviewDecision).toBe("changes_requested");
    expect(merged).toMatchObject({ state: "merged", reviewDecision: "approved", author: { login: "app/dependabot", isBot: true }, comments: 0 });
    expect(closed).toMatchObject({ state: "closed", isDraft: true, reviewDecision: null, checks: [] });
  });

  test("turns check runs and commit statuses into one list of named check states", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const [open, pending, merged] = parsed<Listing<PullRequest>>(await github(["prs", path, "--json"])).items;
    expect(open?.checks).toEqual([
      { name: "label-external / label_issues", state: "success" },
      { name: "close-from-default-branch / close-from-default-branch", state: "skipped" },
      { name: "check-requirements / check-requirements", state: "failure" },
      { name: "check-requirements / close-unmet-requirements", state: "skipped" },
    ]);
    expect(pending?.checks).toEqual([
      { name: "label-external / label_issues", state: "pending" },
      { name: "ci/legacy", state: "pending" },
    ]);
    expect(merged?.checks.every((check) => check.state === "success" || check.state === "skipped")).toBe(true);
  });

  test("passes the requested state and limit through to gh", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect((await github(["prs", path, "--state", "merged", "--limit", "5", "--json"])).kind).toBe("ok");
    expect((await github(["prs", path, "--state", "closed", "--limit", "200", "--json"])).kind).toBe("ok");
    expect(calls.map((args) => args.slice(4, 8))).toEqual([["--state", "merged", "--limit", "5"], ["--state", "closed", "--limit", "200"]]);
  });

  test.each([
    [["--state", "draft"], "--state must be one of open, closed, merged, all"],
    [["--state"], "--state must be one of open, closed, merged, all"],
    [["--limit", "0"], "--limit must be a whole number from 1 to 1000"],
    [["--limit", "1001"], "--limit must be a whole number from 1 to 1000"],
    [["--limit", "ten"], "--limit must be a whole number from 1 to 1000"],
  ])("refuses %j before calling gh", async (flags, message) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = await github(["prs", path, ...flags, "--json"]);
    expect(result).toMatchObject({ kind: "failed", error: message, exitCode: 2 });
    expect(calls).toEqual([]);
  });

  test("prints one line per pull request without --json", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = await github(["prs", path]);
    expect(result.kind).toBe("ok");
    const lines = result.kind === "ok" ? result.value.trimEnd().split("\n") : [];
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("#14700\topen\tdocs/gh-skill-gh-api-field-passing\tfake-maintainer\t" + JSON.parse(fixture("pr-list.json"))[0].title);
    expect(lines[3]).toStartWith("#84\tclosed (draft)\t");
  });
});

describe("github issues", () => {
  test("asks gh for open issues and keeps milestones, assignees and comment counts", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const listing = parsed<Listing<Issue>>(await github(["issues", path, "--json"]));
    expect(calls).toEqual([["issue", "list", "-R", "operator/sample", "--state", "open", "--limit", "30", "--json", ISSUE_FIELDS]]);
    const [first, second] = listing.items;
    expect(first).toMatchObject({ number: 14704, state: "open", comments: 1, milestone: null, assignees: [], author: { login: "fake-triager", isBot: false } });
    expect(first?.labels).toEqual([{ name: "needs-triage", color: "D6393F", description: "needs to be reviewed" }]);
    expect(second).toMatchObject({ number: 14703, state: "closed", milestone: { title: "v2.102.0", dueOn: null } });
    expect(second?.assignees).toEqual([{ login: "fake-triager", name: "Fake Triager" }]);
  });

  test("accepts open, closed and all but not merged", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect((await github(["issues", path, "--state", "all", "--json"])).kind).toBe("ok");
    expect(await github(["issues", path, "--state", "merged", "--json"])).toMatchObject({ kind: "failed", error: "--state must be one of open, closed, all", exitCode: 2 });
    expect(calls).toHaveLength(1);
  });
});

describe("github pr and issue detail", () => {
  test("pr returns the body in markdown and every comment", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const detail = parsed<Detail>(await github(["pr", path, "14700", "--json"]));
    expect(calls).toEqual([["pr", "view", "14700", "-R", "operator/sample", "--json", "number,title,state,isDraft,url,author,createdAt,body,comments"]]);
    const raw = JSON.parse(fixture("pr-view.json")) as { body: string; comments: { body: string; createdAt: string; url: string; author: { login: string } }[] };
    expect(detail).toMatchObject({ number: 14700, state: "open", body: raw.body, repository: { nameWithOwner: "operator/sample" } });
    expect(detail.comments).toEqual(raw.comments.map((comment) => ({ author: { login: comment.author.login, name: null, isBot: false }, body: comment.body, createdAt: comment.createdAt, url: comment.url })));
  });

  test("issue returns the body and comments", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const detail = parsed<Detail>(await github(["issue", path, "14704", "--json"]));
    expect(calls).toEqual([["issue", "view", "14704", "-R", "operator/sample", "--json", "number,title,state,url,author,createdAt,body,comments"]]);
    expect(detail).toMatchObject({ number: 14704, state: "open" });
    expect(detail.comments).toHaveLength(1);
    expect(detail.body).toStartWith("### Describe the feature");
  });

  test.each([["pr"], ["issue"]])("%s refuses a missing or invalid number", async (verb) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github([verb, path, "--json"])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(await github([verb, path, "-3", "--json"])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toEqual([]);
  });
});

describe("github repository resolution", () => {
  test("finds a registered repository by name", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const added = await route(["repo", "add", path, "--json"], { environment: env, processAdapter: real });
    expect(added.kind).toBe("ok");
    const listing = parsed<Listing<PullRequest>>(await github(["prs", "sample", "--json"]));
    expect(listing.repository.path).toBe(path);
    expect(calls[0]?.[3]).toBe("operator/sample");
  });

  test("a worktree path resolves to its main checkout", async () => {
    const path = await repository("sample", "ssh://git@github.com/operator/sample.git");
    await git(path, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "-q", "--allow-empty", "-m", "initial");
    const tree = join(root, "sample-feature");
    await git(path, "worktree", "add", "-q", "-b", "feature", tree);
    const listing = parsed<Listing<Issue>>(await github(["issues", tree, "--json"]));
    expect(listing.repository).toEqual({ nameWithOwner: "operator/sample", url: "https://github.com/operator/sample", path });
  });

  test("an unknown repository is one clear line", async () => {
    expect(await github(["prs", "no-such-repository", "--json"])).toMatchObject({ kind: "failed", error: "repository not found: no-such-repository" });
    expect(calls).toEqual([]);
  });

  test.each([["git@gitlab.com:operator/sample.git"], [null]])("a repository whose remote is %p has no GitHub remote", async (remote) => {
    const path = await repository("sample", remote);
    expect(await github(["prs", path, "--json"])).toMatchObject({ kind: "failed", error: "sample has no GitHub remote" });
    expect(calls).toEqual([]);
  });
});

describe("github errors from gh", () => {
  test("a missing gh says how to install it", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("gh: executable not found");
    expect(await github(["prs", path, "--json"])).toMatchObject({ kind: "failed", error: "GitHub CLI (gh) is required; install it and sign in with gh auth login" });
  });

  test("a signed-out gh says to sign in", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.", 4);
    expect(await github(["issues", path, "--json"])).toMatchObject({ kind: "failed", error: "GitHub CLI is not signed in; run gh auth login" });
  });

  test("any other gh failure is its first line", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("GraphQL: Could not resolve to a Repository with the name 'operator/sample'. (repository)\nmore detail", 1);
    expect(await github(["pr", path, "7", "--json"])).toMatchObject({ kind: "failed", error: "gh pr view failed: GraphQL: Could not resolve to a Repository with the name 'operator/sample'. (repository)" });
  });

  test("output gh cannot have produced is refused rather than shown empty", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("not json");
    expect(await github(["prs", path, "--json"])).toMatchObject({ kind: "failed", error: "gh pr list returned output that is not JSON" });
  });
});

describe("github cache", () => {
  const cacheFiles = () => {
    const directory = join(env.MEGABRAIN_STATE_DIR as string, "cache", "github");
    try { return readdirSync(directory).map((name) => join(directory, name)); } catch { return []; }
  };

  test("answers a repeat within 60 seconds without calling gh, and refetches after", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const first = await github(["prs", path, "--json"], 1_000_000);
    const second = await github(["prs", path, "--json"], 1_059_999);
    expect(calls).toHaveLength(1);
    expect(second).toEqual(first);
    await github(["prs", path, "--json"], 1_060_000);
    expect(calls).toHaveLength(2);
  });

  test("keeps one entry per command, state, limit and number", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    for (const args of [["prs", path], ["prs", path, "--state", "all"], ["prs", path, "--limit", "5"], ["issues", path], ["pr", path, "1"], ["pr", path, "2"], ["issue", path, "1"]]) {
      await github([...args, "--json"]);
      await github([...args, "--json"]);
    }
    expect(calls).toHaveLength(7);
    expect(cacheFiles()).toHaveLength(7);
  });

  test("writes private files in a private directory and never caches a failure", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("HTTP 502: Bad Gateway", 1);
    expect((await github(["prs", path, "--json"])).kind).toBe("failed");
    expect(cacheFiles()).toEqual([]);
    answer = byCommand;
    expect((await github(["prs", path, "--json"])).kind).toBe("ok");
    expect(calls).toHaveLength(2);
    const [file] = cacheFiles();
    expect(file).toBeDefined();
    expect(statSync(join(env.MEGABRAIN_STATE_DIR as string, "cache", "github")).mode & 0o777).toBe(0o700);
    expect(statSync(file as string).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(env.MEGABRAIN_STATE_DIR as string, "cache", "github")).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("an unreadable cache file is ignored and replaced", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["prs", path, "--json"], 1_000_000);
    const [file] = cacheFiles();
    await Bun.write(file as string, "{broken");
    expect((await github(["prs", path, "--json"], 1_000_001)).kind).toBe("ok");
    expect(calls).toHaveLength(2);
  });
});

describe("github routing and usage", () => {
  const usage = {
    "github": "github prs|issues|pr|issue ...",
    "github-prs": "github prs <repo name|path> [--state open|closed|merged|all] [--limit <n>] [--json]",
    "github-issues": "github issues <repo name|path> [--state open|closed|all] [--limit <n>] [--json]",
    "github-pr": "github pr <repo name|path> <number> [--json]",
    "github-issue": "github issue <repo name|path> <number> [--json]",
  };

  test.each(Object.entries(usage))("%s --help prints its pinned usage", async (key, line) => {
    const args = key.split("-");
    expect(await route([...args, "--help"], { environment: env, processAdapter: fakeGh })).toEqual({ kind: "ok", value: `Usage: megabrain ${line}\n` });
  });

  test("the router reaches gh for github prs", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = await route(["github", "prs", path, "--json"], { environment: env, processAdapter: fakeGh });
    expect(result.kind).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  test("an unknown verb or a missing repository prints the usage", async () => {
    expect(await route(["github", "merge", "x"], { environment: env, processAdapter: fakeGh })).toMatchObject({ kind: "failed", error: `Usage: megabrain ${usage.github}`, exitCode: 2 });
    expect(await route(["github", "prs"], { environment: env, processAdapter: fakeGh })).toMatchObject({ kind: "failed", error: `Usage: megabrain ${usage["github-prs"]}`, exitCode: 2 });
  });
});
