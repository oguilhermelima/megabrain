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

// Read-only views of a repository's pull requests and issues, through the GitHub CLI. Lists are one
// light GraphQL page at a time (a cursor asks for the next), with every state's total; checks, review
// decision and line counts are read per pull request by the detail call, since asking for them over a
// whole listing makes GitHub's GraphQL time out. Each answer is normalized to the shape the desktop
// pages use and cached for 60 seconds under the state directory, one private file per command,
// repository, state, limit, cursor and number. The review verbs (pr-files, review, comment,
// issue-state, pr-state) go through the same gh runner but are never cached, and a write is asked
// once: repeating a timed-out POST could post twice. `image` reads a picture a body links from a
// repository through gh's API, so a private repository's screenshots show without a browser session.

export type Environment = Readonly<Record<string, string | undefined>>;
export type Clock = () => number;
export type Verb = "prs" | "issues" | "pr" | "issue";
export type ReviewVerb = "review" | "comment" | "issue-state" | "pr-state";
export type FlowVerb = "pr-files" | "pr-file" | "threads" | "thread-reply" | "thread-resolve" | "reviewers" | "request-review" | "pr-ready" | "auto-merge" | "rerun-checks" | "file-viewed" | "assignable" | "image";
export type ActionVerb = "runs" | "run" | "run-log" | "run-action" | "workflow-dispatch";

export type Person = Readonly<{ login: string; name: string | null; isBot: boolean }>;
export type Label = Readonly<{ name: string; color: string; description: string }>;
export type Assignee = Readonly<{ login: string; name: string | null }>;
export type CheckState = "success" | "failure" | "pending" | "skipped" | "neutral";
export type GithubRepository = Readonly<{ nameWithOwner: string; url: string; path: string }>;

export const CACHE_TTL = 60_000;
export const DEFAULT_LIMIT = 30;
// GraphQL's own ceiling for one page.
export const MAX_LIMIT = 100;
export const GH_TIMEOUT = 20_000;
export const USAGE: Readonly<Record<Verb | ReviewVerb | FlowVerb, UsageKey>> = {
  "prs": "github-prs", "issues": "github-issues", "pr": "github-pr", "issue": "github-issue",
  "pr-files": "github-pr-files", "pr-file": "github-pr-file", "threads": "github-threads", "thread-reply": "github-thread-reply", "thread-resolve": "github-thread-resolve",
  "reviewers": "github-reviewers", "request-review": "github-request-review", "pr-ready": "github-pr-ready", "auto-merge": "github-auto-merge",
  "rerun-checks": "github-rerun-checks", "file-viewed": "github-file-viewed", "assignable": "github-assignable", "image": "github-image", "review": "github-review", "comment": "github-comment", "issue-state": "github-issue-state", "pr-state": "github-pr-state",
};
import { executeActions } from "./actions.js";
import { executeProjects, PROJECT_VERBS } from "./projects.js";
import { executeProjectMove } from "./project-move.js";
import { executeProjectWrite } from "./project-writes.js";
const PROJECT_WRITE_VERBS = ["project-field", "project-clear", "project-add", "project-draft", "project-archive", "project-unarchive"] as const;
export { executeProjects, PROJECTS_QUERY, PROJECT_QUERY } from "./projects.js";
export { normalizeProjectFields, normalizeProjectViews, normalizeProjectItem } from "./projects.js";
export { executeProjectMove, PROJECT_METADATA_QUERY, PROJECT_MOVE_QUERY } from "./project-move.js";
export type { Project, ProjectItem, ProjectStatusField, ProjectStatusOption } from "./projects.js";

const ACTION_VERBS: readonly ActionVerb[] = ["runs", "run", "run-log", "run-action", "workflow-dispatch"];
import { REVIEW_VERBS, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, ReviewOptions, parseComments, parseReviewOptions, executeReview } from "./review-command.js";
export { REVIEW_VERBS, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, parseComments, parseReviewOptions, executeReview } from "./review-command.js";
export type { ReviewOptions } from "./review-command.js";

import { MAX_THREAD_PAGES, THREADS_QUERY, REVIEWERS_QUERY, PULL_REQUEST_ID_QUERY, ASSIGNABLE_QUERY, AUTO_MERGE_METHODS, FAILED_CONCLUSIONS, LOGIN, ReviewThread, pullRequestNode, threadComment, prThreads, replyThread, resolveThread, requestedReviewer, prReviewers, requestReview, pullRequestId, pullRequestMutation, setPrReady, setAutoMerge, setFileViewed, rerunChecks, IMAGE_LIMIT, IMAGE_TYPES, ImageLocation, imageLocation, repositoryImage, assignable, submitReview, addComment, setIssueState, setPrState } from "./reviews.js";
export { MAX_THREAD_PAGES, THREADS_QUERY, REVIEWERS_QUERY, PULL_REQUEST_ID_QUERY, ASSIGNABLE_QUERY, AUTO_MERGE_METHODS, FAILED_CONCLUSIONS, LOGIN, pullRequestNode, threadComment, prThreads, replyThread, resolveThread, requestedReviewer, prReviewers, requestReview, pullRequestId, pullRequestMutation, setPrReady, setAutoMerge, setFileViewed, rerunChecks, IMAGE_LIMIT, IMAGE_TYPES, imageLocation, repositoryImage, assignable, submitReview, addComment, setIssueState, setPrState } from "./reviews.js";
export type { ReviewThread, ImageLocation } from "./reviews.js";
import { PullRequestFile, ReviewComment, ReviewEvent, PullRequestAction, FILE_STATUSES, writeCall, FILES_PAGE_SIZE, MAX_FILE_PAGES, normalizeFiles, filesCall, viewedStates, prFilesPage, prFile } from "./files.js";
export { FILE_STATUSES, writeCall, FILES_PAGE_SIZE, MAX_FILE_PAGES, normalizeFiles, filesCall, viewedStates, prFilesPage, prFile } from "./files.js";
export type { PullRequestFile, ReviewComment, ReviewEvent, PullRequestAction } from "./files.js";
import { FLOW_VERBS, FLOW_WRITES, FlowSpec, FLOW_SPECS, FlowOptions, parseFlow, wholeNumber, fileLine, personLine, executeFlow } from "./flow.js";
export { FLOW_VERBS, FLOW_WRITES, FLOW_SPECS, parseFlow, wholeNumber, fileLine, personLine, executeFlow } from "./flow.js";
export type { FlowSpec, FlowOptions } from "./flow.js";
import { GITHUB_REMOTE, githubNameWithOwner, registered, resolveRepository, cacheDirectory, cachePath, readCache, writeCache, dropCached, TRANSIENT, Attempt, attempt, gh, GraphqlAnswer, repositoryVariables, graphqlCall } from "./client.js";
export { GITHUB_REMOTE, githubNameWithOwner, registered, resolveRepository, cacheDirectory, cachePath, readCache, writeCache, dropCached, TRANSIENT, attempt, gh, repositoryVariables, graphqlCall } from "./client.js";
export type { Attempt, GraphqlAnswer } from "./client.js";
import { VIEWED_QUERY, AUTHOR, LABELS, PR_QUERY, ISSUE_QUERY, PR_VIEW_FIELDS, ISSUE_VIEW_FIELDS, STATES, record, text, nullableText, count, list, person, labels, assignees, lowerState, reviewDecision, checkState, checks, milestone, pullRequest, issue, detail, page, graphqlError, listCommand, searchQuery, searchPage, Options, parseOptions, listingText, detailText } from "./views.js";
export { VIEWED_QUERY, AUTHOR, LABELS, PR_QUERY, ISSUE_QUERY, PR_VIEW_FIELDS, ISSUE_VIEW_FIELDS, STATES, record, text, nullableText, count, list, person, labels, assignees, lowerState, reviewDecision, checkState, checks, milestone, pullRequest, issue, detail, page, graphqlError, listCommand, searchQuery, searchPage, parseOptions, listingText, detailText } from "./views.js";
export type { Options } from "./views.js";
import { executeGithubLabels } from "./labels.js";

export async function executeGithub(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter(), now: Clock = Date.now): Promise<Result<string>> {
  const [verbArgument, ...rest] = args;
  if (verbArgument === "labels") return executeGithubLabels(rest, environment, process);
  if (verbArgument !== undefined && PROJECT_WRITE_VERBS.includes(verbArgument as (typeof PROJECT_WRITE_VERBS)[number])) return executeProjectWrite(verbArgument as (typeof PROJECT_WRITE_VERBS)[number], rest, environment, process);
  if (verbArgument !== undefined && PROJECT_VERBS.includes(verbArgument as (typeof PROJECT_VERBS)[number])) {
    const projectVerb = verbArgument as (typeof PROJECT_VERBS)[number];
    if (projectVerb === "project-move") return executeProjectMove(rest, environment, process);
    return executeProjects(projectVerb, rest, environment, process);
  }
  if (verbArgument !== undefined && ACTION_VERBS.includes(verbArgument as ActionVerb)) {
    if (rest.includes("-h") || rest.includes("--help")) return ok(usageText(`github-${verbArgument}` as UsageKey));
    return executeActions(verbArgument, rest, environment, process);
  }
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
  const filters = options.value;
  const filtered = (filters.labels?.length ?? 0) > 0 || filters.assignee !== undefined || filters.author !== undefined || filters.draft !== undefined || filters.search !== undefined;
  const key = JSON.stringify([verb, nameWithOwner, repository.value.path, state, limit, after, number, filtered ? filters : null]);
  const started = now();
  let output = readCache(environment, key, started);
  if (output === undefined) {
    const command = verb === "prs" || verb === "issues" ? listCommand(verb, nameWithOwner, state, limit, after)
      : verb === "pr" ? ["pr", "view", String(number), "-R", nameWithOwner, "--json", PR_VIEW_FIELDS]
        : ["issue", "view", String(number), "-R", nameWithOwner, "--json", ISSUE_VIEW_FIELDS];
    const search = filtered && (verb === "prs" || verb === "issues") ? searchQuery(verb, nameWithOwner, filters) : undefined;
    const fetched = search === undefined
      ? await gh(process, command)
      : await graphqlCall(process, "gh api graphql", search.query, search.variables);
    if (fetched.kind !== "ok") return fetched;
    if (verb === "prs" || verb === "issues") {
      if (search !== undefined && typeof fetched.value === "object" && fetched.value !== null && "error" in fetched.value && typeof fetched.value.error === "string") return failed(`gh api graphql failed: ${fetched.value.error}`);
      const found = filtered ? searchPage(verb, fetched.value) : page(verb, fetched.value);
      if (found === undefined) {
        const searchError = search !== undefined && typeof fetched.value === "object" && fetched.value !== null && "error" in fetched.value && typeof fetched.value.error === "string" ? fetched.value.error : undefined;
        return failed(`gh api graphql failed: ${searchError ?? graphqlError(fetched.value) ?? "the answer has an unexpected shape"}`);
      }
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
