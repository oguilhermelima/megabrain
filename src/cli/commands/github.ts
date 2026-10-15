import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
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
// repository, state, limit, cursor and number.

type Environment = Readonly<Record<string, string | undefined>>;
type Clock = () => number;
type Verb = "prs" | "issues" | "pr" | "issue";

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
const PR_VIEW_FIELDS = "number,title,state,isDraft,url,author,createdAt,body,comments,reviewDecision,statusCheckRollup,additions,deletions";
const ISSUE_VIEW_FIELDS = "number,title,state,url,author,createdAt,body,comments";
const STATES: Readonly<Record<"prs" | "issues", readonly string[]>> = { prs: ["open", "closed", "merged", "all"], issues: ["open", "closed", "all"] };
const USAGE: Readonly<Record<Verb, UsageKey>> = { prs: "github-prs", issues: "github-issues", pr: "github-pr", issue: "github-issue" };

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
    ...(pullRequest ? { reviewDecision: reviewDecision(entry.reviewDecision), checks: checks(entry.statusCheckRollup), additions: count(entry.additions), deletions: count(entry.deletions) } : {}),
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

// GitHub's gateway gives up on a slow query (504), or briefly cannot serve (502, 503), and a cut-off
// answer reaches gh as invalid JSON. Each is worth asking once more; anything else is not.
const TRANSIENT: readonly (readonly [RegExp, string])[] = [
  [/HTTP 504\b/, "GitHub timed out, try again"],
  [/HTTP 50[23]\b/, "GitHub is unavailable, try again"],
  [/unexpected end of JSON input/i, "GitHub sent an incomplete answer, try again"],
];

type Attempt = { kind: "ok"; value: unknown } | { kind: "failed"; error: string; transient: boolean };

async function attempt(process: ProcessAdapter, name: string, args: readonly string[]): Promise<Attempt> {
  const result = await process.run("gh", args, { timeoutMs: GH_TIMEOUT });
  if (result.kind !== "ok") {
    if (result.error.includes("executable not found")) return { kind: "failed", error: "GitHub CLI (gh) is required; install it and sign in with gh auth login", transient: false };
    if (result.exitCode === 4 || /gh auth login|not logged in/i.test(result.error)) return { kind: "failed", error: "GitHub CLI is not signed in; run gh auth login", transient: false };
    const line = result.error.trim().split("\n")[0] ?? "";
    const known = TRANSIENT.find(([pattern]) => pattern.test(line));
    return { kind: "failed", error: known === undefined ? `${name} failed: ${line}` : `${name} failed: ${known[1]} (${line})`, transient: known !== undefined };
  }
  if (result.value.stdout.trim() === "") return { kind: "failed", error: `${name} returned nothing, try again`, transient: true };
  try { return { kind: "ok", value: JSON.parse(result.value.stdout) }; }
  catch { return { kind: "failed", error: `${name} returned output that is not JSON`, transient: false }; }
}

async function gh(process: ProcessAdapter, args: readonly string[]): Promise<Result<unknown>> {
  const name = `gh ${args[0] ?? ""} ${args[1] ?? ""}`;
  let answer = await attempt(process, name, args);
  if (answer.kind === "failed" && answer.transient) answer = await attempt(process, name, args);
  return answer.kind === "ok" ? ok(answer.value) : failed(answer.error);
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

export async function executeGithub(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter(), now: Clock = Date.now): Promise<Result<string>> {
  const [verbArgument, ...rest] = args;
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
