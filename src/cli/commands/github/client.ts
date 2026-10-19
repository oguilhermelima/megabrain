import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../../adapters/proc.js";
import { repositoryCheckout } from "../../../core/project-registry.js";
import { failed, ok, type Result } from "../../../core/result.js";
import { resolveStateDirectory } from "../../../core/state.js";
import { usageMessage, usageText, type UsageKey } from "../../../core/usage.js";
import { openDatabaseReadOnly } from "../../../db/db.js";
import { findRepository, type RepositoryRecord } from "../../../db/queries/repositories.js";

import { Environment, Clock, Verb, ReviewVerb, FlowVerb, Person, Label, Assignee, CheckState, GithubRepository, CACHE_TTL, DEFAULT_LIMIT, MAX_LIMIT, GH_TIMEOUT, VIEWED_QUERY, AUTHOR, LABELS, PR_QUERY, ISSUE_QUERY, PR_VIEW_FIELDS, ISSUE_VIEW_FIELDS, STATES, USAGE, REVIEW_VERBS, FLOW_VERBS, FLOW_WRITES, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, record, text, nullableText, count, list, person, labels, assignees, lowerState, reviewDecision, checkState, checks, milestone, pullRequest, issue, detail, page, graphqlError, listCommand, Options, parseOptions, listingText, detailText, PullRequestFile, ReviewComment, ReviewEvent, PullRequestAction, FILE_STATUSES, writeCall, FILES_PAGE_SIZE, MAX_FILE_PAGES, normalizeFiles, filesCall, viewedStates, prFilesPage, prFile, MAX_THREAD_PAGES, THREADS_QUERY, REVIEWERS_QUERY, PULL_REQUEST_ID_QUERY, ASSIGNABLE_QUERY, AUTO_MERGE_METHODS, FAILED_CONCLUSIONS, LOGIN, ReviewThread, pullRequestNode, threadComment, prThreads, replyThread, resolveThread, requestedReviewer, prReviewers, requestReview, pullRequestId, pullRequestMutation, setPrReady, setAutoMerge, setFileViewed, rerunChecks, IMAGE_LIMIT, IMAGE_TYPES, ImageLocation, imageLocation, repositoryImage, assignable, submitReview, addComment, setIssueState, setPrState, ReviewOptions, parseComments, parseReviewOptions, FlowSpec, FLOW_SPECS, FlowOptions, parseFlow, wholeNumber, fileLine, personLine, executeFlow, executeReview, executeGithub } from "./index.js";

export const GITHUB_REMOTE = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

export function githubNameWithOwner(remote: string | null): string | null {
  if (remote === null) return null;
  const match = GITHUB_REMOTE.exec(remote.trim());
  return match === null ? null : `${match[1]}/${match[2]}`;
}

export function registered(environment: Environment, selectors: readonly string[]): RepositoryRecord | undefined {
  const opened = openDatabaseReadOnly(environment);
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

export async function resolveRepository(selector: string, environment: Environment, process: ProcessAdapter): Promise<Result<GithubRepository>> {
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

export function cacheDirectory(environment: Environment): string {
  return join(resolveStateDirectory(environment), "cache", "github");
}

export function cachePath(environment: Environment, key: string): string {
  return join(cacheDirectory(environment), `${createHash("sha256").update(key).digest("hex")}.json`);
}

export function readCache(environment: Environment, key: string, now: number): unknown {
  try {
    const entry = record(JSON.parse(readFileSync(cachePath(environment, key), "utf8")));
    if (entry === undefined || entry.key !== key || typeof entry.fetchedAt !== "number") return undefined;
    return entry.fetchedAt <= now && now - entry.fetchedAt < CACHE_TTL ? entry.value : undefined;
  } catch { return undefined; }
}

export function writeCache(environment: Environment, key: string, fetchedAt: number, value: unknown): void {
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

export function dropCached(environment: Environment, nameWithOwner: string): void {
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

export const TRANSIENT: readonly (readonly [RegExp, string])[] = [
  [/HTTP 504\b/, "GitHub timed out, try again"],
  [/HTTP 50[23]\b/, "GitHub is unavailable, try again"],
  [/unexpected end of JSON input/i, "GitHub sent an incomplete answer, try again"],
];

export type Attempt = { kind: "ok"; value: unknown } | { kind: "failed"; error: string; transient: boolean };

export async function attempt(process: ProcessAdapter, name: string, args: readonly string[], empty: boolean): Promise<Attempt> {
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

export async function gh(process: ProcessAdapter, args: readonly string[], { name = `gh ${args[0] ?? ""} ${args[1] ?? ""}`, retry = true, empty = false }: { name?: string; retry?: boolean; empty?: boolean } = {}): Promise<Result<unknown>> {
  let answer = await attempt(process, name, args, empty);
  if (retry && answer.kind === "failed" && answer.transient) answer = await attempt(process, name, args, empty);
  return answer.kind === "ok" ? ok(answer.value) : failed(answer.error);
}

/** A raw text response such as a job log, with the same authentication, retry and error messages as gh JSON calls. */
export async function ghText(process: ProcessAdapter, args: readonly string[], { name = `gh ${args[0] ?? ""} ${args[1] ?? ""}`, retry = true }: { name?: string; retry?: boolean } = {}): Promise<Result<string>> {
  const call = () => process.run("gh", args, { timeoutMs: GH_TIMEOUT });
  let result = await call();
  if (result.kind === "ok") return ok(result.value.stdout);
  if (result.error.includes("executable not found")) return failed("GitHub CLI (gh) is required; install it and sign in with gh auth login");
  if (result.exitCode === 4 || /gh auth login|not logged in/i.test(result.error)) return failed("GitHub CLI is not signed in; run gh auth login");
  const line = result.error.trim().split("\n")[0] ?? "";
  const known = TRANSIENT.find(([pattern]) => pattern.test(line));
  if (retry && known !== undefined) {
    result = await call();
    if (result.kind === "ok") return ok(result.value.stdout);
    if (result.error.includes("executable not found")) return failed("GitHub CLI (gh) is required; install it and sign in with gh auth login");
    if (result.exitCode === 4 || /gh auth login|not logged in/i.test(result.error)) return failed("GitHub CLI is not signed in; run gh auth login");
    const secondLine = result.error.trim().split("\n")[0] ?? "";
    const secondKnown = TRANSIENT.find(([pattern]) => pattern.test(secondLine));
    return failed(secondKnown === undefined ? `${name} failed: ${secondLine}` : `${name} failed: ${secondKnown[1]} (${secondLine})`);
  }
  return failed(known === undefined ? `${name} failed: ${line}` : `${name} failed: ${known[1]} (${line})`);
}

export type GraphqlAnswer = Readonly<{ data: Record<string, unknown>; error: string | undefined }>;

export function repositoryVariables(nameWithOwner: string): { owner: string; name: string } {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  return { owner, name };
}

// GraphQL answers 200 with its reason in errors. An answer with data is handed back with its message
// so a caller that got what it needs can ignore a partial error; one without data is a failure.
// Numbers go typed (-F) and everything else as a string (-f), so a login or id never reads as a number.

export async function graphqlCall(process: ProcessAdapter, name: string, queryText: string, variables: Readonly<Record<string, string | number>>, { retry = true }: { retry?: boolean } = {}): Promise<Result<GraphqlAnswer>> {
  const args = ["api", "graphql", "-f", `query=${queryText}`, ...Object.entries(variables).flatMap(([key, value]) => typeof value === "number" ? ["-F", `${key}=${value}`] : ["-f", `${key}=${value}`])];
  const fetched = await gh(process, args, { name, retry });
  if (fetched.kind !== "ok") return fetched;
  const data = record(record(fetched.value)?.data);
  const error = graphqlError(fetched.value);
  if (data === undefined) return failed(`${name} failed: ${error ?? "the answer has an unexpected shape"}`);
  return ok({ data, error });
}
