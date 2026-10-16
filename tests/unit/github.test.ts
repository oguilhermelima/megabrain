import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter, type ProcessAdapter, type ProcessOutput } from "../../src/adapters/proc.js";
import { executeGithub } from "../../src/cli/commands/github.js";
import { route } from "../../src/cli/router.js";
import { failed, ok, type Result } from "../../src/core/result.js";
import { assertUnitStateDirectory } from "./state-db-guard.js";

// gh's own output for the list queries (gh api graphql), `pr view` and `issue view`, captured from
// real repositories and redacted to operator/sample and fake logins. pr-list.json keeps real
// statusCheckRollup entries of both kinds (check runs and commit statuses).
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/github/${name}`, import.meta.url), "utf8");

const PR_VIEW_FIELDS = "number,title,state,isDraft,url,author,createdAt,body,comments,reviewDecision,statusCheckRollup,additions,deletions,headRefName,baseRefName";
const ISSUE_VIEW_FIELDS = "number,title,state,url,author,createdAt,body,comments";
// What made GitHub's GraphQL time out on a whole listing: none of it belongs in a list query.
const HEAVY_FIELDS = ["statusCheckRollup", "reviewDecision", "additions", "deletions", "commits", "reviews", "files"];

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

const query = (args: GhCall): string => (args.find((arg) => arg.startsWith("query=")) ?? "").slice("query=".length);
const variables = (args: GhCall): Record<string, string[]> => {
  const found: Record<string, string[]> = {};
  args.forEach((arg, index) => {
    if ((arg !== "-f" && arg !== "-F") || index + 1 >= args.length) return;
    const [name = "", ...value] = (args[index + 1] ?? "").split("=");
    if (name === "query") return;
    found[name] = [...(found[name] ?? []), value.join("=")];
  });
  return found;
};
const isPullRequestQuery = (args: GhCall) => args[0] === "api" && args[1] === "graphql" && query(args).includes("pullRequests(");
const isIssueQuery = (args: GhCall) => args[0] === "api" && args[1] === "graphql" && query(args).includes("issues(");

function byCommand(args: GhCall): Result<ProcessOutput> {
  const [noun, verb] = args;
  if (isPullRequestQuery(args)) return stdout(fixture("pr-list-graphql.json"));
  if (isIssueQuery(args)) return stdout(fixture("issue-list-graphql.json"));
  if (noun === "pr" && verb === "view") return stdout(fixture("pr-view.json"));
  if (noun === "issue" && verb === "view") return stdout(fixture("issue-view.json"));
  return failed(`unexpected gh ${args.join(" ")}`);
}

/** The pull request page fixture with its page info replaced, for the last page of a listing. */
function lastPage(name: string): string {
  const raw = JSON.parse(fixture(name)) as { data: { repository: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } };
  raw.data.repository.items.pageInfo = { hasNextPage: false, endCursor: "Y3Vyc29yOmxhc3Q=" };
  return JSON.stringify(raw);
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

type Person = { login: string; name: string | null; isBot: boolean };
type Label = { name: string; color: string; description: string };
type PullRequest = {
  number: number; title: string; state: string; isDraft: boolean; author: Person | null; labels: Label[];
  createdAt: string; updatedAt: string; url: string; headRefName: string; baseRefName: string; comments: number;
};
type Issue = {
  number: number; title: string; state: string; author: Person | null; labels: Label[];
  assignees: { login: string; name: string | null }[];
  createdAt: string; updatedAt: string; url: string; comments: number;
  milestone: { title: string; dueOn: string | null } | null;
};
type Listing<T> = {
  repository: { nameWithOwner: string; url: string; path: string };
  state: string; limit: number; after: string | null; fetchedAt: string;
  counts: Record<string, number>; totalCount: number; nextCursor: string | null; items: T[];
};
type Detail = {
  repository: { nameWithOwner: string; url: string; path: string };
  number: number; title: string; state: string; isDraft?: boolean; url: string; body: string;
  author: { login: string } | null; createdAt: string | null;
  comments: { author: { login: string } | null; body: string; createdAt: string; url: string }[];
  reviewDecision?: string | null; checks?: { name: string; state: string }[]; additions?: number; deletions?: number;
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
  test("asks GitHub for one page of 30 open pull requests in a single light query", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const listing = parsed<Listing<PullRequest>>(await github(["prs", path, "--json"]));
    expect(calls).toHaveLength(1);
    const [call = []] = calls;
    expect(call.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(variables(call)).toEqual({ owner: ["operator"], name: ["sample"], first: ["30"], "states[]": ["OPEN"] });
    expect(listing.repository).toEqual({ nameWithOwner: "operator/sample", url: "https://github.com/operator/sample", path });
    expect(listing).toMatchObject({ state: "open", limit: 30, after: null, fetchedAt: new Date(1_800_000_000_000).toISOString() });
    expect(listing.items.map((item) => item.number)).toEqual([14678, 14679, 14706, 14659]);
  });

  test("the list query asks only for light fields; checks, reviews and line counts wait for the detail", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["prs", path, "--state", "all", "--json"]);
    const text = query(calls[0] ?? []);
    expect(text).toContain("pullRequests(");
    for (const field of HEAVY_FIELDS) expect(text).not.toContain(field);
    // A count is a number, not a list of every comment.
    expect(text).toMatch(/comments\s*\{\s*totalCount\s*\}/);
  });

  test("normalizes states, drafts, bots, labels and comment counts", async () => {
    const path = await repository("sample", "https://github.com/operator/sample.git");
    const [open, draft, merged, closed] = parsed<Listing<PullRequest>>(await github(["prs", path, "--state", "all", "--json"])).items;
    expect(open).toEqual({
      number: 14678,
      title: expect.any(String),
      state: "open",
      isDraft: false,
      author: { login: "fake-maintainer", name: "Fake maintainer", isBot: false },
      labels: [],
      createdAt: "2026-10-14T04:39:25Z",
      updatedAt: expect.any(String),
      url: "https://github.com/operator/sample/pull/14678",
      headRefName: expect.any(String),
      baseRefName: "fake-maintainer/artifact-review-feedback",
      comments: 0,
    });
    expect(draft).toMatchObject({ number: 14679, state: "open", isDraft: true });
    expect(merged).toMatchObject({ state: "merged", author: { login: "app/dependabot", name: null, isBot: true } });
    expect(merged?.labels.map((label) => label.name)).toEqual(["dependencies", "github_actions"]);
    expect(merged?.labels[0]).toEqual({ name: "dependencies", color: "0366d6", description: "Pull requests that update a dependency file" });
    expect(closed).toMatchObject({ number: 14659, state: "closed", comments: 2 });
  });

  test("reports every state's total and the cursor of the next page", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const listing = parsed<Listing<PullRequest>>(await github(["prs", path, "--state", "all", "--json"]));
    expect(listing.counts).toEqual({ open: 79, merged: 3282, closed: 1368, all: 4729 });
    expect(listing.totalCount).toBe(4729);
    expect(listing.nextCursor).toBe(JSON.parse(fixture("pr-list-graphql.json")).data.repository.items.pageInfo.endCursor);
  });

  test("--after asks for the page after a cursor, and the last page has no next cursor", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(lastPage("pr-list-graphql.json"));
    const listing = parsed<Listing<PullRequest>>(await github(["prs", path, "--state", "merged", "--limit", "30", "--after", "Y3Vyc29yOnYyOpK0", "--json"]));
    expect(variables(calls[0] ?? [])).toEqual({ owner: ["operator"], name: ["sample"], first: ["30"], "states[]": ["MERGED"], after: ["Y3Vyc29yOnYyOpK0"] });
    expect(listing.after).toBe("Y3Vyc29yOnYyOpK0");
    expect(listing.nextCursor).toBeNull();
  });

  test("passes each state through, and all asks for every state", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    for (const state of ["open", "closed", "merged", "all"]) expect((await github(["prs", path, "--state", state, "--limit", "5", "--json"])).kind).toBe("ok");
    expect(calls.map((call) => variables(call)["states[]"] ?? [])).toEqual([["OPEN"], ["CLOSED"], ["MERGED"], []]);
    expect(calls.map((call) => variables(call).first)).toEqual([["5"], ["5"], ["5"], ["5"]]);
  });

  test.each([
    [["--state", "draft"], "--state must be one of open, closed, merged, all"],
    [["--state"], "--state must be one of open, closed, merged, all"],
    [["--limit", "0"], "--limit must be a whole number from 1 to 100"],
    [["--limit", "101"], "--limit must be a whole number from 1 to 100"],
    [["--limit", "ten"], "--limit must be a whole number from 1 to 100"],
    [["--after"], "--after needs the cursor of the previous page"],
    [["--after", ""], "--after needs the cursor of the previous page"],
  ])("refuses %j before calling gh", async (flags, message) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = await github(["prs", path, ...flags, "--json"]);
    expect(result).toMatchObject({ kind: "failed", error: message, exitCode: 2 });
    expect(calls).toEqual([]);
  });

  test("prints one line per pull request without --json", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = await github(["prs", path, "--state", "all"]);
    expect(result.kind).toBe("ok");
    const lines = result.kind === "ok" ? result.value.trimEnd().split("\n") : [];
    expect(lines).toHaveLength(4);
    expect(lines[1]).toStartWith("#14679\topen (draft)\t");
    expect(lines[2]).toContain("\tapp/dependabot\t");
  });
});

describe("github issues", () => {
  test("asks for open issues in one light query and keeps milestones, assignees and comment counts", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const listing = parsed<Listing<Issue>>(await github(["issues", path, "--state", "all", "--json"]));
    expect(calls).toHaveLength(1);
    expect(variables(calls[0] ?? [])).toEqual({ owner: ["operator"], name: ["sample"], first: ["30"] });
    for (const field of HEAVY_FIELDS) expect(query(calls[0] ?? [])).not.toContain(field);
    const [open, closed, planned] = listing.items;
    expect(open).toMatchObject({ number: 14702, state: "open", comments: 7, milestone: null, assignees: [], author: { login: "app/cli-triage", isBot: true } });
    expect(open?.labels.map((label) => label.name)).toEqual(["needs-triage", "agentic-workflows"]);
    expect(closed).toMatchObject({ number: 14699, state: "closed", author: { login: "fake-reporter", name: null, isBot: false } });
    expect(planned).toMatchObject({ number: 296122, milestone: { title: "1.143.0", dueOn: "2026-10-19T00:00:00Z" } });
    expect(planned?.assignees).toEqual([{ login: "fake-assignee", name: "Fake assignee" }]);
    expect(listing.counts).toEqual({ open: 1042, closed: 5507, all: 6549 });
    expect(listing.nextCursor).toBe(JSON.parse(fixture("issue-list-graphql.json")).data.repository.items.pageInfo.endCursor);
  });

  test("accepts open, closed and all but not merged", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect((await github(["issues", path, "--state", "closed", "--json"])).kind).toBe("ok");
    expect(variables(calls[0] ?? [])["states[]"]).toEqual(["CLOSED"]);
    expect(await github(["issues", path, "--state", "merged", "--json"])).toMatchObject({ kind: "failed", error: "--state must be one of open, closed, all", exitCode: 2 });
    expect(calls).toHaveLength(1);
  });

  test("pages with --after like pull requests", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(lastPage("issue-list-graphql.json"));
    const listing = parsed<Listing<Issue>>(await github(["issues", path, "--after", "Y3Vyc29yOmlzc3Vl", "--json"]));
    expect(variables(calls[0] ?? []).after).toEqual(["Y3Vyc29yOmlzc3Vl"]);
    expect(listing.nextCursor).toBeNull();
  });
});

describe("github pr and issue detail", () => {
  test("pr carries the body, comments, review decision, checks and line counts", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const detail = parsed<Detail>(await github(["pr", path, "14700", "--json"]));
    expect(calls).toEqual([["pr", "view", "14700", "-R", "operator/sample", "--json", PR_VIEW_FIELDS]]);
    const raw = JSON.parse(fixture("pr-view.json")) as { body: string; comments: { body: string; createdAt: string; url: string; author: { login: string } }[] };
    expect(detail).toMatchObject({ number: 14700, state: "open", isDraft: false, body: raw.body, repository: { nameWithOwner: "operator/sample" } });
    expect(detail.comments).toEqual(raw.comments.map((comment) => ({ author: { login: comment.author.login, name: null, isBot: false }, body: comment.body, createdAt: comment.createdAt, url: comment.url })));
    expect(detail).toMatchObject({ reviewDecision: "review_required", additions: 32, deletions: 0 });
    expect(detail.checks?.slice(0, 3)).toEqual([
      { name: "label-external / label_issues", state: "success" },
      { name: "close-from-default-branch / close-from-default-branch", state: "skipped" },
      { name: "check-requirements / check-requirements", state: "success" },
    ]);
    expect(detail.checks).toHaveLength(7);
  });

  test("turns check runs and commit statuses into one list of named check states", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const listed = JSON.parse(fixture("pr-list.json")) as { statusCheckRollup: unknown[] }[];
    const view = JSON.parse(fixture("pr-view.json")) as Record<string, unknown>;
    answer = () => stdout(JSON.stringify({ ...view, statusCheckRollup: [...(listed[0]?.statusCheckRollup ?? []), ...(listed[1]?.statusCheckRollup ?? [])] }));
    const detail = parsed<Detail>(await github(["pr", path, "14700", "--json"]));
    expect(detail.checks).toEqual([
      { name: "label-external / label_issues", state: "success" },
      { name: "close-from-default-branch / close-from-default-branch", state: "skipped" },
      { name: "check-requirements / check-requirements", state: "failure" },
      { name: "check-requirements / close-unmet-requirements", state: "skipped" },
      { name: "label-external / label_issues", state: "pending" },
      { name: "ci/legacy", state: "pending" },
    ]);
  });

  test("issue returns the body and comments", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const detail = parsed<Detail>(await github(["issue", path, "14704", "--json"]));
    expect(calls).toEqual([["issue", "view", "14704", "-R", "operator/sample", "--json", ISSUE_VIEW_FIELDS]]);
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
    expect(variables(calls[0] ?? [])).toMatchObject({ owner: ["operator"], name: ["sample"] });
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
  const timeout = "HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)";

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

  test("any other gh failure is its first line, asked once", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("GraphQL: Could not resolve to a Repository with the name 'operator/sample'. (repository)\nmore detail", 1);
    expect(await github(["pr", path, "7", "--json"])).toMatchObject({ kind: "failed", error: "gh pr view failed: GraphQL: Could not resolve to a Repository with the name 'operator/sample'. (repository)" });
    expect(calls).toHaveLength(1);
  });

  test("a GitHub timeout is asked again once and succeeds quietly", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    let attempt = 0;
    answer = (args) => (attempt++ === 0 ? failed(timeout, 1) : byCommand(args));
    const listing = parsed<Listing<PullRequest>>(await github(["prs", path, "--state", "all", "--json"]));
    expect(listing.items).toHaveLength(4);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0] ?? []);
  });

  test("a second timeout says GitHub timed out and to try again, with gh's own line", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed(`${timeout}\n`, 1);
    expect(await github(["prs", path, "--state", "all", "--json"])).toMatchObject({ kind: "failed", error: `gh api graphql failed: GitHub timed out, try again (${timeout})` });
    expect(calls).toHaveLength(2);
  });

  test.each([
    ["HTTP 502: Bad Gateway (https://api.github.com/graphql)", "GitHub is unavailable, try again"],
    ["HTTP 503: Service Unavailable (https://api.github.com/graphql)", "GitHub is unavailable, try again"],
    ["unexpected end of JSON input", "GitHub sent an incomplete answer, try again"],
  ])("%s is retried once, then explained", async (line, explanation) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed(line, 1);
    expect(await github(["issues", path, "--json"])).toMatchObject({ kind: "failed", error: `gh api graphql failed: ${explanation} (${line})` });
    expect(calls).toHaveLength(2);
  });

  test("a detail call is retried on a timeout too", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed(timeout, 1);
    expect(await github(["pr", path, "14700", "--json"])).toMatchObject({ kind: "failed", error: `gh pr view failed: GitHub timed out, try again (${timeout})` });
    expect(calls).toHaveLength(2);
  });

  test("empty output is never parsed: asked again once, then a clear error", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("");
    const result = await github(["prs", path, "--json"]);
    expect(result).toMatchObject({ kind: "failed", error: "gh api graphql returned nothing, try again" });
    expect(result.kind === "failed" ? result.error : "").not.toContain("JSON");
    expect(calls).toHaveLength(2);
  });

  test("whitespace-only output counts as empty, and a good second answer is used", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    let attempt = 0;
    answer = (args) => (attempt++ === 0 ? stdout("\n  \n") : byCommand(args));
    expect((await github(["issues", path, "--json"])).kind).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  test("output gh cannot have produced is refused rather than shown empty", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("not json");
    expect(await github(["prs", path, "--json"])).toMatchObject({ kind: "failed", error: "gh api graphql returned output that is not JSON" });
    answer = () => stdout(JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository with the name 'operator/sample'." }] }));
    expect(await github(["prs", path, "--json"])).toMatchObject({ kind: "failed", error: "gh api graphql failed: Could not resolve to a Repository with the name 'operator/sample'." });
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

  test("keeps one entry per command, state, limit, page and number", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    for (const args of [["prs", path], ["prs", path, "--state", "all"], ["prs", path, "--limit", "5"], ["prs", path, "--after", "Y3Vyc29yOjE="], ["prs", path, "--after", "Y3Vyc29yOjI="], ["issues", path], ["pr", path, "1"], ["pr", path, "2"], ["issue", path, "1"]]) {
      await github([...args, "--json"]);
      await github([...args, "--json"]);
    }
    expect(calls).toHaveLength(9);
    expect(cacheFiles()).toHaveLength(9);
  });

  test("writes private files in a private directory and never caches a failure", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("HTTP 502: Bad Gateway", 1);
    expect((await github(["prs", path, "--json"])).kind).toBe("failed");
    expect(cacheFiles()).toEqual([]);
    answer = byCommand;
    expect((await github(["prs", path, "--json"])).kind).toBe("ok");
    expect(calls).toHaveLength(3);
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
    "github": "github prs|issues|pr|issue|pr-files|pr-file|review|comment|issue-state|pr-state|threads|thread-reply|thread-resolve|reviewers|request-review|pr-ready|auto-merge|rerun-checks|file-viewed|assignable|image ...",
    "github-prs": "github prs <repo name|path> [--state open|closed|merged|all] [--limit <n>] [--after <cursor>] [--json]",
    "github-issues": "github issues <repo name|path> [--state open|closed|all] [--limit <n>] [--after <cursor>] [--json]",
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

const REVIEW_USAGE = {
  "pr-files": "github pr-files <repo name|path> <number> [--page <k>] [--per-page <m>] [--no-patch] [--json]",
  "pr-file": "github pr-file <repo name|path> <number> <path> [--json]",
  "threads": "github threads <repo name|path> <number> [--json]",
  "thread-reply": "github thread-reply <repo name|path> <number> <thread id> --body <text> [--json]",
  "thread-resolve": "github thread-resolve <repo name|path> <number> <thread id> [--unresolve] [--json]",
  "reviewers": "github reviewers <repo name|path> <number> [--json]",
  "request-review": "github request-review <repo name|path> <number> --user <login>[,<login>...] [--remove] [--json]",
  "pr-ready": "github pr-ready <repo name|path> <number> [--draft] [--json]",
  "auto-merge": "github auto-merge <repo name|path> <number> --method merge|squash|rebase [--disable] [--json]",
  "rerun-checks": "github rerun-checks <repo name|path> <number> [--failed] [--json]",
  "file-viewed": "github file-viewed <repo name|path> <number> <path> [--unviewed] [--json]",
  "assignable": "github assignable <repo name|path> [--query <text>] [--json]",
  "image": "github image <repo name|path> <url> [--json]",
  "review": "github review <repo name|path> <number> --event approve|request-changes|comment --body <text> [--comments <json>] [--json]",
  "comment": "github comment <repo name|path> <number> --body <text> [--json]",
  "issue-state": "github issue-state <repo name|path> <number> open|closed [--reason completed|not planned] [--json]",
  "pr-state": "github pr-state <repo name|path> <number> merge|close|reopen [--method merge|squash|rebase] [--json]",
};

const FILES_PAGE = [
  { filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" },
  { filename: "src/new.ts", status: "added", additions: 2, deletions: 0, changes: 2, patch: "@@ -0,0 +1,2 @@\n+x\n+y" },
  { filename: "assets/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
  { filename: "src/moved.ts", previous_filename: "src/old.ts", status: "renamed", additions: 0, deletions: 0, changes: 0 },
  { filename: "src/gone.ts", status: "removed", additions: 0, deletions: 5, changes: 5, patch: "@@ -1,5 +0,0 @@\n-1" },
];

const flag = (args: GhCall, name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const fields = (args: GhCall): Record<string, string> => {
  const found: Record<string, string> = {};
  args.forEach((arg, index) => {
    if (arg !== "-f" && arg !== "-F") return;
    const [name = "", ...value] = (args[index + 1] ?? "").split("=");
    found[name] = value.join("=");
  });
  return found;
};

const PULL = "repos/operator/sample/pulls/7";
// The files endpoint plus the pull request itself, which is where the total comes from.
const filesGh = (files: readonly unknown[] = FILES_PAGE, total: number = files.length): GhAnswer => (args) => {
  if (args.includes(`${PULL}/files`)) return stdout(JSON.stringify(files));
  if (args.includes(PULL)) return stdout(JSON.stringify({ changed_files: total }));
  return failed(`unexpected gh ${args.join(" ")}`);
};

describe("github pr-files", () => {
  test("asks for page 1 of 100 and normalizes every entry", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = filesGh();
    const result = parsed<{ repository: { nameWithOwner: string }; number: number; total: number; page: number; perPage: number; files: Record<string, unknown>[] }>(await github(["pr-files", path, "7", "--json"]));
    const files = calls.find((call) => call.includes(`${PULL}/files`)) ?? [];
    expect(files[0]).toBe("api");
    expect(files).not.toContain("--paginate");
    expect(fields(files)).toMatchObject({ page: "1", per_page: "100" });
    expect(result).toMatchObject({ number: 7, total: 5, page: 1, perPage: 100 });
    expect(result.repository.nameWithOwner).toBe("operator/sample");
    expect(result.files).toEqual([
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" },
      { path: "src/new.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+x\n+y" },
      { path: "assets/logo.png", status: "added", additions: 0, deletions: 0, patch: null },
      { path: "src/moved.ts", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
      { path: "src/gone.ts", status: "removed", additions: 0, deletions: 5, patch: "@@ -1,5 +0,0 @@\n-1" },
    ]);
  });

  test("--page and --per-page select the slice and the total stays the whole pull request", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = filesGh(FILES_PAGE.slice(2, 4), 5);
    const result = parsed<{ total: number; page: number; perPage: number; files: unknown[] }>(await github(["pr-files", path, "7", "--page", "2", "--per-page", "2", "--json"]));
    const files = calls.find((call) => call.includes(`${PULL}/files`)) ?? [];
    expect(fields(files)).toMatchObject({ page: "2", per_page: "2" });
    expect(result).toMatchObject({ total: 5, page: 2, perPage: 2 });
    expect(result.files).toHaveLength(2);
  });

  test("--no-patch leaves the patch out of every file", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = filesGh();
    const result = parsed<{ files: Record<string, unknown>[] }>(await github(["pr-files", path, "7", "--no-patch", "--json"]));
    expect(result.files).toHaveLength(5);
    for (const file of result.files) expect("patch" in file).toBe(false);
    expect(result.files[3]).toEqual({ path: "src/moved.ts", previousPath: "src/old.ts", status: "renamed", additions: 0, deletions: 0 });
  });

  test("carries viewed from GitHub's per-file state, and leaves it out when GitHub does not say", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const states = { "src/a.ts": "VIEWED", "src/new.ts": "UNVIEWED", "src/gone.ts": "DISMISSED" };
    answer = (args) => graphql(args)
      ? data({ repository: { pullRequest: { files: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Object.entries(states).map(([filePath, viewerViewedState]) => ({ path: filePath, viewerViewedState })) } } } })
      : filesGh()(args);
    const result = parsed<{ files: { path: string; viewed?: boolean }[] }>(await github(["pr-files", path, "7", "--json"]));
    const lookup = calls.find(graphql) ?? [];
    expect(query(lookup)).toContain("viewerViewedState");
    expect(variables(lookup)).toMatchObject({ owner: ["operator"], name: ["sample"], number: ["7"] });
    expect(result.files.map((file) => [file.path, file.viewed])).toEqual([
      ["src/a.ts", true], ["src/new.ts", false], ["assets/logo.png", undefined], ["src/moved.ts", undefined], ["src/gone.ts", false],
    ]);
  });

  test("a failed viewed lookup does not fail the files", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => graphql(args) ? failed("gh: Bad Gateway (HTTP 502)", 1) : filesGh()(args);
    const result = parsed<{ files: Record<string, unknown>[] }>(await github(["pr-files", path, "7", "--json"]));
    expect(result.files).toHaveLength(5);
    for (const file of result.files) expect("viewed" in file).toBe(false);
  });

  test.each([
    [["--page", "0"], "--page must be a whole number from 1"],
    [["--page", "x"], "--page must be a whole number from 1"],
    [["--per-page", "0"], "--per-page must be a whole number from 1 to 100"],
    [["--per-page", "101"], "--per-page must be a whole number from 1 to 100"],
  ])("%j is refused before gh is asked", async (extra, message) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = filesGh();
    expect(await github(["pr-files", path, "7", ...extra, "--json"])).toMatchObject({ kind: "failed", error: message, exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test("never serves a stale answer from the cache", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = filesGh([]);
    await github(["pr-files", path, "7", "--json"]);
    const first = calls.length;
    await github(["pr-files", path, "7", "--json"]);
    expect(calls).toHaveLength(first * 2);
  });

  test("reports gh's own message when the pull request does not exist", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("gh: Not Found (HTTP 404)", 1);
    const result = await github(["pr-files", path, "999", "--json"]);
    expect(result.kind === "failed" ? result.error : "").toContain("gh: Not Found (HTTP 404)");
  });

  test("an answer that is not a list is an unexpected shape", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify({ message: "nope" }));
    expect((await github(["pr-files", path, "7", "--json"])).kind).toBe("failed");
  });
});

describe("github pr-file", () => {
  const filler = Array.from({ length: 100 }, (_, index) => ({ filename: `src/filler-${index}.ts`, status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n-a\n+b" }));

  test("walks the pages until the path turns up and returns that file with its patch", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => {
      if (!args.includes(`${PULL}/files`)) return failed(`unexpected gh ${args.join(" ")}`);
      return stdout(JSON.stringify(fields(args).page === "1" ? filler : FILES_PAGE));
    };
    const result = parsed<{ number: number; file: Record<string, unknown> }>(await github(["pr-file", path, "7", "src/a.ts", "--json"]));
    expect(result.number).toBe(7);
    expect(result.file).toEqual({ path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-a\n+b\n+c\n+d" });
    expect(calls.map((call) => fields(call).page)).toEqual(["1", "2"]);
  });

  test("a renamed file is found by its new path and keeps its previous path", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify(FILES_PAGE));
    const result = parsed<{ file: Record<string, unknown> }>(await github(["pr-file", path, "7", "src/moved.ts", "--json"]));
    expect(result.file).toMatchObject({ path: "src/moved.ts", previousPath: "src/old.ts", patch: null });
  });

  test("a path the pull request does not touch is a failure that names it", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify(FILES_PAGE));
    const result = await github(["pr-file", path, "7", "src/missing.ts", "--json"]);
    expect(result.kind === "failed" ? result.error : "").toBe("src/missing.ts is not in pull request #7");
    expect(calls).toHaveLength(1);
  });

  test("the path is required", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["pr-file", path, "7"])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE["pr-file"]}`, exitCode: 2 });
  });
});

describe("github review", () => {
  let body: Record<string, unknown> = {};
  beforeEach(() => {
    body = {};
    answer = (args) => {
      const file = flag(args, "--input");
      if (file !== undefined && existsSync(file)) body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      return stdout(JSON.stringify({ id: 55, state: "COMMENTED", html_url: "https://github.com/operator/sample/pull/7#pullrequestreview-55" }));
    };
  });

  test.each([["approve", "APPROVE"], ["request-changes", "REQUEST_CHANGES"], ["comment", "COMMENT"]])("%s posts a %s review", async (event, expected) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = parsed<{ number: number; event: string; id: number; url: string }>(await github(["review", path, "7", "--event", event, "--body", "looks fine", "--json"]));
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/operator/sample/pulls/7/reviews"]);
    expect(body).toEqual({ event: expected, body: "looks fine" });
    expect(result).toMatchObject({ number: 7, event, id: 55, url: "https://github.com/operator/sample/pull/7#pullrequestreview-55" });
  });

  test("sends inline comments with their line and side", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const comments = [{ path: "src/a.ts", line: 3, side: "RIGHT", body: "why?" }, { path: "src/a.ts", line: 1, side: "LEFT", body: "gone" }];
    await github(["review", path, "7", "--event", "request-changes", "--body", "see inline", "--comments", JSON.stringify(comments), "--json"]);
    expect(body).toEqual({ event: "REQUEST_CHANGES", body: "see inline", comments });
  });

  test("keeps a body with quotes and newlines intact", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const text = 'a "quoted" line\nsecond $(not run) `tick`';
    await github(["review", path, "7", "--event", "comment", "--body", text, "--json"]);
    expect(body.body).toBe(text);
  });

  test("leaves no request file behind", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    let file = "";
    answer = (args) => { file = flag(args, "--input") ?? ""; return stdout("{}"); };
    await github(["review", path, "7", "--event", "comment", "--body", "x", "--json"]);
    expect(file).not.toBe("");
    expect(existsSync(file)).toBe(false);
  });

  test.each([
    ["no event", ["--body", "x"]],
    ["an unknown event", ["--event", "merge", "--body", "x"]],
    ["comments that are not JSON", ["--event", "comment", "--body", "x", "--comments", "{oops"]],
    ["comments that are not a list", ["--event", "comment", "--body", "x", "--comments", "{}"]],
    ["a comment without a path", ["--event", "comment", "--body", "x", "--comments", '[{"line":1,"side":"RIGHT","body":"b"}]']],
    ["a comment with a bad side", ["--event", "comment", "--body", "x", "--comments", '[{"path":"a","line":1,"side":"BOTH","body":"b"}]']],
    ["a comment with a fractional line", ["--event", "comment", "--body", "x", "--comments", '[{"path":"a","line":1.5,"side":"RIGHT","body":"b"}]']],
  ])("refuses %s before calling gh", async (_name, extra) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = await github(["review", path, "7", ...extra]);
    expect(result).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test("a failed review carries gh's message and is not retried", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("HTTP 504: Gateway Timeout", 1);
    const result = await github(["review", path, "7", "--event", "approve", "--body", "ok"]);
    expect(result.kind === "failed" ? result.error : "").toContain("HTTP 504");
    expect(calls).toHaveLength(1);
  });
});

describe("github comment", () => {
  test("posts to the conversation endpoint, which serves pull requests and issues alike", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify({ id: 9, html_url: "https://github.com/operator/sample/issues/3#issuecomment-9" }));
    const result = parsed<{ number: number; id: number; url: string }>(await github(["comment", path, "3", "--body", "thanks", "--json"]));
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/operator/sample/issues/3/comments"]);
    expect(fields(call)).toEqual({ body: "thanks" });
    expect(result).toMatchObject({ number: 3, id: 9, url: "https://github.com/operator/sample/issues/3#issuecomment-9" });
  });

  test("a comment without a body is a usage error", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["comment", path, "3"])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test("surfaces gh's message", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("gh: Resource not accessible by integration (HTTP 403)", 1);
    const result = await github(["comment", path, "3", "--body", "x"]);
    expect(result.kind === "failed" ? result.error : "").toContain("Resource not accessible by integration");
  });
});

describe("github issue-state", () => {
  beforeEach(() => { answer = () => stdout(JSON.stringify({ number: 3, state: "closed", html_url: "https://github.com/operator/sample/issues/3" })); });

  test("closes with a reason", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = parsed<{ number: number; state: string }>(await github(["issue-state", path, "3", "closed", "--reason", "completed", "--json"]));
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "PATCH", "repos/operator/sample/issues/3"]);
    expect(fields(call)).toEqual({ state: "closed", state_reason: "completed" });
    expect(result).toMatchObject({ number: 3, state: "closed" });
  });

  test("spells not planned the way the API does", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["issue-state", path, "3", "closed", "--reason", "not planned"]);
    expect(fields(calls[0] ?? [])).toEqual({ state: "closed", state_reason: "not_planned" });
  });

  test("reopens without a reason", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["issue-state", path, "3", "open"]);
    expect(fields(calls[0] ?? [])).toEqual({ state: "open" });
  });

  test.each([
    ["an unknown state", ["merged"]],
    ["a reason on open", ["open", "--reason", "completed"]],
    ["an unknown reason", ["closed", "--reason", "duplicate"]],
    ["no state", []],
  ])("refuses %s before calling gh", async (_name, extra) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["issue-state", path, "3", ...extra])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });
});

describe("github pr-state", () => {
  beforeEach(() => { answer = () => stdout(JSON.stringify({ number: 7, state: "closed", merged: true, sha: "abc123" })); });

  test("merges with the chosen method", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = parsed<{ number: number; action: string; method: string }>(await github(["pr-state", path, "7", "merge", "--method", "squash", "--json"]));
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "PUT", "repos/operator/sample/pulls/7/merge"]);
    expect(fields(call)).toEqual({ merge_method: "squash" });
    expect(result).toMatchObject({ number: 7, action: "merge", method: "squash" });
  });

  test("merges as a merge commit by default", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["pr-state", path, "7", "merge"]);
    expect(fields(calls[0] ?? [])).toEqual({ merge_method: "merge" });
  });

  test.each([["close", "closed"], ["reopen", "open"]])("%s patches the pull request to %s", async (action, state) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["pr-state", path, "7", action]);
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "PATCH", "repos/operator/sample/pulls/7"]);
    expect(fields(call)).toEqual({ state });
  });

  test.each([
    ["an unknown action", ["squash"]],
    ["a method on close", ["close", "--method", "squash"]],
    ["an unknown method", ["merge", "--method", "fast-forward"]],
    ["no action", []],
  ])("refuses %s before calling gh", async (_name, extra) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["pr-state", path, "7", ...extra])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test("a refused merge carries gh's message and is not retried", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("gh: Pull Request is not mergeable (HTTP 405)", 1);
    const result = await github(["pr-state", path, "7", "merge"]);
    expect(result.kind === "failed" ? result.error : "").toContain("not mergeable");
    expect(calls).toHaveLength(1);
  });
});

describe("github review verbs routing", () => {
  test.each(Object.entries(REVIEW_USAGE))("%s --help prints its pinned usage", async (verb, line) => {
    expect(await route(["github", verb, "--help"], { environment: env, processAdapter: fakeGh })).toEqual({ kind: "ok", value: `Usage: megabrain ${line}\n` });
  });

  test("a bad number prints the usage", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["pr-files", path, "zero"])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE["pr-files"]}`, exitCode: 2 });
  });
});

describe("github pr branches", () => {
  test("carries the head and base branch of the pull request", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const view = { ...(JSON.parse(fixture("pr-view.json")) as Record<string, unknown>), headRefName: "feat/review", baseRefName: "main" };
    answer = (args) => args[0] === "pr" && args[1] === "view" ? stdout(JSON.stringify(view)) : failed("unexpected");
    expect(parsed<{ headRefName: string; baseRefName: string }>(await github(["pr", path, "14700", "--json"]))).toMatchObject({ headRefName: "feat/review", baseRefName: "main" });
  });

  test("an issue has no branches", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const result = parsed<Record<string, unknown>>(await github(["issue", path, "1", "--json"]));
    expect("headRefName" in result).toBe(false);
  });
});

describe("github writes drop the cached reads", () => {
  const writes: [string, string[]][] = [
    ["review", ["review", "PATH", "14700", "--event", "comment", "--body", "x"]],
    ["comment", ["comment", "PATH", "14700", "--body", "x"]],
    ["issue-state", ["issue-state", "PATH", "1", "closed"]],
    ["pr-state", ["pr-state", "PATH", "14700", "close"]],
  ];

  test.each(writes)("%s makes the next pr, issue and list reads fresh", async (_name, write) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const other = await repository("other", "git@github.com:operator/other.git");
    const reads = [["pr", path, "14700"], ["issue", path, "1"], ["prs", path], ["issues", path]];
    for (const read of reads) await github([...read, "--json"]);
    await github(["prs", other, "--json"]);
    expect(calls).toHaveLength(5);
    answer = () => stdout("{}");
    expect((await github(write.map((part) => part === "PATH" ? path : part))).kind).toBe("ok");
    answer = byCommand;
    calls = [];
    for (const read of reads) await github([...read, "--json"]);
    expect(calls).toHaveLength(4);
    await github(["prs", other, "--json"]);
    expect(calls).toHaveLength(4);
  });

  test("a failed write leaves the cache alone", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["pr", path, "14700", "--json"]);
    answer = () => failed("gh: Not Found (HTTP 404)", 1);
    expect((await github(["comment", path, "14700", "--body", "x"])).kind).toBe("failed");
    answer = byCommand;
    calls = [];
    await github(["pr", path, "14700", "--json"]);
    expect(calls).toHaveLength(0);
  });

  test("pr-files prints an object with a files list", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = filesGh([]);
    expect(parsed<{ files: unknown[] }>(await github(["pr-files", path, "7", "--json"])).files).toEqual([]);
  });
});

// The review flow: threads, reviewers and readiness. Every GraphQL call is told apart by the
// operation it carries; the \b keeps unresolveReviewThread from passing as resolveReviewThread.
const SAMPLE = ["operator", "sample"];
const graphql = (args: GhCall): boolean => args[0] === "api" && args[1] === "graphql";
const carries = (args: GhCall, operation: string): boolean => graphql(args) && new RegExp(`\\b${operation}\\b`).test(query(args));
const data = (value: unknown): Result<ProcessOutput> => stdout(JSON.stringify({ data: value }));
const pullRequestId = (id = "PR_node"): Result<ProcessOutput> => data({ repository: { pullRequest: { id, isDraft: true } } });

const THREADS_PAGE = {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "PRRT_1", path: "src/a.ts", line: 12, originalLine: 10, diffSide: "RIGHT", isResolved: false, isOutdated: false,
            comments: { nodes: [
              { id: "PRRC_1", author: { __typename: "User", login: "alice", name: "Alice A" }, body: "nit: rename", createdAt: "2026-10-01T10:00:00Z" },
              { id: "PRRC_2", author: null, body: "done", createdAt: "2026-10-01T11:00:00Z" },
            ] },
          },
          {
            id: "PRRT_2", path: "src/b.ts", line: null, originalLine: 4, diffSide: "LEFT", isResolved: true, isOutdated: true,
            comments: { nodes: [{ id: "PRRC_3", author: { __typename: "User", login: "bob", name: null }, body: "why?", createdAt: "2026-10-02T09:00:00Z" }] },
          },
        ],
      },
    },
  },
};

describe("github threads", () => {
  test("lists every review thread with its comments", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data(THREADS_PAGE);
    const threads = parsed<unknown[]>(await github(["threads", path, "7", "--json"]));
    const [call = []] = calls;
    expect(query(call)).toContain("reviewThreads");
    expect(variables(call)).toMatchObject({ owner: [SAMPLE[0]], name: [SAMPLE[1]], number: ["7"] });
    expect(threads).toEqual([
      {
        id: "PRRT_1", path: "src/a.ts", line: 12, side: "RIGHT", isResolved: false, isOutdated: false,
        comments: [
          { id: "PRRC_1", author: { login: "alice", name: "Alice A", isBot: false }, body: "nit: rename", createdAt: "2026-10-01T10:00:00Z" },
          { id: "PRRC_2", author: null, body: "done", createdAt: "2026-10-01T11:00:00Z" },
        ],
      },
      {
        id: "PRRT_2", path: "src/b.ts", line: 4, side: "LEFT", isResolved: true, isOutdated: true,
        comments: [{ id: "PRRC_3", author: { login: "bob", name: null, isBot: false }, body: "why?", createdAt: "2026-10-02T09:00:00Z" }],
      },
    ]);
  });

  test("follows the cursor until the last page", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const [first = {}, second = {}] = THREADS_PAGE.repository.pullRequest.reviewThreads.nodes;
    answer = (args) => variables(args).after?.[0] === "CURSOR_1"
      ? data({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [second] } } } })
      : data({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: "CURSOR_1" }, nodes: [first] } } } });
    const threads = parsed<{ id: string }[]>(await github(["threads", path, "7", "--json"]));
    expect(threads.map((thread) => thread.id)).toEqual(["PRRT_1", "PRRT_2"]);
    expect(calls).toHaveLength(2);
  });

  test("no threads is an empty list", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    expect(parsed<unknown[]>(await github(["threads", path, "7", "--json"]))).toEqual([]);
  });

  test("a GraphQL error carries GitHub's message", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify({ data: null, errors: [{ message: "Could not resolve to a PullRequest with the number of 999." }] }));
    const result = await github(["threads", path, "999", "--json"]);
    expect(result.kind === "failed" ? result.error : "").toContain("Could not resolve to a PullRequest");
  });

  test("a missing pull request in the answer is a failure, not an empty list", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data({ repository: { pullRequest: null } });
    expect((await github(["threads", path, "7", "--json"])).kind).toBe("failed");
  });
});

describe("github thread-reply and thread-resolve", () => {
  test("thread-reply posts the body to the thread", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data({ addPullRequestReviewThreadReply: { comment: { id: "PRRC_9", url: "https://github.com/operator/sample/pull/7#discussion_r9", body: "fixed", createdAt: "2026-10-03T08:00:00Z", author: { __typename: "User", login: "me", name: "Me" } } } });
    const result = parsed<{ number: number; threadId: string; comment: Record<string, unknown> }>(await github(["thread-reply", path, "7", "PRRT_1", "--body", "fixed", "--json"]));
    const [call = []] = calls;
    expect(carries(call, "addPullRequestReviewThreadReply")).toBe(true);
    expect(variables(call)).toMatchObject({ threadId: ["PRRT_1"], body: ["fixed"] });
    expect(result).toMatchObject({ number: 7, threadId: "PRRT_1" });
    expect(result.comment).toMatchObject({ id: "PRRC_9", body: "fixed", author: { login: "me", name: "Me", isBot: false } });
  });

  test("thread-reply needs a body", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["thread-reply", path, "7", "PRRT_1"])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE["thread-reply"]}`, exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test("thread-resolve resolves, and --unresolve reopens", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "unresolveReviewThread")
      ? data({ unresolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } })
      : data({ resolveReviewThread: { thread: { id: "PRRT_1", isResolved: true } } });
    const resolved = parsed<{ threadId: string; isResolved: boolean }>(await github(["thread-resolve", path, "7", "PRRT_1", "--json"]));
    expect(carries(calls[0] ?? [], "resolveReviewThread")).toBe(true);
    expect(variables(calls[0] ?? [])).toMatchObject({ threadId: ["PRRT_1"] });
    expect(resolved).toMatchObject({ threadId: "PRRT_1", isResolved: true });
    const reopened = parsed<{ isResolved: boolean }>(await github(["thread-resolve", path, "7", "PRRT_1", "--unresolve", "--json"]));
    expect(carries(calls[1] ?? [], "unresolveReviewThread")).toBe(true);
    expect(reopened.isResolved).toBe(false);
  });

  test("a write is asked once, even when GitHub times out", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => failed("gh: Gateway Timeout (HTTP 504)", 1);
    expect((await github(["thread-reply", path, "7", "PRRT_1", "--body", "x"])).kind).toBe("failed");
    expect((await github(["thread-resolve", path, "7", "PRRT_1"])).kind).toBe("failed");
    expect(calls).toHaveLength(2);
  });
});

describe("github reviewers", () => {
  const READINESS = {
    repository: {
      pullRequest: {
        reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED",
        reviewRequests: { nodes: [
          { requestedReviewer: { __typename: "User", login: "bob", name: "Bob B" } },
          { requestedReviewer: { __typename: "Team", slug: "core", name: "Core team", organization: { login: "operator" } } },
          { requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } },
        ] },
        latestReviews: { nodes: [{ author: { __typename: "User", login: "alice", name: null }, state: "APPROVED", submittedAt: "2026-10-01T12:00:00Z" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
          { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: null, isRequired: false },
          { __typename: "StatusContext", context: "ci/deploy", state: "FAILURE", isRequired: true },
        ] } } } }] },
      },
    },
  };

  test("reads who was asked, who answered and what still blocks the merge", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data(READINESS);
    const result = parsed<Record<string, unknown>>(await github(["reviewers", path, "7", "--json"]));
    expect(variables(calls[0] ?? [])).toMatchObject({ owner: ["operator"], name: ["sample"], number: ["7"] });
    expect(result).toMatchObject({
      number: 7,
      requested: [
        { login: "bob", name: "Bob B", isBot: false },
        { login: "operator/core", name: "Core team", isBot: false, isTeam: true },
        { login: "app/copilot-pull-request-reviewer", name: null, isBot: true },
      ],
      reviews: [{ author: { login: "alice", name: null, isBot: false }, state: "approved", submittedAt: "2026-10-01T12:00:00Z" }],
      mergeable: "mergeable", mergeStateStatus: "blocked", reviewDecision: "review_required",
      requiredChecks: [{ name: "build", state: "success" }, { name: "ci/deploy", state: "failure" }],
    });
  });

  test("a pull request without checks has no required ones and no decision", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data({ repository: { pullRequest: { reviewDecision: null, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", reviewRequests: { nodes: [] }, latestReviews: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } } } });
    expect(parsed<Record<string, unknown>>(await github(["reviewers", path, "7", "--json"]))).toMatchObject({ requested: [], reviews: [], reviewDecision: null, requiredChecks: [] });
  });

  test("is never served from the cache", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data(READINESS);
    await github(["reviewers", path, "7", "--json"]);
    await github(["reviewers", path, "7", "--json"]);
    expect(calls).toHaveLength(2);
  });
});

describe("github request-review", () => {
  test("asks each login through the requested_reviewers endpoint", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("{}");
    const result = parsed<{ users: string[]; remove: boolean }>(await github(["request-review", path, "7", "--user", "alice,bob", "--json"]));
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/operator/sample/pulls/7/requested_reviewers"]);
    expect(call.filter((arg, index) => call[index - 1] === "-f" && arg.startsWith("reviewers[]="))).toEqual(["reviewers[]=alice", "reviewers[]=bob"]);
    expect(result).toMatchObject({ users: ["alice", "bob"], remove: false });
  });

  test("--remove withdraws the request with DELETE", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("{}");
    await github(["request-review", path, "7", "--user", "alice", "--remove", "--json"]);
    expect((calls[0] ?? []).slice(0, 4)).toEqual(["api", "-X", "DELETE", "repos/operator/sample/pulls/7/requested_reviewers"]);
  });

  test("routes org/team-slug entries to team_reviewers by slug", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("{}");
    const result = parsed<{ users: string[]; remove: boolean }>(await github(["request-review", path, "7", "--user", "alice,operator/core-team", "--json"]));
    const [call = []] = calls;
    const fields = call.filter((arg, index) => call[index - 1] === "-f");
    expect(fields).toEqual(["reviewers[]=alice", "team_reviewers[]=core-team"]);
    expect(result).toMatchObject({ users: ["alice", "operator/core-team"], remove: false });
  });

  test("--remove withdraws a team with DELETE", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout("{}");
    await github(["request-review", path, "7", "--user", "operator/core-team", "--remove", "--json"]);
    const [call = []] = calls;
    expect(call.slice(0, 4)).toEqual(["api", "-X", "DELETE", "repos/operator/sample/pulls/7/requested_reviewers"]);
    expect(call.filter((arg, index) => call[index - 1] === "-f")).toEqual(["team_reviewers[]=core-team"]);
  });

  test.each([[["--user", "other/core-team"]], [["--user", "operator/"]], [["--user", "/core-team"]], [["--user", "a/b/c"]]])("%j is a usage error for a team", async (extra) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["request-review", path, "7", ...extra])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test.each([[[]], [["--user", ""]], [["--user", "a,,b"]], [["--user", "bad login"]]])("%j is a usage error", async (extra) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["request-review", path, "7", ...extra])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });
});

describe("github pr-ready", () => {
  test("looks the node id up, then marks the pull request ready", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "markPullRequestReadyForReview")
      ? data({ markPullRequestReadyForReview: { pullRequest: { id: "PR_node", isDraft: false } } })
      : pullRequestId();
    const result = parsed<{ isDraft: boolean }>(await github(["pr-ready", path, "7", "--json"]));
    expect(calls).toHaveLength(2);
    expect(variables(calls[0] ?? [])).toMatchObject({ owner: ["operator"], name: ["sample"], number: ["7"] });
    expect(carries(calls[1] ?? [], "markPullRequestReadyForReview")).toBe(true);
    expect(variables(calls[1] ?? [])).toMatchObject({ id: ["PR_node"] });
    expect(result.isDraft).toBe(false);
  });

  test("--draft converts it back to a draft", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "convertPullRequestToDraft")
      ? data({ convertPullRequestToDraft: { pullRequest: { id: "PR_node", isDraft: true } } })
      : pullRequestId();
    const result = parsed<{ isDraft: boolean }>(await github(["pr-ready", path, "7", "--draft", "--json"]));
    expect(carries(calls[1] ?? [], "convertPullRequestToDraft")).toBe(true);
    expect(result.isDraft).toBe(true);
  });

  test("a pull request that does not exist stops before the mutation", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => data({ repository: { pullRequest: null } });
    expect((await github(["pr-ready", path, "999", "--json"])).kind).toBe("failed");
    expect(calls).toHaveLength(1);
  });
});

describe("github auto-merge", () => {
  test.each([["merge", "MERGE"], ["squash", "SQUASH"], ["rebase", "REBASE"]])("--method %s enables auto-merge as %s", async (method, expected) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "enablePullRequestAutoMerge")
      ? data({ enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { mergeMethod: expected } } } })
      : pullRequestId();
    const result = parsed<{ enabled: boolean; method: string }>(await github(["auto-merge", path, "7", "--method", method, "--json"]));
    expect(variables(calls[1] ?? [])).toMatchObject({ id: ["PR_node"], method: [expected] });
    expect(result).toMatchObject({ enabled: true, method });
  });

  test("--disable turns it off and needs no method", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "disablePullRequestAutoMerge")
      ? data({ disablePullRequestAutoMerge: { pullRequest: { id: "PR_node" } } })
      : pullRequestId();
    const result = parsed<{ enabled: boolean }>(await github(["auto-merge", path, "7", "--disable", "--json"]));
    expect(carries(calls[1] ?? [], "disablePullRequestAutoMerge")).toBe(true);
    expect(result.enabled).toBe(false);
  });

  test.each([[[]], [["--method", "fast-forward"]]])("%j is refused before gh is asked", async (extra) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["auto-merge", path, "7", ...extra])).toMatchObject({ kind: "failed", exitCode: 2 });
    expect(calls).toHaveLength(0);
  });

  test("GitHub's refusal reaches the caller", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "enablePullRequestAutoMerge")
      ? stdout(JSON.stringify({ data: null, errors: [{ message: "Pull request Auto merge is not allowed for this repository" }] }))
      : pullRequestId();
    const result = await github(["auto-merge", path, "7", "--method", "squash"]);
    expect(result.kind === "failed" ? result.error : "").toContain("Auto merge is not allowed");
  });
});

describe("github rerun-checks", () => {
  const RUNS = { workflow_runs: [
    { id: 11, status: "completed", conclusion: "failure" },
    { id: 12, status: "completed", conclusion: "success" },
    { id: 13, status: "in_progress", conclusion: null },
    { id: 14, status: "completed", conclusion: "timed_out" },
  ] };
  const rerunGh: GhAnswer = (args) => {
    if (args.includes(PULL)) return stdout(JSON.stringify({ head: { sha: "abc123" } }));
    if (args.includes("repos/operator/sample/actions/runs")) return stdout(JSON.stringify(RUNS));
    if (args.some((arg) => arg.includes("/rerun"))) return stdout("");
    return failed(`unexpected gh ${args.join(" ")}`);
  };
  const reruns = (): string[] => calls.filter((call) => call.includes("-X") && call.includes("POST")).map((call) => call.find((arg) => arg.includes("/rerun")) ?? "");

  test("reruns every finished run on the head commit", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = rerunGh;
    const result = parsed<{ runs: number[]; failedOnly: boolean }>(await github(["rerun-checks", path, "7", "--json"]));
    const lookup = calls.find((call) => call.includes("repos/operator/sample/actions/runs")) ?? [];
    expect(fields(lookup)).toMatchObject({ head_sha: "abc123" });
    expect(reruns()).toEqual(["repos/operator/sample/actions/runs/11/rerun", "repos/operator/sample/actions/runs/12/rerun", "repos/operator/sample/actions/runs/14/rerun"]);
    expect(result).toMatchObject({ runs: [11, 12, 14], failedOnly: false });
  });

  test("--failed reruns only the failed jobs of failed runs", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = rerunGh;
    const result = parsed<{ runs: number[]; failedOnly: boolean }>(await github(["rerun-checks", path, "7", "--failed", "--json"]));
    expect(reruns()).toEqual(["repos/operator/sample/actions/runs/11/rerun-failed-jobs", "repos/operator/sample/actions/runs/14/rerun-failed-jobs"]);
    expect(result).toMatchObject({ runs: [11, 14], failedOnly: true });
  });

  test("nothing to rerun is a success with an empty list", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => args.includes("repos/operator/sample/actions/runs") ? stdout(JSON.stringify({ workflow_runs: [] })) : rerunGh(args);
    expect(parsed<{ runs: number[] }>(await github(["rerun-checks", path, "7", "--json"])).runs).toEqual([]);
    expect(reruns()).toEqual([]);
  });

  test("a run GitHub refuses to rerun fails the command with its message", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => args.some((arg) => arg.endsWith("/runs/11/rerun")) ? failed("gh: This workflow is already running (HTTP 403)", 1) : rerunGh(args);
    const result = await github(["rerun-checks", path, "7"]);
    expect(result.kind === "failed" ? result.error : "").toContain("already running");
  });
});

describe("github file-viewed", () => {
  test("marks the file viewed, and --unviewed clears it", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => carries(args, "unmarkFileAsViewed") ? data({ unmarkFileAsViewed: { pullRequest: { id: "PR_node" } } })
      : carries(args, "markFileAsViewed") ? data({ markFileAsViewed: { pullRequest: { id: "PR_node" } } })
        : pullRequestId();
    const viewed = parsed<{ path: string; viewed: boolean }>(await github(["file-viewed", path, "7", "src/a.ts", "--json"]));
    expect(carries(calls[1] ?? [], "markFileAsViewed")).toBe(true);
    expect(carries(calls[1] ?? [], "unmarkFileAsViewed")).toBe(false);
    expect(variables(calls[1] ?? [])).toMatchObject({ id: ["PR_node"], path: ["src/a.ts"] });
    expect(viewed).toMatchObject({ path: "src/a.ts", viewed: true });
    const cleared = parsed<{ viewed: boolean }>(await github(["file-viewed", path, "7", "src/a.ts", "--unviewed", "--json"]));
    expect(carries(calls[3] ?? [], "unmarkFileAsViewed")).toBe(true);
    expect(cleared.viewed).toBe(false);
  });

  test("the path is required", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["file-viewed", path, "7"])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE["file-viewed"]}`, exitCode: 2 });
  });
});

describe("github assignable", () => {
  const ASSIGNABLE = (ownerKind: "Organization" | "User") => data({ repository: {
    assignableUsers: { nodes: [
      { __typename: "User", login: "alice", name: "Alice A" },
      { __typename: "User", login: "bob", name: null },
      { __typename: "Bot", login: "copilot" },
    ] },
    owner: ownerKind === "Organization"
      ? { __typename: "Organization", teams: { nodes: [{ slug: "core", name: "Core team", organization: { login: "operator" } }] } }
      : { __typename: "User" },
  } });

  test("lists people the repository can assign, then the organization's teams", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => ASSIGNABLE("Organization");
    const result = parsed<unknown[]>(await github(["assignable", path, "--json"]));
    const [call = []] = calls;
    expect(query(call)).toContain("assignableUsers(first: 50");
    expect(variables(call)).toMatchObject({ owner: ["operator"], name: ["sample"] });
    expect(variables(call).search).toBeUndefined();
    expect(result).toEqual([
      { login: "alice", name: "Alice A", isBot: false },
      { login: "bob", name: null, isBot: false },
      { login: "app/copilot", name: null, isBot: true },
      { login: "operator/core", name: "Core team", isBot: false, isTeam: true },
    ]);
  });

  test("a repository owned by a person has no teams", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => ASSIGNABLE("User");
    const result = parsed<{ isTeam?: boolean }[]>(await github(["assignable", path, "--json"]));
    expect(result).toHaveLength(3);
    expect(result.some((entry) => entry.isTeam === true)).toBe(false);
  });

  test("--query narrows both lists", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => ASSIGNABLE("Organization");
    await github(["assignable", path, "--query", "ali", "--json"]);
    expect(variables(calls[0] ?? [])).toMatchObject({ search: ["ali"] });
  });

  test("teams GitHub will not show do not hide the people", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify({ errors: [{ message: "Resource not accessible by personal access token" }], data: { repository: { assignableUsers: { nodes: [{ __typename: "User", login: "alice", name: null }] }, owner: { __typename: "Organization", teams: null } } } }));
    expect(parsed<unknown[]>(await github(["assignable", path, "--json"]))).toEqual([{ login: "alice", name: null, isBot: false }]);
  });

  test("an answer with no repository carries GitHub's message", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify({ data: { repository: null }, errors: [{ message: "Could not resolve to a Repository" }] }));
    const result = await github(["assignable", path, "--json"]);
    expect(result.kind === "failed" ? result.error : "").toContain("Could not resolve to a Repository");
  });

  test("takes no pull request number", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["assignable", path, "7"])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE.assignable}`, exitCode: 2 });
  });
});

describe("github image", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const CONTENTS = "repos/cantospace/canto-space/contents/pr-513/01%20meta.png";
  const BLOB_URL = "https://github.com/cantospace/canto-space/blob/2a5bb4e5/pr-513/01%20meta.png?raw=true";
  type Image = { repository: { nameWithOwner: string }; url: string; contentType: string; size: number; data: string };
  const contents = (bytes: Buffer, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "file", encoding: "base64", size: bytes.length, sha: "b10b", content: `${bytes.toString("base64")}\n`, ...extra });

  test("reads a blob link through the contents API at its ref and sniffs the type", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => args[1] === `${CONTENTS}?ref=2a5bb4e5` ? stdout(contents(PNG)) : failed(`unexpected gh ${args.join(" ")}`);
    const result = parsed<Image>(await github(["image", path, BLOB_URL, "--json"]));
    expect(calls).toEqual([["api", `${CONTENTS}?ref=2a5bb4e5`]]);
    expect(result).toMatchObject({ repository: { nameWithOwner: "operator/sample" }, url: BLOB_URL, contentType: "image/png", size: PNG.length, data: PNG.toString("base64") });
  });

  test("raw links on github.com and raw.githubusercontent.com name the same file", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(contents(JPEG));
    await github(["image", path, "https://github.com/cantospace/canto-space/raw/main/pr-513/01%20meta.png", "--json"]);
    await github(["image", path, "https://raw.githubusercontent.com/cantospace/canto-space/main/pr-513/01%20meta.png", "--json"]);
    expect(calls.map((call) => call[1])).toEqual([`${CONTENTS}?ref=main`, `${CONTENTS}?ref=main`]);
  });

  test("a file over the contents limit comes from its git blob", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = (args) => args[1]?.startsWith(CONTENTS) === true ? stdout(contents(Buffer.alloc(0), { encoding: "none", content: "", size: 2_000_000 }))
      : args[1] === "repos/cantospace/canto-space/git/blobs/b10b" ? stdout(JSON.stringify({ encoding: "base64", content: PNG.toString("base64") }))
      : failed(`unexpected gh ${args.join(" ")}`);
    const result = parsed<Image>(await github(["image", path, BLOB_URL, "--json"]));
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ contentType: "image/png", size: PNG.length });
  });

  test("a file that is not a picture is refused", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(contents(Buffer.from("<svg onload=alert(1)>")));
    const result = await github(["image", path, BLOB_URL, "--json"]);
    expect(result.kind === "failed" ? result.error : "").toContain("not a PNG, JPEG, GIF or WebP image");
  });

  test("a link outside a GitHub repository is refused before gh runs", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    for (const url of ["https://example.com/a.png", "http://github.com/o/r/blob/main/a.png", "https://github.com/o/r/pull/7", "https://github.com/user-attachments/assets/1234", "not a url"]) {
      const result = await github(["image", path, url, "--json"]);
      expect(result).toMatchObject({ kind: "failed", exitCode: 2 });
    }
    expect(calls).toHaveLength(0);
  });

  test("a directory or a missing answer is a failure", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    answer = () => stdout(JSON.stringify([{ type: "file", name: "a.png" }]));
    expect((await github(["image", path, BLOB_URL, "--json"])).kind).toBe("failed");
  });

  test("the link is required and takes no pull request number", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    expect(await github(["image", path])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE.image}`, exitCode: 2 });
    expect(await github(["image", path, "7", BLOB_URL])).toMatchObject({ kind: "failed", error: `Usage: megabrain ${REVIEW_USAGE.image}`, exitCode: 2 });
  });
});

describe("github review-flow writes drop the cached reads", () => {
  const everything = (args: GhCall): Result<ProcessOutput> => {
    if (args.some((arg) => arg.includes("/rerun"))) return stdout("");
    if (args.includes("repos/operator/sample/pulls/14700")) return stdout(JSON.stringify({ head: { sha: "abc123" } }));
    if (args.includes("repos/operator/sample/actions/runs")) return stdout(JSON.stringify({ workflow_runs: [] }));
    if (carries(args, "addPullRequestReviewThreadReply")) return data({ addPullRequestReviewThreadReply: { comment: { id: "C1", body: "x", author: null } } });
    if (carries(args, "resolveReviewThread")) return data({ resolveReviewThread: { thread: { id: "T1", isResolved: true } } });
    if (carries(args, "markPullRequestReadyForReview")) return data({ markPullRequestReadyForReview: { pullRequest: { id: "PR_node", isDraft: false } } });
    if (carries(args, "enablePullRequestAutoMerge")) return data({ enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { mergeMethod: "SQUASH" } } } });
    if (carries(args, "markFileAsViewed")) return data({ markFileAsViewed: { pullRequest: { id: "PR_node" } } });
    if (graphql(args)) return pullRequestId();
    return stdout("{}");
  };
  const writes: [string, string[]][] = [
    ["thread-reply", ["thread-reply", "PATH", "14700", "T1", "--body", "x"]],
    ["thread-resolve", ["thread-resolve", "PATH", "14700", "T1"]],
    ["request-review", ["request-review", "PATH", "14700", "--user", "alice"]],
    ["pr-ready", ["pr-ready", "PATH", "14700"]],
    ["auto-merge", ["auto-merge", "PATH", "14700", "--method", "squash"]],
    ["rerun-checks", ["rerun-checks", "PATH", "14700"]],
    ["file-viewed", ["file-viewed", "PATH", "14700", "src/a.ts"]],
  ];

  test.each(writes)("%s makes the next pr, issue and list reads fresh", async (_name, write) => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    const other = await repository("other", "git@github.com:operator/other.git");
    const reads = [["pr", path, "14700"], ["issue", path, "1"], ["prs", path], ["issues", path]];
    for (const read of reads) await github([...read, "--json"]);
    await github(["prs", other, "--json"]);
    expect(calls).toHaveLength(5);
    answer = everything;
    const written = await github(write.map((part) => part === "PATH" ? path : part));
    expect(written.kind).toBe("ok");
    answer = byCommand;
    calls = [];
    for (const read of reads) await github([...read, "--json"]);
    expect(calls).toHaveLength(4);
    await github(["prs", other, "--json"]);
    expect(calls).toHaveLength(4);
  });

  test("a read leaves the cache alone", async () => {
    const path = await repository("sample", "git@github.com:operator/sample.git");
    await github(["pr", path, "14700", "--json"]);
    answer = () => data(THREADS_PAGE);
    await github(["threads", path, "14700", "--json"]);
    answer = byCommand;
    calls = [];
    await github(["pr", path, "14700", "--json"]);
    expect(calls).toHaveLength(0);
  });
});
