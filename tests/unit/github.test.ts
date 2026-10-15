import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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

const PR_VIEW_FIELDS = "number,title,state,isDraft,url,author,createdAt,body,comments,reviewDecision,statusCheckRollup,additions,deletions";
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
    "github": "github prs|issues|pr|issue ...",
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
