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
import { VIEWED_QUERY, AUTHOR, LABELS, PR_QUERY, ISSUE_QUERY, PR_VIEW_FIELDS, ISSUE_VIEW_FIELDS, STATES, record, text, nullableText, count, list, person, labels, assignees, lowerState, reviewDecision, checkState, checks, milestone, pullRequest, issue, detail, page, graphqlError, listCommand, Options, parseOptions, listingText, detailText } from "./views.js";

import { Environment, Clock, Verb, ReviewVerb, FlowVerb, Person, Label, Assignee, CheckState, GithubRepository, CACHE_TTL, DEFAULT_LIMIT, MAX_LIMIT, GH_TIMEOUT, USAGE, REVIEW_VERBS, FLOW_VERBS, FLOW_WRITES, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, MAX_THREAD_PAGES, THREADS_QUERY, REVIEWERS_QUERY, PULL_REQUEST_ID_QUERY, ASSIGNABLE_QUERY, AUTO_MERGE_METHODS, FAILED_CONCLUSIONS, LOGIN, ReviewThread, pullRequestNode, threadComment, prThreads, replyThread, resolveThread, requestedReviewer, prReviewers, requestReview, pullRequestId, pullRequestMutation, setPrReady, setAutoMerge, setFileViewed, rerunChecks, IMAGE_LIMIT, IMAGE_TYPES, ImageLocation, imageLocation, repositoryImage, assignable, submitReview, addComment, setIssueState, setPrState, ReviewOptions, parseComments, parseReviewOptions, FlowSpec, FLOW_SPECS, FlowOptions, parseFlow, wholeNumber, fileLine, personLine, executeFlow, executeReview, executeGithub } from "./index.js";

export type PullRequestFile = Readonly<{
  path: string; previousPath?: string; status: "added" | "modified" | "removed" | "renamed";
  additions: number; deletions: number; patch?: string | null;
}>;

export type ReviewComment = Readonly<{ path: string; line: number; side: "LEFT" | "RIGHT"; body: string }>;

export type ReviewEvent = "approve" | "request-changes" | "comment";

export type PullRequestAction = "merge" | "close" | "reopen";

export const FILE_STATUSES: Readonly<Record<string, PullRequestFile["status"]>> = { added: "added", removed: "removed", renamed: "renamed", modified: "modified", changed: "modified", copied: "added" };

export function writeCall(method: "POST" | "PATCH" | "PUT", endpoint: string, fields: Readonly<Record<string, string>>): string[] {
  return ["api", "-X", method, endpoint, ...Object.entries(fields).flatMap(([name, value]) => ["-f", `${name}=${value}`])];
}

export const FILES_PAGE_SIZE = 100;
// A pull request GitHub will show is capped at 3000 files, which is 30 pages of 100.

export const MAX_FILE_PAGES = 30;

export function normalizeFiles(value: unknown, withPatch: boolean): Result<PullRequestFile[]> {
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

export function filesCall(nameWithOwner: string, number: number, page: number, perPage: number): string[] {
  return ["api", `repos/${nameWithOwner}/pulls/${number}/files`, "-X", "GET", "-F", `per_page=${perPage}`, "-F", `page=${page}`];
}

// The viewer's per-file viewed marks are GraphQL-only and come in cursor pages, so one page of files
// reads as many GraphQL pages as it takes to reach its last file. It is an extra: a failure leaves the
// files without it rather than failing them.

export async function viewedStates(process: ProcessAdapter, nameWithOwner: string, number: number, upTo: number): Promise<Map<string, boolean>> {
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
