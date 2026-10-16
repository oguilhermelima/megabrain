import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { repositoryCheckout } from "../../core/project-registry.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveStateDirectory } from "../../core/state.js";
import { usageMessage, usageText, type UsageKey } from "../../core/usage.js";
import { openDatabase } from "../../db/db.js";
import { findRepository, type RepositoryRecord } from "../../db/queries/repositories.js";

// Read-only views of a repository's pull requests and issues, through the GitHub CLI. Lists are one
// light GraphQL page at a time (a cursor asks for the next), with every state's total; checks, review
// decision and line counts are read per pull request by the detail call, since asking for them over a
// whole listing makes GitHub's GraphQL time out. Each answer is normalized to the shape the desktop
// pages use and cached for 60 seconds under the state directory, one private file per command,
// repository, state, limit, cursor and number. The review verbs (pr-files, review, comment,
// issue-state, pr-state) go through the same gh runner but are never cached, and a write is asked
// once: repeating a timed-out POST could post twice.

type Environment = Readonly<Record<string, string | undefined>>;
type Clock = () => number;
type Verb = "prs" | "issues" | "pr" | "issue";
type ReviewVerb = "review" | "comment" | "issue-state" | "pr-state";
type FlowVerb = "pr-files" | "pr-file" | "threads" | "thread-reply" | "thread-resolve" | "reviewers" | "request-review" | "pr-ready" | "auto-merge" | "rerun-checks" | "file-viewed" | "assignable";

type Person = Readonly<{ login: string; name: string | null; isBot: boolean }>;
type Label = Readonly<{ name: string; color: string; description: string }>;
type Assignee = Readonly<{ login: string; name: string | null }>;
type CheckState = "success" | "failure" | "pending" | "skipped" | "neutral";
type GithubRepository = Readonly<{ nameWithOwner: string; url: string; path: string }>;

const CACHE_TTL = 60_000;
const DEFAULT_LIMIT = 30;
// GraphQL's own ceiling for one page.
const MAX_LIMIT = 100;
const GH_TIMEOUT = 20_000;
const VIEWED_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } } }
  }
}`;
const AUTHOR = "author { __typename login ... on User { name } }";
const LABELS = "labels(first: 20) { nodes { name color description } }";
const PR_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!]) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: [OPEN]) { totalCount }
    merged: pullRequests(states: [MERGED]) { totalCount }
    closed: pullRequests(states: [CLOSED]) { totalCount }
    items: pullRequests(first: $first, after: $after, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number title state isDraft url createdAt updatedAt headRefName baseRefName ${AUTHOR} ${LABELS} comments { totalCount } }
    }
  }
}`;
const ISSUE_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [IssueState!]) {
  repository(owner: $owner, name: $name) {
    open: issues(states: [OPEN]) { totalCount }
    closed: issues(states: [CLOSED]) { totalCount }
    items: issues(first: $first, after: $after, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { number title state url createdAt updatedAt ${AUTHOR} ${LABELS} assignees(first: 10) { nodes { login name } } comments { totalCount } milestone { title dueOn } }
    }
  }
}`;
const PR_VIEW_FIELDS = "number,title,state,isDraft,url,author,createdAt,body,comments,reviewDecision,statusCheckRollup,additions,deletions,headRefName,baseRefName";
const ISSUE_VIEW_FIELDS = "number,title,state,url,author,createdAt,body,comments";
const STATES: Readonly<Record<"prs" | "issues", readonly string[]>> = { prs: ["open", "closed", "merged", "all"], issues: ["open", "closed", "all"] };
const USAGE: Readonly<Record<Verb | ReviewVerb | FlowVerb, UsageKey>> = {
  "prs": "github-prs", "issues": "github-issues", "pr": "github-pr", "issue": "github-issue",
  "pr-files": "github-pr-files", "pr-file": "github-pr-file", "threads": "github-threads", "thread-reply": "github-thread-reply", "thread-resolve": "github-thread-resolve",
  "reviewers": "github-reviewers", "request-review": "github-request-review", "pr-ready": "github-pr-ready", "auto-merge": "github-auto-merge",
  "rerun-checks": "github-rerun-checks", "file-viewed": "github-file-viewed", "assignable": "github-assignable", "review": "github-review", "comment": "github-comment", "issue-state": "github-issue-state", "pr-state": "github-pr-state",
};
const REVIEW_VERBS: readonly string[] = ["review", "comment", "issue-state", "pr-state"];
const FLOW_VERBS: readonly string[] = ["pr-files", "pr-file", "threads", "thread-reply", "thread-resolve", "reviewers", "request-review", "pr-ready", "auto-merge", "rerun-checks", "file-viewed", "assignable"];
// These change the pull request, so the repository's cached reads go after them.
const FLOW_WRITES: readonly string[] = ["thread-reply", "thread-resolve", "request-review", "pr-ready", "auto-merge", "rerun-checks", "file-viewed"];
const REVIEW_EVENTS: Readonly<Record<string, string>> = { "approve": "APPROVE", "request-changes": "REQUEST_CHANGES", "comment": "COMMENT" };
const ISSUE_REASONS: Readonly<Record<string, string>> = { "completed": "completed", "not planned": "not_planned" };
const MERGE_METHODS: readonly string[] = ["merge", "squash", "rebase"];

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const total = record(value)?.totalCount;
  if (total !== undefined) return count(total);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// gh's own JSON gives a plain array; GraphQL wraps a connection's items in nodes.
function list(value: unknown): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : record(value)?.nodes;
  return Array.isArray(items) ? items.flatMap((item): Record<string, unknown>[] => { const entry = record(item); return entry === undefined ? [] : [entry]; }) : [];
}

// GraphQL names a GitHub app by its slug; gh calls it app/<slug>, which the pages already expect.
function person(value: unknown): Person | null {
  const entry = record(value);
  if (entry === undefined || typeof entry.login !== "string") return null;
  if (entry.__typename === "Bot") return { login: entry.login.startsWith("app/") ? entry.login : `app/${entry.login}`, name: null, isBot: true };
  return { login: entry.login, name: nullableText(entry.name), isBot: entry.is_bot === true };
}

function labels(value: unknown): Label[] {
  return list(value).map((entry) => ({ name: text(entry.name), color: text(entry.color), description: text(entry.description) }));
}

function assignees(value: unknown): Assignee[] {
  return list(value).flatMap((entry) => typeof entry.login === "string" ? [{ login: entry.login, name: nullableText(entry.name) }] : []);
}

function lowerState(value: unknown): string {
  return text(value).toLowerCase();
}

function reviewDecision(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

// gh mixes two kinds of check: Actions check runs (status + conclusion) and commit statuses posted
// by other CI (state). Both collapse to one state per named check.
function checkState(entry: Record<string, unknown>): CheckState {
  if (entry.__typename === "StatusContext") {
    const state = text(entry.state);
    if (state === "SUCCESS") return "success";
    if (state === "FAILURE" || state === "ERROR") return "failure";
    return "pending";
  }
  if (text(entry.status) !== "COMPLETED") return "pending";
  const conclusion = text(entry.conclusion);
  if (conclusion === "SUCCESS") return "success";
  if (conclusion === "SKIPPED") return "skipped";
  if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(conclusion)) return "failure";
  return "neutral";
}

function checks(value: unknown): { name: string; state: CheckState }[] {
  return list(value).map((entry) => ({ name: text(entry.name) || text(entry.context), state: checkState(entry) }));
}

function milestone(value: unknown): { title: string; dueOn: string | null } | null {
  const entry = record(value);
  return entry === undefined ? null : { title: text(entry.title), dueOn: nullableText(entry.dueOn) };
}

function pullRequest(entry: Record<string, unknown>) {
  return {
    number: count(entry.number),
    title: text(entry.title),
    state: lowerState(entry.state),
    isDraft: entry.isDraft === true,
    author: person(entry.author),
    labels: labels(entry.labels),
    createdAt: text(entry.createdAt),
    updatedAt: text(entry.updatedAt),
    url: text(entry.url),
    headRefName: text(entry.headRefName),
    baseRefName: text(entry.baseRefName),
    comments: count(entry.comments),
  };
}

function issue(entry: Record<string, unknown>) {
  return {
    number: count(entry.number),
    title: text(entry.title),
    state: lowerState(entry.state),
    author: person(entry.author),
    labels: labels(entry.labels),
    assignees: assignees(entry.assignees),
    createdAt: text(entry.createdAt),
    updatedAt: text(entry.updatedAt),
    url: text(entry.url),
    comments: count(entry.comments),
    milestone: milestone(entry.milestone),
  };
}

function detail(entry: Record<string, unknown>, pullRequest: boolean) {
  return {
    number: count(entry.number),
    title: text(entry.title),
    state: lowerState(entry.state),
    ...(pullRequest ? { isDraft: entry.isDraft === true } : {}),
    url: text(entry.url),
    author: person(entry.author),
    createdAt: nullableText(entry.createdAt),
    body: text(entry.body),
    comments: list(entry.comments).map((comment) => ({ author: person(comment.author), body: text(comment.body), createdAt: text(comment.createdAt), url: text(comment.url) })),
    ...(pullRequest ? { reviewDecision: reviewDecision(entry.reviewDecision), checks: checks(entry.statusCheckRollup), additions: count(entry.additions), deletions: count(entry.deletions), headRefName: text(entry.headRefName), baseRefName: text(entry.baseRefName) } : {}),
  };
}

// One page of a list query: every state's total from the aliased counts, the items, and the cursor
// of the next page (null on the last).
function page(verb: "prs" | "issues", value: unknown) {
  const repository = record(record(value)?.data)?.repository;
  const found = record(repository);
  const items = record(found?.items);
  if (found === undefined || items === undefined) return undefined;
  const counts = verb === "prs"
    ? { open: count(found.open), merged: count(found.merged), closed: count(found.closed), all: count(found.open) + count(found.merged) + count(found.closed) }
    : { open: count(found.open), closed: count(found.closed), all: count(found.open) + count(found.closed) };
  const info = record(items.pageInfo);
  const nextCursor = info?.hasNextPage === true ? nullableText(info.endCursor) : null;
  return { counts, totalCount: count(items.totalCount), nextCursor, items: verb === "prs" ? list(items.nodes).map(pullRequest) : list(items.nodes).map(issue) };
}

// GraphQL can answer 200 with no data and its reason in errors; gh passes that through.
function graphqlError(value: unknown): string | undefined {
  const [first] = list(record(value)?.errors);
  return first === undefined ? undefined : text(first.message) || "GitHub returned an error";
}

const GITHUB_REMOTE = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

function githubNameWithOwner(remote: string | null): string | null {
  if (remote === null) return null;
  const match = GITHUB_REMOTE.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

function registered(environment: Environment, selectors: readonly string[]): RepositoryRecord | undefined {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return undefined;
  try {
    for (const selector of selectors) {
      const found = findRepository(opened.value.db, selector);
      if (found !== undefined) return found;
    }
    return undefined;
  } catch { return undefined; }
  finally { opened.value.close(); }
}

// A registered name or path wins; anything else must be a git checkout. The remote is read from git
// so a changed origin is followed, and the registry's copy covers a checkout git cannot read.
async function resolveRepository(selector: string, environment: Environment, process: ProcessAdapter): Promise<Result<GithubRepository>> {
  const absolute = await realpath(selector).catch(() => selector);
  const known = registered(environment, [...new Set([selector, absolute])]);
  const checkout = await repositoryCheckout(known?.path ?? selector, process);
  if (checkout.kind !== "ok" && known === undefined) return failed(`repository not found: ${selector}`);
  const name = checkout.kind === "ok" ? checkout.value.name : known?.name ?? selector;
  const path = checkout.kind === "ok" ? checkout.value.path : known?.path ?? selector;
  const remote = (checkout.kind === "ok" ? checkout.value.remote : null) ?? known?.remote ?? null;
  const nameWithOwner = githubNameWithOwner(remote);
  if (nameWithOwner === null) return failed(`${name} has no GitHub remote`);
  return ok({ nameWithOwner, url: `https://github.com/${nameWithOwner}`, path });
}

function cacheDirectory(environment: Environment): string {
  return join(resolveStateDirectory(environment), "cache", "github");
}

function cachePath(environment: Environment, key: string): string {
  return join(cacheDirectory(environment), `${createHash("sha256").update(key).digest("hex")}.json`);
}

function readCache(environment: Environment, key: string, now: number): unknown {
  try {
    const entry = record(JSON.parse(readFileSync(cachePath(environment, key), "utf8")));
    if (entry === undefined || entry.key !== key || typeof entry.fetchedAt !== "number") return undefined;
    return entry.fetchedAt <= now && now - entry.fetchedAt < CACHE_TTL ? entry.value : undefined;
  } catch { return undefined; }
}

function writeCache(environment: Environment, key: string, fetchedAt: number, value: unknown): void {
  try {
    const directory = cacheDirectory(environment);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = cachePath(environment, key);
    const temporary = `${path}.${globalThis.process.pid}.${fetchedAt}.tmp`;
    writeFileSync(temporary, JSON.stringify({ key, fetchedAt, value }), { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* The cache only saves a gh call; a write failure costs the next one. */ }
}

// A write changes the pull request or issue and every list that shows it, so the repository's cached
// reads all go; another repository's stay.
function dropCached(environment: Environment, nameWithOwner: string): void {
  try {
    const directory = cacheDirectory(environment);
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const entry = record(JSON.parse(readFileSync(join(directory, name), "utf8")));
        const key: unknown = typeof entry?.key === "string" ? JSON.parse(entry.key) : undefined;
        if (Array.isArray(key) && key[1] === nameWithOwner) rmSync(join(directory, name), { force: true });
      } catch { /* An unreadable entry is replaced on its next read. */ }
    }
  } catch { /* No cache directory, nothing to drop. */ }
}

// GitHub's gateway gives up on a slow query (504), or briefly cannot serve (502, 503), and a cut-off
// answer reaches gh as invalid JSON. Each is worth asking once more; anything else is not.
const TRANSIENT: readonly (readonly [RegExp, string])[] = [
  [/HTTP 504\b/, "GitHub timed out, try again"],
  [/HTTP 50[23]\b/, "GitHub is unavailable, try again"],
  [/unexpected end of JSON input/i, "GitHub sent an incomplete answer, try again"],
];

type Attempt = { kind: "ok"; value: unknown } | { kind: "failed"; error: string; transient: boolean };

async function attempt(process: ProcessAdapter, name: string, args: readonly string[], empty: boolean): Promise<Attempt> {
  const result = await process.run("gh", args, { timeoutMs: GH_TIMEOUT });
  if (result.kind !== "ok") {
    if (result.error.includes("executable not found")) return { kind: "failed", error: "GitHub CLI (gh) is required; install it and sign in with gh auth login", transient: false };
    if (result.exitCode === 4 || /gh auth login|not logged in/i.test(result.error)) return { kind: "failed", error: "GitHub CLI is not signed in; run gh auth login", transient: false };
    const line = result.error.trim().split("\n")[0] ?? "";
    const known = TRANSIENT.find(([pattern]) => pattern.test(line));
    return { kind: "failed", error: known === undefined ? `${name} failed: ${line}` : `${name} failed: ${known[1]} (${line})`, transient: known !== undefined };
  }
  if (result.value.stdout.trim() === "") return empty ? { kind: "ok", value: null } : { kind: "failed", error: `${name} returned nothing, try again`, transient: true };
  try { return { kind: "ok", value: JSON.parse(result.value.stdout) }; }
  catch { return { kind: "failed", error: `${name} returned output that is not JSON`, transient: false }; }
}

// An action GitHub answers with no body (a rerun) is a success only when the caller says so.
async function gh(process: ProcessAdapter, args: readonly string[], { name = `gh ${args[0] ?? ""} ${args[1] ?? ""}`, retry = true, empty = false }: { name?: string; retry?: boolean; empty?: boolean } = {}): Promise<Result<unknown>> {
  let answer = await attempt(process, name, args, empty);
  if (retry && answer.kind === "failed" && answer.transient) answer = await attempt(process, name, args, empty);
  return answer.kind === "ok" ? ok(answer.value) : failed(answer.error);
}

type GraphqlAnswer = Readonly<{ data: Record<string, unknown>; error: string | undefined }>;

function repositoryVariables(nameWithOwner: string): { owner: string; name: string } {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  return { owner, name };
}

// GraphQL answers 200 with its reason in errors. An answer with data is handed back with its message
// so a caller that got what it needs can ignore a partial error; one without data is a failure.
// Numbers go typed (-F) and everything else as a string (-f), so a login or id never reads as a number.
async function graphqlCall(process: ProcessAdapter, name: string, queryText: string, variables: Readonly<Record<string, string | number>>, { retry = true }: { retry?: boolean } = {}): Promise<Result<GraphqlAnswer>> {
  const args = ["api", "graphql", "-f", `query=${queryText}`, ...Object.entries(variables).flatMap(([key, value]) => typeof value === "number" ? ["-F", `${key}=${value}`] : ["-f", `${key}=${value}`])];
  const fetched = await gh(process, args, { name, retry });
  if (fetched.kind !== "ok") return fetched;
  const data = record(record(fetched.value)?.data);
  const error = graphqlError(fetched.value);
  if (data === undefined) return failed(`${name} failed: ${error ?? "the answer has an unexpected shape"}`);
  return ok({ data, error });
}

function listCommand(verb: "prs" | "issues", nameWithOwner: string, state: string, limit: number, after: string | null): string[] {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  const states = state === "all" ? [] : ["-f", `states[]=${state.toUpperCase()}`];
  const cursor = after === null ? [] : ["-f", `after=${after}`];
  // -f sends a string as is; only first is typed (-F), so a repository named like a number stays a name.
  return ["api", "graphql", "-f", `query=${verb === "prs" ? PR_QUERY : ISSUE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `first=${limit}`, ...states, ...cursor];
}

type Options = Readonly<{ selector: string; state: string; limit: number; after: string | null; number: number; json: boolean }>;

function parseOptions(verb: Verb, args: readonly string[]): Result<Options> {
  const usage = failed(usageMessage(USAGE[verb]), 2);
  const positional: string[] = [];
  let state = "open";
  let limit = DEFAULT_LIMIT;
  let after: string | null = null;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--json") json = true;
    else if ((verb === "prs" || verb === "issues") && argument === "--state") {
      const value = args[index + 1] ?? "";
      if (!STATES[verb].includes(value)) return failed(`--state must be one of ${STATES[verb].join(", ")}`, 2);
      state = value;
      index += 1;
    } else if ((verb === "prs" || verb === "issues") && argument === "--limit") {
      const value = args[index + 1] ?? "";
      const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) return failed(`--limit must be a whole number from 1 to ${MAX_LIMIT}`, 2);
      limit = parsed;
      index += 1;
    } else if ((verb === "prs" || verb === "issues") && argument === "--after") {
      const value = args[index + 1] ?? "";
      if (value === "" || value.startsWith("--")) return failed("--after needs the cursor of the previous page", 2);
      after = value;
      index += 1;
    } else if (argument.startsWith("--")) return usage;
    else positional.push(argument);
  }
  const [selector, numberText] = positional;
  if (selector === undefined || selector === "") return usage;
  if (verb === "prs" || verb === "issues") return positional.length === 1 ? ok({ selector, state, limit, after, number: 0, json }) : usage;
  if (positional.length !== 2 || numberText === undefined || !/^[1-9]\d*$/.test(numberText)) return usage;
  return ok({ selector, state, limit, after: null, number: Number(numberText), json });
}

function listingText(verb: "prs" | "issues", items: readonly Record<string, unknown>[]): string {
  return items.map((item) => {
    const author = text(record(item.author)?.login) || "ghost";
    if (verb === "issues") return `#${count(item.number)}\t${text(item.state)}\t${author}\t${text(item.title)}\n`;
    return `#${count(item.number)}\t${text(item.state)}${item.isDraft === true ? " (draft)" : ""}\t${text(item.headRefName)}\t${author}\t${text(item.title)}\n`;
  }).join("");
}

function detailText(value: Record<string, unknown>): string {
  const comments = list(value.comments).map((comment) => `\n--- ${text(record(comment.author)?.login) || "ghost"} at ${text(comment.createdAt)}\n${text(comment.body)}\n`).join("");
  return `#${count(value.number)} ${text(value.title)} (${text(value.state)})\n${text(value.url)}\n\n${text(value.body)}\n${comments}`;
}

export type PullRequestFile = Readonly<{
  path: string; previousPath?: string; status: "added" | "modified" | "removed" | "renamed";
  additions: number; deletions: number; patch?: string | null;
}>;
export type ReviewComment = Readonly<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;
export type ReviewEvent = "approve" | "request-changes" | "comment";
export type PullRequestAction = "merge" | "close" | "reopen";

const FILE_STATUSES: Readonly<Record<string, PullRequestFile["status"]>> = { added: "added", removed: "removed", renamed: "renamed", modified: "modified", changed: "modified", copied: "added" };

function writeCall(method: "POST" | "PATCH" | "PUT", endpoint: string, fields: Readonly<Record<string, string>>): string[] {
  return ["api", "-X", method, endpoint, ...Object.entries(fields).flatMap(([name, value]) => ["-f", `${name}=${value}`])];
}

const FILES_PAGE_SIZE = 100;
// A pull request GitHub will show is capped at 3000 files, which is 30 pages of 100.
const MAX_FILE_PAGES = 30;

function normalizeFiles(value: unknown, withPatch: boolean): Result<PullRequestFile[]> {
  if (!Array.isArray(value)) return failed(`gh api pull files returned output in an unexpected shape: ${text(record(value)?.message) || "not a list"}`);
  const files: PullRequestFile[] = [];
  for (const entry of value) {
    const file = record(entry);
    const path = text(file?.filename);
    if (file === undefined || path === "") continue;
    const previousPath = text(file.previous_filename);
    files.push({
      path, ...(previousPath === "" ? {} : { previousPath }), status: FILE_STATUSES[text(file.status)] ?? "modified",
      additions: count(file.additions), deletions: count(file.deletions), ...(withPatch ? { patch: nullableText(file.patch) } : {}),
    });
  }
  return ok(files);
}

function filesCall(nameWithOwner: string, number: number, page: number, perPage: number): string[] {
  return ["api", `repos/${nameWithOwner}/pulls/${number}/files`, "-X", "GET", "-F", `per_page=${perPage}`, "-F", `page=${page}`];
}

// The viewer's per-file viewed marks are GraphQL-only and come in cursor pages, so one page of files
// reads as many GraphQL pages as it takes to reach its last file. It is an extra: a failure leaves the
// files without it rather than failing them.
async function viewedStates(process: ProcessAdapter, nameWithOwner: string, number: number, upTo: number): Promise<Map<string, boolean>> {
  const states = new Map<string, boolean>();
  let after: string | null = null;
  for (let pages = 0; pages < MAX_FILE_PAGES && states.size < upTo; pages += 1) {
    const answer = await graphqlCall(process, "gh api graphql", VIEWED_QUERY, { ...repositoryVariables(nameWithOwner), number, ...(after === null ? {} : { after }) });
    if (answer.kind !== "ok") return states;
    const files = record(record(record(answer.value.data.repository)?.pullRequest)?.files);
    if (files === undefined) return states;
    for (const node of list(files.nodes)) if (typeof node.path === "string") states.set(node.path, node.viewerViewedState === "VIEWED");
    const info = record(files.pageInfo);
    after = info?.hasNextPage === true ? nullableText(info.endCursor) : null;
    if (after === null) break;
  }
  return states;
}

export async function prFilesPage(process: ProcessAdapter, nameWithOwner: string, number: number, options: Readonly<{ page?: number; perPage?: number; patch?: boolean }> = {}): Promise<Result<{ total: number; page: number; perPage: number; files: (PullRequestFile & { viewed?: boolean })[] }>> {
  const page = options.page ?? 1;
  const perPage = options.perPage ?? FILES_PAGE_SIZE;
  const [fetched, pull, viewed] = await Promise.all([
    gh(process, filesCall(nameWithOwner, number, page, perPage), { name: "gh api pull files" }),
    gh(process, ["api", `repos/${nameWithOwner}/pulls/${number}`], { name: "gh api pull request" }),
    viewedStates(process, nameWithOwner, number, page * perPage),
  ]);
  if (fetched.kind !== "ok") return fetched;
  if (pull.kind !== "ok") return pull;
  const files = normalizeFiles(fetched.value, options.patch !== false);
  if (files.kind !== "ok") return files;
  const changed = record(pull.value)?.changed_files;
  if (typeof changed !== "number") return failed("gh api pull request returned output in an unexpected shape: no changed_files");
  return ok({ total: changed, page, perPage, files: files.value.map((file) => viewed.has(file.path) ? { ...file, viewed: viewed.get(file.path) === true } : file) });
}

export async function prFile(process: ProcessAdapter, nameWithOwner: string, number: number, path: string): Promise<Result<PullRequestFile>> {
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const fetched = await gh(process, filesCall(nameWithOwner, number, page, FILES_PAGE_SIZE), { name: "gh api pull files" });
    if (fetched.kind !== "ok") return fetched;
    const files = normalizeFiles(fetched.value, true);
    if (files.kind !== "ok") return files;
    const found = files.value.find((file) => file.path === path);
    if (found !== undefined) return ok(found);
    if (!Array.isArray(fetched.value) || fetched.value.length < FILES_PAGE_SIZE) break;
  }
  return failed(`${path} is not in pull request #${number}`);
}

const MAX_THREAD_PAGES = 50;
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id path line originalLine diffSide isResolved isOutdated comments(first: 100) { nodes { id ${AUTHOR} body createdAt } } }
      }
    }
  }
}`;
const REVIEWERS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision mergeable mergeStateStatus
      reviewRequests(first: 100) { nodes { requestedReviewer { __typename ... on User { login name } ... on Bot { login } ... on Team { slug name organization { login } } } } }
      latestReviews(first: 100) { nodes { ${AUTHOR} state submittedAt } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;
const PULL_REQUEST_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;
const ASSIGNABLE_QUERY = `query($owner: String!, $name: String!, $search: String) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 50, query: $search) { nodes { __typename login ... on User { name } } }
    owner { __typename ... on Organization { teams(first: 50, query: $search) { nodes { slug name organization { login } } } } }
  }
}`;
const AUTO_MERGE_METHODS: Readonly<Record<string, string>> = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" };
const FAILED_CONCLUSIONS: readonly string[] = ["failure", "timed_out", "cancelled", "startup_failure"];
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export type ReviewThread = Readonly<{
  id: string; path: string; line: number | null; side: "LEFT" | "RIGHT"; isResolved: boolean; isOutdated: boolean;
  comments: readonly Readonly<{ id: string; author: Person | null; body: string; createdAt: string }>[];
}>;

// The pull request inside a GraphQL answer, or GitHub's own reason it is not there.
function pullRequestNode(answer: GraphqlAnswer, number: number): Result<Record<string, unknown>> {
  const found = record(record(answer.data.repository)?.pullRequest);
  return found === undefined ? failed(`gh api graphql failed: ${answer.error ?? `pull request #${number} was not found`}`) : ok(found);
}

function threadComment(entry: Record<string, unknown>) {
  return { id: text(entry.id), author: person(entry.author), body: text(entry.body), createdAt: text(entry.createdAt) };
}

export async function prThreads(process: ProcessAdapter, nameWithOwner: string, number: number): Promise<Result<ReviewThread[]>> {
  const threads: ReviewThread[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < MAX_THREAD_PAGES; pages += 1) {
    const answer = await graphqlCall(process, "gh api graphql", THREADS_QUERY, { ...repositoryVariables(nameWithOwner), number, ...(after === null ? {} : { after }) });
    if (answer.kind !== "ok") return answer;
    const found = pullRequestNode(answer.value, number);
    if (found.kind !== "ok") return found;
    const connection = record(found.value.reviewThreads);
    for (const entry of list(connection?.nodes)) {
      const line = typeof entry.line === "number" ? entry.line : typeof entry.originalLine === "number" ? entry.originalLine : null;
      threads.push({
        id: text(entry.id), path: text(entry.path), line, side: entry.diffSide === "LEFT" ? "LEFT" : "RIGHT",
        isResolved: entry.isResolved === true, isOutdated: entry.isOutdated === true, comments: list(entry.comments).map(threadComment),
      });
    }
    const info = record(connection?.pageInfo);
    after = info?.hasNextPage === true ? nullableText(info.endCursor) : null;
    if (after === null) break;
  }
  return ok(threads);
}

// Thread and pull request ids are GraphQL node ids, so these writes need no repository.
export async function replyThread(process: ProcessAdapter, threadId: string, body: string): Promise<Result<{ threadId: string; comment: ReturnType<typeof threadComment> & { url: string } }>> {
  const mutation = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) { comment { id url body createdAt ${AUTHOR} } }
}`;
  const answer = await graphqlCall(process, "gh api graphql", mutation, { threadId, body }, { retry: false });
  if (answer.kind !== "ok") return answer;
  const comment = record(record(answer.value.data.addPullRequestReviewThreadReply)?.comment);
  if (comment === undefined) return failed(`gh api graphql failed: ${answer.value.error ?? "the reply was not accepted"}`);
  return ok({ threadId, comment: { ...threadComment(comment), url: text(comment.url) } });
}

export async function resolveThread(process: ProcessAdapter, threadId: string, resolved: boolean): Promise<Result<{ threadId: string; isResolved: boolean }>> {
  const operation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const mutation = `mutation($threadId: ID!) { ${operation}(input: {threadId: $threadId}) { thread { id isResolved } } }`;
  const answer = await graphqlCall(process, "gh api graphql", mutation, { threadId }, { retry: false });
  if (answer.kind !== "ok") return answer;
  const thread = record(record(answer.value.data[operation])?.thread);
  if (thread === undefined) return failed(`gh api graphql failed: ${answer.value.error ?? "the thread was not changed"}`);
  return ok({ threadId, isResolved: thread.isResolved === true });
}

function requestedReviewer(entry: Record<string, unknown>) {
  const reviewer = record(entry.requestedReviewer);
  if (reviewer?.__typename === "Team") {
    const organization = text(record(reviewer.organization)?.login);
    return { login: organization === "" ? text(reviewer.slug) : `${organization}/${text(reviewer.slug)}`, name: nullableText(reviewer.name), isBot: false, isTeam: true };
  }
  return person(reviewer);
}

export async function prReviewers(process: ProcessAdapter, nameWithOwner: string, number: number) {
  const answer = await graphqlCall(process, "gh api graphql", REVIEWERS_QUERY, { ...repositoryVariables(nameWithOwner), number });
  if (answer.kind !== "ok") return answer;
  const found = pullRequestNode(answer.value, number);
  if (found.kind !== "ok") return found;
  const pull = found.value;
  const contexts = list(record(record(record(list(record(pull.commits)?.nodes)[0]?.commit)?.statusCheckRollup)?.contexts)?.nodes);
  return ok({
    requested: list(pull.reviewRequests).flatMap((entry) => { const reviewer = requestedReviewer(entry); return reviewer === null ? [] : [reviewer]; }),
    reviews: list(pull.latestReviews).map((entry) => ({ author: person(entry.author), state: lowerState(entry.state), submittedAt: text(entry.submittedAt) })),
    mergeable: lowerState(pull.mergeable),
    mergeStateStatus: lowerState(pull.mergeStateStatus),
    reviewDecision: reviewDecision(pull.reviewDecision),
    requiredChecks: checks(contexts.filter((entry) => entry.isRequired === true)),
  });
}

export async function requestReview(process: ProcessAdapter, nameWithOwner: string, number: number, users: readonly string[], remove: boolean): Promise<Result<{ users: readonly string[]; remove: boolean }>> {
  const foreign = users.find((entry) => entry.includes("/") && entry.slice(0, entry.indexOf("/")) !== nameWithOwner.split("/")[0]);
  if (foreign !== undefined) return failed(`team ${foreign} is not in the organization that owns ${nameWithOwner}`, 2);
  const field = (entry: string): string[] => ["-f", entry.includes("/") ? `team_reviewers[]=${entry.slice(entry.indexOf("/") + 1)}` : `reviewers[]=${entry}`];
  const call = ["api", "-X", remove ? "DELETE" : "POST", `repos/${nameWithOwner}/pulls/${number}/requested_reviewers`, ...users.flatMap(field)];
  const sent = await gh(process, call, { name: "gh api requested reviewers", retry: false });
  return sent.kind === "ok" ? ok({ users, remove }) : sent;
}

async function pullRequestId(process: ProcessAdapter, nameWithOwner: string, number: number): Promise<Result<string>> {
  const answer = await graphqlCall(process, "gh api graphql", PULL_REQUEST_ID_QUERY, { ...repositoryVariables(nameWithOwner), number });
  if (answer.kind !== "ok") return answer;
  const found = pullRequestNode(answer.value, number);
  if (found.kind !== "ok") return found;
  const id = text(found.value.id);
  return id === "" ? failed(`gh api graphql failed: pull request #${number} has no id`) : ok(id);
}

// A mutation on a pull request needs its node id, which is one read away; the mutation is asked once.
async function pullRequestMutation(process: ProcessAdapter, nameWithOwner: string, number: number, operation: string, declarations: string, input: string, variables: Readonly<Record<string, string>> = {}): Promise<Result<Record<string, unknown>>> {
  const id = await pullRequestId(process, nameWithOwner, number);
  if (id.kind !== "ok") return id;
  const mutation = `mutation($id: ID!${declarations}) { ${operation}(input: {pullRequestId: $id${input}}) { pullRequest { id isDraft } } }`;
  const answer = await graphqlCall(process, "gh api graphql", mutation, { id: id.value, ...variables }, { retry: false });
  if (answer.kind !== "ok") return answer;
  const payload = record(answer.value.data[operation]);
  return payload === undefined ? failed(`gh api graphql failed: ${answer.value.error ?? "the change was not accepted"}`) : ok(payload);
}

export async function setPrReady(process: ProcessAdapter, nameWithOwner: string, number: number, draft: boolean): Promise<Result<{ isDraft: boolean }>> {
  const changed = await pullRequestMutation(process, nameWithOwner, number, draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview", "", "");
  return changed.kind === "ok" ? ok({ isDraft: record(changed.value.pullRequest)?.isDraft === true }) : changed;
}

export async function setAutoMerge(process: ProcessAdapter, nameWithOwner: string, number: number, method: "merge" | "squash" | "rebase" | "disable"): Promise<Result<{ enabled: boolean; method?: string }>> {
  const changed = method === "disable"
    ? await pullRequestMutation(process, nameWithOwner, number, "disablePullRequestAutoMerge", "", "")
    : await pullRequestMutation(process, nameWithOwner, number, "enablePullRequestAutoMerge", ", $method: PullRequestMergeMethod!", ", mergeMethod: $method", { method: AUTO_MERGE_METHODS[method] ?? "MERGE" });
  if (changed.kind !== "ok") return changed;
  return ok(method === "disable" ? { enabled: false } : { enabled: true, method });
}

export async function setFileViewed(process: ProcessAdapter, nameWithOwner: string, number: number, path: string, viewed: boolean): Promise<Result<{ path: string; viewed: boolean }>> {
  const changed = await pullRequestMutation(process, nameWithOwner, number, viewed ? "markFileAsViewed" : "unmarkFileAsViewed", ", $path: String!", ", path: $path", { path });
  return changed.kind === "ok" ? ok({ path, viewed }) : changed;
}

// Reruns every finished workflow run on the head commit, or with failedOnly just the failed jobs of the
// runs that failed. The head commit is read first because runs are listed per commit, not per pull request.
export async function rerunChecks(process: ProcessAdapter, nameWithOwner: string, number: number, failedOnly: boolean): Promise<Result<{ runs: number[]; failedOnly: boolean }>> {
  const pull = await gh(process, ["api", `repos/${nameWithOwner}/pulls/${number}`], { name: "gh api pull request" });
  if (pull.kind !== "ok") return pull;
  const sha = text(record(record(pull.value)?.head)?.sha);
  if (sha === "") return failed("gh api pull request returned output in an unexpected shape: no head commit");
  const listed = await gh(process, ["api", `repos/${nameWithOwner}/actions/runs`, "-X", "GET", "-f", `head_sha=${sha}`, "-F", "per_page=100"], { name: "gh api workflow runs" });
  if (listed.kind !== "ok") return listed;
  const runs = list(record(listed.value)?.workflow_runs)
    .filter((run) => text(run.status) === "completed" && (!failedOnly || FAILED_CONCLUSIONS.includes(text(run.conclusion))))
    .map((run) => count(run.id));
  for (const id of runs) {
    const sent = await gh(process, ["api", "-X", "POST", `repos/${nameWithOwner}/actions/runs/${id}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`], { name: "gh api rerun", retry: false, empty: true });
    if (sent.kind !== "ok") return sent;
  }
  return ok({ runs, failedOnly });
}

export async function assignable(process: ProcessAdapter, nameWithOwner: string, search?: string): Promise<Result<(Person & { isTeam?: true })[]>> {
  const answer = await graphqlCall(process, "gh api graphql", ASSIGNABLE_QUERY, { ...repositoryVariables(nameWithOwner), ...(search === undefined ? {} : { search }) });
  if (answer.kind !== "ok") return answer;
  const found = record(answer.value.data.repository);
  if (found === undefined) return failed(`gh api graphql failed: ${answer.value.error ?? "the repository was not found"}`);
  const people = list(found.assignableUsers).flatMap((entry) => { const one = person(entry); return one === null ? [] : [one]; });
  const teams = list(record(found.owner)?.teams).map((entry) => ({ login: `${text(record(entry.organization)?.login)}/${text(entry.slug)}`, name: nullableText(entry.name), isBot: false, isTeam: true as const }));
  return ok([...people, ...teams]);
}

export async function submitReview(process: ProcessAdapter, nameWithOwner: string, number: number, review: Readonly<{ event: ReviewEvent; body: string; comments?: readonly ReviewComment[] }>): Promise<Result<{ id: number; state: string; url: string }>> {
  // Inline comments are a nested array, which -f cannot express, so the request goes in a private file.
  const directory = mkdtempSync(join(tmpdir(), "megabrain-review-"));
  try {
    const file = join(directory, "review.json");
    writeFileSync(file, JSON.stringify({ event: REVIEW_EVENTS[review.event], body: review.body, ...(review.comments === undefined || review.comments.length === 0 ? {} : { comments: review.comments }) }), { mode: 0o600 });
    const sent = await gh(process, ["api", "-X", "POST", `repos/${nameWithOwner}/pulls/${number}/reviews`, "--input", file], { name: "gh api review", retry: false });
    if (sent.kind !== "ok") return sent;
    const answer = record(sent.value) ?? {};
    return ok({ id: count(answer.id), state: text(answer.state), url: text(answer.html_url) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function addComment(process: ProcessAdapter, nameWithOwner: string, number: number, body: string): Promise<Result<{ id: number; url: string }>> {
  const sent = await gh(process, writeCall("POST", `repos/${nameWithOwner}/issues/${number}/comments`, { body }), { name: "gh api comment", retry: false });
  if (sent.kind !== "ok") return sent;
  const answer = record(sent.value) ?? {};
  return ok({ id: count(answer.id), url: text(answer.html_url) });
}

export async function setIssueState(process: ProcessAdapter, nameWithOwner: string, number: number, state: "open" | "closed", reason?: "completed" | "not planned"): Promise<Result<{ state: string; url: string }>> {
  const reasonField: Record<string, string> = reason === undefined ? {} : { state_reason: ISSUE_REASONS[reason] ?? reason };
  const sent = await gh(process, writeCall("PATCH", `repos/${nameWithOwner}/issues/${number}`, { state, ...reasonField }), { name: "gh api issue state", retry: false });
  if (sent.kind !== "ok") return sent;
  const answer = record(sent.value) ?? {};
  return ok({ state: text(answer.state), url: text(answer.html_url) });
}

export async function setPrState(process: ProcessAdapter, nameWithOwner: string, number: number, action: PullRequestAction, options: Readonly<{ method?: "merge" | "squash" | "rebase" }> = {}): Promise<Result<Record<string, unknown>>> {
  const call = action === "merge" ? writeCall("PUT", `repos/${nameWithOwner}/pulls/${number}/merge`, { merge_method: options.method ?? "merge" })
    : writeCall("PATCH", `repos/${nameWithOwner}/pulls/${number}`, { state: action === "close" ? "closed" : "open" });
  const sent = await gh(process, call, { name: "gh api pull request state", retry: false });
  if (sent.kind !== "ok") return sent;
  const answer = record(sent.value) ?? {};
  if (action === "merge") return ok({ merged: answer.merged === true, sha: text(answer.sha), message: text(answer.message) });
  return ok({ state: text(answer.state), url: text(answer.html_url) });
}

type ReviewOptions = Readonly<{
  selector: string; number: number; json: boolean; event: ReviewEvent | undefined; body: string | undefined;
  comments: readonly ReviewComment[] | undefined; state: string | undefined; reason: string | undefined; method: string | undefined;
}>;

function parseComments(raw: string): Result<readonly ReviewComment[]> {
  let parsedValue: unknown;
  try { parsedValue = JSON.parse(raw); } catch { return failed("--comments must be JSON", 2); }
  if (!Array.isArray(parsedValue)) return failed("--comments must be a list of {path, line, side, body}", 2);
  const comments: ReviewComment[] = [];
  for (const entry of parsedValue) {
    const comment = record(entry);
    const side = comment?.side;
    if (comment === undefined || typeof comment.path !== "string" || comment.path === "" || typeof comment.body !== "string"
      || typeof comment.line !== "number" || !Number.isSafeInteger(comment.line) || comment.line < 1 || (side !== "LEFT" && side !== "RIGHT")) {
      return failed("--comments entries need a path, a whole line number, a side of LEFT or RIGHT, and a body", 2);
    }
    comments.push({ path: comment.path, line: comment.line, side, body: comment.body });
  }
  return ok(comments);
}

function parseReviewOptions(verb: ReviewVerb, args: readonly string[]): Result<ReviewOptions> {
  const usage = failed(usageMessage(USAGE[verb]), 2);
  const allowed: Readonly<Record<ReviewVerb, readonly string[]>> = { "review": ["--event", "--body", "--comments"], "comment": ["--body"], "issue-state": ["--reason"], "pr-state": ["--method"] };
  const positional: string[] = [];
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--json") json = true;
    else if (allowed[verb].includes(argument)) {
      const value = args[index + 1];
      if (value === undefined) return usage;
      values[argument] = value;
      index += 1;
    } else if (argument.startsWith("--")) return usage;
    else positional.push(argument);
  }
  const [selector, numberText, third] = positional;
  if (selector === undefined || selector === "" || numberText === undefined || !/^[1-9]\d*$/.test(numberText)) return usage;
  if (positional.length !== (verb === "issue-state" || verb === "pr-state" ? 3 : 2)) return usage;
  const base = { selector, number: Number(numberText), json, event: undefined, body: undefined, comments: undefined, state: third, reason: values["--reason"], method: values["--method"] };
  if (verb === "comment" && values["--body"] === undefined) return usage;
  if (verb === "review") {
    const event = values["--event"];
    if (event === undefined || values["--body"] === undefined) return usage;
    if (REVIEW_EVENTS[event] === undefined) return failed("--event must be one of approve, request-changes, comment", 2);
    const comments = values["--comments"] === undefined ? ok(undefined) : parseComments(values["--comments"]);
    if (comments.kind !== "ok") return comments;
    return ok({ ...base, event: event as ReviewEvent, body: values["--body"], comments: comments.value });
  }
  if (verb === "issue-state") {
    if (third !== "open" && third !== "closed") return usage;
    if (base.reason !== undefined && (third !== "closed" || ISSUE_REASONS[base.reason] === undefined)) return failed("--reason applies to closed, and is completed or not planned", 2);
  }
  if (verb === "pr-state") {
    if (third !== "merge" && third !== "close" && third !== "reopen") return usage;
    if (base.method !== undefined && (third !== "merge" || !MERGE_METHODS.includes(base.method))) return failed("--method applies to merge, and is merge, squash or rebase", 2);
  }
  return ok({ ...base, body: values["--body"] });
}

type FlowSpec = Readonly<{ positional: number; values: readonly string[]; switches: readonly string[]; numbered?: false }>;
const FLOW_SPECS: Readonly<Record<FlowVerb, FlowSpec>> = {
  "pr-files": { positional: 0, values: ["--page", "--per-page"], switches: ["--no-patch"] },
  "pr-file": { positional: 1, values: [], switches: [] },
  "threads": { positional: 0, values: [], switches: [] },
  "thread-reply": { positional: 1, values: ["--body"], switches: [] },
  "thread-resolve": { positional: 1, values: [], switches: ["--unresolve"] },
  "reviewers": { positional: 0, values: [], switches: [] },
  "request-review": { positional: 0, values: ["--user"], switches: ["--remove"] },
  "pr-ready": { positional: 0, values: [], switches: ["--draft"] },
  "auto-merge": { positional: 0, values: ["--method"], switches: ["--disable"] },
  "rerun-checks": { positional: 0, values: [], switches: ["--failed"] },
  "file-viewed": { positional: 1, values: [], switches: ["--unviewed"] },
  "assignable": { positional: 0, values: ["--query"], switches: [], numbered: false },
};

type FlowOptions = Readonly<{ selector: string; number: number; json: boolean; positional: readonly string[]; values: Readonly<Record<string, string>>; switches: ReadonlySet<string> }>;

function parseFlow(verb: FlowVerb, args: readonly string[]): Result<FlowOptions> {
  const usage = failed(usageMessage(USAGE[verb]), 2);
  const spec = FLOW_SPECS[verb];
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--json") json = true;
    else if (spec.switches.includes(argument)) switches.add(argument);
    else if (spec.values.includes(argument)) {
      const value = args[index + 1];
      if (value === undefined) return usage;
      values[argument] = value;
      index += 1;
    } else if (argument.startsWith("--")) return usage;
    else positional.push(argument);
  }
  const [selector, ...afterSelector] = positional;
  if (selector === undefined || selector === "") return usage;
  if (spec.numbered === false) return afterSelector.length === 0 ? ok({ selector, number: 0, json, positional: [], values, switches }) : usage;
  const [numberText, ...rest] = afterSelector;
  if (numberText === undefined || !/^[1-9]\d*$/.test(numberText) || rest.length !== spec.positional) return usage;
  return ok({ selector, number: Number(numberText), json, positional: rest, values, switches });
}

function wholeNumber(flag: string, raw: string | undefined, fallback: number, maximum: number): Result<number> {
  if (raw === undefined) return ok(fallback);
  const parsedNumber = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsedNumber) || parsedNumber < 1 || parsedNumber > maximum) {
    return failed(maximum === Number.MAX_SAFE_INTEGER ? `${flag} must be a whole number from 1` : `${flag} must be a whole number from 1 to ${maximum}`, 2);
  }
  return ok(parsedNumber);
}

function fileLine(file: PullRequestFile): string {
  return `${file.status}\t+${file.additions}\t-${file.deletions}\t${file.path}\n`;
}

function personLine(entry: Person | null): string {
  return entry?.login ?? "ghost";
}

async function executeFlow(verb: FlowVerb, args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const options = parseFlow(verb, args);
  if (options.kind !== "ok") return options;
  const { selector, number, json, positional, values, switches } = options.value;
  const [target = ""] = positional;
  const usage = failed(usageMessage(USAGE[verb]), 2);
  const page = wholeNumber("--page", values["--page"], 1, Number.MAX_SAFE_INTEGER);
  if (page.kind !== "ok") return page;
  const perPage = wholeNumber("--per-page", values["--per-page"], FILES_PAGE_SIZE, FILES_PAGE_SIZE);
  if (perPage.kind !== "ok") return perPage;
  if (verb === "thread-reply" && values["--body"] === undefined) return usage;
  let users: string[] = [];
  if (verb === "request-review") {
    const raw = values["--user"];
    if (raw === undefined) return usage;
    users = raw.split(",");
    const valid = (entry: string): boolean => {
      const [org, slug, ...rest] = entry.split("/");
      return slug === undefined ? LOGIN.test(entry) : rest.length === 0 && LOGIN.test(org ?? "") && LOGIN.test(slug);
    };
    if (users.some((user) => !valid(user))) return failed("--user needs GitHub logins or <org>/<team-slug> entries separated by commas", 2);
  }
  let method: "merge" | "squash" | "rebase" | undefined;
  if (verb === "auto-merge") {
    const raw = values["--method"];
    if (raw === undefined && !switches.has("--disable")) return usage;
    if (raw !== undefined) {
      if (raw !== "merge" && raw !== "squash" && raw !== "rebase") return failed("--method must be one of merge, squash, rebase", 2);
      method = raw;
    }
  }
  const repository = await resolveRepository(selector, environment, process);
  if (repository.kind !== "ok") return repository;
  const { nameWithOwner } = repository.value;
  const header = { repository: repository.value, number };
  let output: unknown;
  let line: string;
  if (verb === "pr-files") {
    const found = await prFilesPage(process, nameWithOwner, number, { page: page.value, perPage: perPage.value, patch: !switches.has("--no-patch") });
    if (found.kind !== "ok") return found;
    output = { ...header, ...found.value };
    line = found.value.files.map(fileLine).join("");
  } else if (verb === "pr-file") {
    const found = await prFile(process, nameWithOwner, number, target);
    if (found.kind !== "ok") return found;
    output = { ...header, file: found.value };
    line = `${fileLine(found.value)}${found.value.patch ?? ""}\n`;
  } else if (verb === "threads") {
    const found = await prThreads(process, nameWithOwner, number);
    if (found.kind !== "ok") return found;
    output = found.value;
    line = found.value.map((thread) => `${thread.id}\t${thread.isResolved ? "resolved" : "open"}${thread.isOutdated ? " (outdated)" : ""}\t${thread.path}:${thread.line ?? ""}\t${thread.comments.length} comments\n`).join("");
  } else if (verb === "thread-reply") {
    const sent = await replyThread(process, target, values["--body"] ?? "");
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = `replied to ${target} ${sent.value.comment.url}\n`;
  } else if (verb === "thread-resolve") {
    const resolved = !switches.has("--unresolve");
    const sent = await resolveThread(process, target, resolved);
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = `${target} is ${sent.value.isResolved ? "resolved" : "open"}\n`;
  } else if (verb === "reviewers") {
    const found = await prReviewers(process, nameWithOwner, number);
    if (found.kind !== "ok") return found;
    output = { ...header, ...found.value };
    line = `${found.value.reviewDecision ?? "no decision"}\t${found.value.mergeable}\t${found.value.mergeStateStatus}\nrequested: ${found.value.requested.map(personLine).join(", ")}\n${found.value.reviews.map((review) => `${personLine(review.author)}\t${review.state}\n`).join("")}`;
  } else if (verb === "request-review") {
    const sent = await requestReview(process, nameWithOwner, number, users, switches.has("--remove"));
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = `${sent.value.remove ? "withdrew" : "requested"} ${users.join(", ")} on #${number}\n`;
  } else if (verb === "pr-ready") {
    const sent = await setPrReady(process, nameWithOwner, number, switches.has("--draft"));
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = `#${number} is ${sent.value.isDraft ? "a draft" : "ready for review"}\n`;
  } else if (verb === "auto-merge") {
    const sent = await setAutoMerge(process, nameWithOwner, number, method ?? "disable");
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = sent.value.enabled ? `auto-merge on for #${number} (${sent.value.method ?? ""})\n` : `auto-merge off for #${number}\n`;
  } else if (verb === "rerun-checks") {
    const sent = await rerunChecks(process, nameWithOwner, number, switches.has("--failed"));
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = `reran ${sent.value.runs.length} workflow runs on #${number}\n`;
  } else if (verb === "file-viewed") {
    const sent = await setFileViewed(process, nameWithOwner, number, target, !switches.has("--unviewed"));
    if (sent.kind !== "ok") return sent;
    output = { ...header, ...sent.value };
    line = `${target} is ${sent.value.viewed ? "viewed" : "not viewed"}\n`;
  } else {
    const found = await assignable(process, nameWithOwner, values["--query"]);
    if (found.kind !== "ok") return found;
    output = found.value;
    line = found.value.map((entry) => `${entry.login}\t${entry.name ?? ""}\n`).join("");
  }
  if (FLOW_WRITES.includes(verb)) dropCached(environment, nameWithOwner);
  return ok(json ? `${JSON.stringify(output, null, 2)}\n` : line);
}

async function executeReview(verb: ReviewVerb, args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const options = parseReviewOptions(verb, args);
  if (options.kind !== "ok") return options;
  const { selector, number, json, event, body, comments, state, reason, method } = options.value;
  const repository = await resolveRepository(selector, environment, process);
  if (repository.kind !== "ok") return repository;
  const { nameWithOwner } = repository.value;
  let output: Record<string, unknown>;
  let line: string;
  if (verb === "review" && event !== undefined && body !== undefined) {
    const sent = await submitReview(process, nameWithOwner, number, { event, body, ...(comments === undefined ? {} : { comments }) });
    if (sent.kind !== "ok") return sent;
    output = { event, ...sent.value };
    line = `reviewed #${number} (${event}) ${sent.value.url}\n`;
  } else if (verb === "comment" && body !== undefined) {
    const sent = await addComment(process, nameWithOwner, number, body);
    if (sent.kind !== "ok") return sent;
    output = { ...sent.value };
    line = `commented on #${number} ${sent.value.url}\n`;
  } else if (verb === "issue-state" && (state === "open" || state === "closed")) {
    const sent = await setIssueState(process, nameWithOwner, number, state, reason === "completed" || reason === "not planned" ? reason : undefined);
    if (sent.kind !== "ok") return sent;
    output = { ...sent.value };
    line = `#${number} is ${sent.value.state}\n`;
  } else if (verb === "pr-state" && (state === "merge" || state === "close" || state === "reopen")) {
    const chosen = method === "squash" || method === "rebase" || method === "merge" ? method : undefined;
    const sent = await setPrState(process, nameWithOwner, number, state, chosen === undefined ? {} : { method: chosen });
    if (sent.kind !== "ok") return sent;
    output = { action: state, ...(state === "merge" ? { method: chosen ?? "merge" } : {}), ...sent.value };
    line = state === "merge" ? `merged #${number}${sent.value.merged === true ? "" : " (not merged)"}\n` : `#${number} is ${text(sent.value.state)}\n`;
  } else return failed(usageMessage(USAGE[verb]), 2);
  dropCached(environment, nameWithOwner);
  return ok(json ? `${JSON.stringify({ repository: repository.value, number, ...output }, null, 2)}\n` : line);
}

export async function executeGithub(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter(), now: Clock = Date.now): Promise<Result<string>> {
  const [verbArgument, ...rest] = args;
  if (verbArgument !== undefined && REVIEW_VERBS.includes(verbArgument)) {
    const reviewVerb = verbArgument as ReviewVerb;
    if (rest.includes("-h") || rest.includes("--help")) return ok(usageText(USAGE[reviewVerb]));
    return executeReview(reviewVerb, rest, environment, process);
  }
  if (verbArgument !== undefined && FLOW_VERBS.includes(verbArgument)) {
    const flowVerb = verbArgument as FlowVerb;
    if (rest.includes("-h") || rest.includes("--help")) return ok(usageText(USAGE[flowVerb]));
    return executeFlow(flowVerb, rest, environment, process);
  }
  const verb = verbArgument === "prs" || verbArgument === "issues" || verbArgument === "pr" || verbArgument === "issue" ? verbArgument : undefined;
  if (args.includes("-h") || args.includes("--help")) return ok(usageText(verb === undefined ? "github" : USAGE[verb]));
  if (verb === undefined) return failed(usageMessage("github"), 2);
  const options = parseOptions(verb, rest);
  if (options.kind !== "ok") return options;
  const { selector, state, limit, after, number, json } = options.value;
  const repository = await resolveRepository(selector, environment, process);
  if (repository.kind !== "ok") return repository;
  const { nameWithOwner } = repository.value;
  const key = JSON.stringify([verb, nameWithOwner, repository.value.path, state, limit, after, number]);
  const started = now();
  let output = readCache(environment, key, started);
  if (output === undefined) {
    const command = verb === "prs" || verb === "issues" ? listCommand(verb, nameWithOwner, state, limit, after)
      : verb === "pr" ? ["pr", "view", String(number), "-R", nameWithOwner, "--json", PR_VIEW_FIELDS]
        : ["issue", "view", String(number), "-R", nameWithOwner, "--json", ISSUE_VIEW_FIELDS];
    const fetched = await gh(process, command);
    if (fetched.kind !== "ok") return fetched;
    if (verb === "prs" || verb === "issues") {
      const found = page(verb, fetched.value);
      if (found === undefined) return failed(`gh api graphql failed: ${graphqlError(fetched.value) ?? "the answer has an unexpected shape"}`);
      output = { repository: repository.value, state, limit, after, fetchedAt: new Date(started).toISOString(), ...found };
    } else {
      const entry = record(fetched.value);
      if (entry === undefined) return failed(`gh ${command[0]} view returned output in an unexpected shape`);
      output = { repository: repository.value, ...detail(entry, verb === "pr") };
    }
    writeCache(environment, key, started, output);
  }
  if (json) return ok(`${JSON.stringify(output, null, 2)}\n`);
  const value = record(output) ?? {};
  if (verb === "prs" || verb === "issues") return ok(listingText(verb, list(value.items)));
  return ok(detailText(value));
}
