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

// Read-only views of a repository's pull requests and issues, through the GitHub CLI. Each answer is
// normalized to the shape the desktop pages use and cached for 60 seconds under the state directory,
// one private file per command, repository, state, limit and number.

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
const MAX_LIMIT = 1000;
const GH_TIMEOUT = 20_000;
const PR_FIELDS = "number,title,state,author,labels,assignees,createdAt,updatedAt,url,isDraft,headRefName,baseRefName,reviewDecision,statusCheckRollup,comments,additions,deletions";
const ISSUE_FIELDS = "number,title,state,author,labels,assignees,createdAt,updatedAt,url,comments,milestone";
const PR_VIEW_FIELDS = "number,title,state,isDraft,url,author,createdAt,body,comments";
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
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.flatMap((item): Record<string, unknown>[] => { const entry = record(item); return entry === undefined ? [] : [entry]; }) : [];
}

function person(value: unknown): Person | null {
  const entry = record(value);
  if (entry === undefined || typeof entry.login !== "string") return null;
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
    assignees: assignees(entry.assignees),
    createdAt: text(entry.createdAt),
    updatedAt: text(entry.updatedAt),
    url: text(entry.url),
    headRefName: text(entry.headRefName),
    baseRefName: text(entry.baseRefName),
    reviewDecision: reviewDecision(entry.reviewDecision),
    checks: checks(entry.statusCheckRollup),
    comments: count(entry.comments),
    additions: count(entry.additions),
    deletions: count(entry.deletions),
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

function detail(entry: Record<string, unknown>, withDraft: boolean) {
  return {
    number: count(entry.number),
    title: text(entry.title),
    state: lowerState(entry.state),
    ...(withDraft ? { isDraft: entry.isDraft === true } : {}),
    url: text(entry.url),
    author: person(entry.author),
    createdAt: nullableText(entry.createdAt),
    body: text(entry.body),
    comments: list(entry.comments).map((comment) => ({ author: person(comment.author), body: text(comment.body), createdAt: text(comment.createdAt), url: text(comment.url) })),
  };
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

async function gh(process: ProcessAdapter, args: readonly string[]): Promise<Result<unknown>> {
  const name = `gh ${args[0] ?? ""} ${args[1] ?? ""}`;
  const result = await process.run("gh", args, { timeoutMs: GH_TIMEOUT });
  if (result.kind !== "ok") {
    if (result.error.includes("executable not found")) return failed("GitHub CLI (gh) is required; install it and sign in with gh auth login");
    if (result.exitCode === 4 || /gh auth login|not logged in/i.test(result.error)) return failed("GitHub CLI is not signed in; run gh auth login");
    return failed(`${name} failed: ${result.error.trim().split("\n")[0] ?? ""}`);
  }
  try { return ok(JSON.parse(result.value.stdout)); }
  catch { return failed(`${name} returned output that is not JSON`); }
}

type Options = Readonly<{ selector: string; state: string; limit: number; number: number; json: boolean }>;

function parseOptions(verb: Verb, args: readonly string[]): Result<Options> {
  const usage = failed(usageMessage(USAGE[verb]), 2);
  const positional: string[] = [];
  let state = "open";
  let limit = DEFAULT_LIMIT;
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
    } else if (argument.startsWith("--")) return usage;
    else positional.push(argument);
  }
  const [selector, numberText] = positional;
  if (selector === undefined || selector === "") return usage;
  if (verb === "prs" || verb === "issues") return positional.length === 1 ? ok({ selector, state, limit, number: 0, json }) : usage;
  if (positional.length !== 2 || numberText === undefined || !/^[1-9]\d*$/.test(numberText)) return usage;
  return ok({ selector, state, limit, number: Number(numberText), json });
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
  const { selector, state, limit, number, json } = options.value;
  const repository = await resolveRepository(selector, environment, process);
  if (repository.kind !== "ok") return repository;
  const { nameWithOwner } = repository.value;
  const key = JSON.stringify([verb, nameWithOwner, repository.value.path, state, limit, number]);
  const started = now();
  let output = readCache(environment, key, started);
  if (output === undefined) {
    const command = verb === "prs" ? ["pr", "list", "-R", nameWithOwner, "--state", state, "--limit", String(limit), "--json", PR_FIELDS]
      : verb === "issues" ? ["issue", "list", "-R", nameWithOwner, "--state", state, "--limit", String(limit), "--json", ISSUE_FIELDS]
        : verb === "pr" ? ["pr", "view", String(number), "-R", nameWithOwner, "--json", PR_VIEW_FIELDS]
          : ["issue", "view", String(number), "-R", nameWithOwner, "--json", ISSUE_VIEW_FIELDS];
    const fetched = await gh(process, command);
    if (fetched.kind !== "ok") return fetched;
    if (verb === "prs" || verb === "issues") {
      if (!Array.isArray(fetched.value)) return failed(`gh ${command[0]} list returned output in an unexpected shape`);
      const items = verb === "prs" ? list(fetched.value).map(pullRequest) : list(fetched.value).map(issue);
      output = { repository: repository.value, state, limit, fetchedAt: new Date(started).toISOString(), items };
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
