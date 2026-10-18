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
import { openDatabase } from "../../../db/db.js";
import { findRepository, type RepositoryRecord } from "../../../db/queries/repositories.js";
import { GITHUB_REMOTE, githubNameWithOwner, registered, resolveRepository, cacheDirectory, cachePath, readCache, writeCache, dropCached, TRANSIENT, Attempt, attempt, gh, GraphqlAnswer, repositoryVariables, graphqlCall } from "./client.js";

import { Environment, Clock, Verb, ReviewVerb, FlowVerb, Person, Label, Assignee, CheckState, GithubRepository, CACHE_TTL, DEFAULT_LIMIT, MAX_LIMIT, GH_TIMEOUT, USAGE, REVIEW_VERBS, FLOW_VERBS, FLOW_WRITES, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, PullRequestFile, ReviewComment, ReviewEvent, PullRequestAction, FILE_STATUSES, writeCall, FILES_PAGE_SIZE, MAX_FILE_PAGES, normalizeFiles, filesCall, viewedStates, prFilesPage, prFile, MAX_THREAD_PAGES, THREADS_QUERY, REVIEWERS_QUERY, PULL_REQUEST_ID_QUERY, ASSIGNABLE_QUERY, AUTO_MERGE_METHODS, FAILED_CONCLUSIONS, LOGIN, ReviewThread, pullRequestNode, threadComment, prThreads, replyThread, resolveThread, requestedReviewer, prReviewers, requestReview, pullRequestId, pullRequestMutation, setPrReady, setAutoMerge, setFileViewed, rerunChecks, IMAGE_LIMIT, IMAGE_TYPES, ImageLocation, imageLocation, repositoryImage, assignable, submitReview, addComment, setIssueState, setPrState, ReviewOptions, parseComments, parseReviewOptions, FlowSpec, FLOW_SPECS, FlowOptions, parseFlow, wholeNumber, fileLine, personLine, executeFlow, executeReview, executeGithub } from "./index.js";

export const VIEWED_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } } }
  }
}`;

export const AUTHOR = "author { __typename login ... on User { name } }";

export const LABELS = "labels(first: 20) { nodes { name color description } }";

export const PR_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!]) {
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

export const ISSUE_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [IssueState!]) {
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

export const PR_VIEW_FIELDS = "number,title,state,isDraft,url,author,createdAt,body,comments,reviewDecision,statusCheckRollup,additions,deletions,headRefName,baseRefName";

export const ISSUE_VIEW_FIELDS = "number,title,state,url,author,createdAt,body,comments";

export const STATES: Readonly<Record<"prs" | "issues", readonly string[]>> = { prs: ["open", "closed", "merged", "all"], issues: ["open", "closed", "all"] };

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function nullableText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export function count(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const total = record(value)?.totalCount;
  if (total !== undefined) return count(total);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// gh's own JSON gives a plain array; GraphQL wraps a connection's items in nodes.

export function list(value: unknown): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : record(value)?.nodes;
  return Array.isArray(items) ? items.flatMap((item): Record<string, unknown>[] => { const entry = record(item); return entry === undefined ? [] : [entry]; }) : [];
}

// GraphQL names a GitHub app by its slug; gh calls it app/<slug>, which the pages already expect.

export function person(value: unknown): Person | null {
  const entry = record(value);
  if (entry === undefined || typeof entry.login !== "string") return null;
  if (entry.__typename === "Bot") return { login: entry.login.startsWith("app/") ? entry.login : `app/${entry.login}`, name: null, isBot: true };
  return { login: entry.login, name: nullableText(entry.name), isBot: entry.is_bot === true };
}

export function labels(value: unknown): Label[] {
  return list(value).map((entry) => ({ name: text(entry.name), color: text(entry.color), description: text(entry.description) }));
}

export function assignees(value: unknown): Assignee[] {
  return list(value).flatMap((entry) => typeof entry.login === "string" ? [{ login: entry.login, name: nullableText(entry.name) }] : []);
}

export function lowerState(value: unknown): string {
  return text(value).toLowerCase();
}

export function reviewDecision(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value.toLowerCase() : null;
}

// gh mixes two kinds of check: Actions check runs (status + conclusion) and commit statuses posted
// by other CI (state). Both collapse to one state per named check.

export function checkState(entry: Record<string, unknown>): CheckState {
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

export function checks(value: unknown): { name: string; state: CheckState }[] {
  return list(value).map((entry) => ({ name: text(entry.name) || text(entry.context), state: checkState(entry) }));
}

export function milestone(value: unknown): { title: string; dueOn: string | null } | null {
  const entry = record(value);
  return entry === undefined ? null : { title: text(entry.title), dueOn: nullableText(entry.dueOn) };
}

export function pullRequest(entry: Record<string, unknown>) {
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

export function issue(entry: Record<string, unknown>) {
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

export function detail(entry: Record<string, unknown>, pullRequest: boolean) {
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

export function page(verb: "prs" | "issues", value: unknown) {
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

export function graphqlError(value: unknown): string | undefined {
  const [first] = list(record(value)?.errors);
  return first === undefined ? undefined : text(first.message) || "GitHub returned an error";
}

export function listCommand(verb: "prs" | "issues", nameWithOwner: string, state: string, limit: number, after: string | null): string[] {
  const [owner = "", name = ""] = nameWithOwner.split("/");
  const states = state === "all" ? [] : ["-f", `states[]=${state.toUpperCase()}`];
  const cursor = after === null ? [] : ["-f", `after=${after}`];
  // -f sends a string as is; only first is typed (-F), so a repository named like a number stays a name.
  return ["api", "graphql", "-f", `query=${verb === "prs" ? PR_QUERY : ISSUE_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `first=${limit}`, ...states, ...cursor];
}

export function searchQuery(verb: "prs" | "issues", nameWithOwner: string, options: Options) {
  const kind = verb === "prs" ? "pr" : "issue";
  const stateTerm = (state: string) => state === "all" ? [] : [`is:${state === "merged" ? "merged" : state}`];
  const queryFilters = [...(options.labels ?? []).map((label) => `label:${/\s/.test(label) ? `"${label.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : label}`),
    ...(verb === "issues" ? options.assignee === undefined ? [] : options.assignee === null ? ["no:assignee"] : [`assignee:${options.assignee}`] : []),
    ...(verb === "prs" && options.author !== undefined ? [`author:${options.author}`] : []),
    ...(verb === "prs" && options.draft !== undefined ? [`draft:${options.draft}`] : []),
    ...(options.search === undefined ? [] : [options.search, "in:title,body"])];
  const queryFor = (state: string) => [`repo:${nameWithOwner}`, `is:${kind}`, ...stateTerm(state), ...queryFilters].join(" ");
  const nodeFields = verb === "prs"
    ? `... on PullRequest { number title state isDraft url createdAt updatedAt headRefName baseRefName ${AUTHOR} ${LABELS} comments { totalCount } }`
    : `... on Issue { number title state url createdAt updatedAt ${AUTHOR} ${LABELS} assignees(first: 10) { nodes { login name } } comments { totalCount } milestone { title dueOn } }`;
  const query = `query($first: Int!, $after: String) { open: search(type: ISSUE, query: ${JSON.stringify(queryFor("open"))}) { issueCount } closed: search(type: ISSUE, query: ${JSON.stringify(queryFor("closed"))}) { issueCount } all: search(type: ISSUE, query: ${JSON.stringify(queryFor("all"))}) { issueCount } ${verb === "prs" ? `merged: search(type: ISSUE, query: ${JSON.stringify(queryFor("merged"))}) { issueCount }` : ""} items: search(type: ISSUE, query: ${JSON.stringify(queryFor(options.state))}, first: $first, after: $after) { issueCount pageInfo { hasNextPage endCursor } nodes { ${nodeFields} } } }`;
  const filters = { first: options.limit, ...(options.after === null ? {} : { after: options.after }) };
  return { query, variables: filters };
}

export function searchPage(verb: "prs" | "issues", value: unknown) {
  const found = record(record(value)?.data);
  const items = record(found?.items);
  if (found === undefined || items === undefined) return undefined;
  const searchCount = (value: unknown) => count(record(value)?.issueCount);
  const counts = verb === "prs"
    ? { open: searchCount(found.open), merged: searchCount(found.merged), closed: searchCount(found.closed), all: searchCount(found.all) }
    : { open: searchCount(found.open), closed: searchCount(found.closed), all: searchCount(found.all) };
  const info = record(items.pageInfo);
  const next = info?.hasNextPage === true ? nullableText(info.endCursor) : null;
  const total = count(items.issueCount);
  const normalized = verb === "prs" ? list(items.nodes).map(pullRequest) : list(items.nodes).map(issue);
  return { counts, totalCount: total, nextCursor: next, total, next, items: normalized };
}

export type Options = Readonly<{ selector: string; state: string; limit: number; after: string | null; number: number; json: boolean; labels?: string[]; assignee?: string | null; author?: string; draft?: boolean; search?: string }>;

export function parseOptions(verb: Verb, args: readonly string[]): Result<Options> {
  const usage = failed(usageMessage(USAGE[verb]), 2);
  const positional: string[] = [];
  let state = "open";
  let limit = DEFAULT_LIMIT;
  let after: string | null = null;
  let json = false;
  const labels: string[] = [];
  const seen = new Set<string>();
  let assignee: string | null | undefined;
  let author: string | undefined;
  let draft: boolean | undefined;
  let search: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--json") json = true;
    else if ((verb === "prs" || verb === "issues") && argument === "--label") {
      const value = args[index + 1] ?? "";
      if (value === "" || value.startsWith("--")) return failed("--label needs a label name", 2);
      labels.push(value); index += 1;
    } else if ((verb === "issues" && argument === "--assignee") || (verb === "prs" && ["--author", "--draft"].includes(argument)) || ((verb === "prs" || verb === "issues") && argument === "--search")) {
      const flag = argument;
      const value = args[index + 1] ?? "";
      if (seen.has(flag)) return failed(`${flag} may only be supplied once`, 2);
      if (value === "" || value.startsWith("--")) return failed(`${flag} needs a value`, 2);
      seen.add(flag); index += 1;
      if (flag === "--assignee") {
        if (assignee === null) return failed("--assignee and --no-assignee cannot be combined", 2);
        assignee = value;
      }
      else if (flag === "--author") author = value;
      else if (flag === "--search") search = value;
      else if (value === "true" || value === "false") draft = value === "true";
      else return failed("--draft must be true or false", 2);
    } else if (verb === "issues" && argument === "--no-assignee") {
      if (assignee !== undefined || seen.has("--assignee")) return failed("--assignee and --no-assignee cannot be combined", 2);
      assignee = null;
    }
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
  if (verb === "prs" || verb === "issues") return positional.length === 1 ? ok({ selector, state, limit, after, number: 0, json, ...(labels.length === 0 ? {} : { labels }), ...(assignee === undefined ? {} : { assignee }), ...(author === undefined ? {} : { author }), ...(draft === undefined ? {} : { draft }), ...(search === undefined ? {} : { search }) }) : usage;
  if (positional.length !== 2 || numberText === undefined || !/^[1-9]\d*$/.test(numberText)) return usage;
  return ok({ selector, state, limit, after: null, number: Number(numberText), json });
}

export function listingText(verb: "prs" | "issues", items: readonly Record<string, unknown>[]): string {
  return items.map((item) => {
    const author = text(record(item.author)?.login) || "ghost";
    if (verb === "issues") return `#${count(item.number)}\t${text(item.state)}\t${author}\t${text(item.title)}\n`;
    return `#${count(item.number)}\t${text(item.state)}${item.isDraft === true ? " (draft)" : ""}\t${text(item.headRefName)}\t${author}\t${text(item.title)}\n`;
  }).join("");
}

export function detailText(value: Record<string, unknown>): string {
  const comments = list(value.comments).map((comment) => `\n--- ${text(record(comment.author)?.login) || "ghost"} at ${text(comment.createdAt)}\n${text(comment.body)}\n`).join("");
  return `#${count(value.number)} ${text(value.title)} (${text(value.state)})\n${text(value.url)}\n\n${text(value.body)}\n${comments}`;
}
