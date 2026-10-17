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
import { MAX_THREAD_PAGES, THREADS_QUERY, REVIEWERS_QUERY, PULL_REQUEST_ID_QUERY, ASSIGNABLE_QUERY, AUTO_MERGE_METHODS, FAILED_CONCLUSIONS, LOGIN, ReviewThread, pullRequestNode, threadComment, prThreads, replyThread, resolveThread, requestedReviewer, prReviewers, requestReview, pullRequestId, pullRequestMutation, setPrReady, setAutoMerge, setFileViewed, rerunChecks, IMAGE_LIMIT, IMAGE_TYPES, ImageLocation, imageLocation, repositoryImage, assignable, submitReview, addComment, setIssueState, setPrState } from "./reviews.js";
import { PullRequestFile, ReviewComment, ReviewEvent, PullRequestAction, FILE_STATUSES, writeCall, FILES_PAGE_SIZE, MAX_FILE_PAGES, normalizeFiles, filesCall, viewedStates, prFilesPage, prFile } from "./files.js";
import { GITHUB_REMOTE, githubNameWithOwner, registered, resolveRepository, cacheDirectory, cachePath, readCache, writeCache, dropCached, TRANSIENT, Attempt, attempt, gh, GraphqlAnswer, repositoryVariables, graphqlCall } from "./client.js";
import { VIEWED_QUERY, AUTHOR, LABELS, PR_QUERY, ISSUE_QUERY, PR_VIEW_FIELDS, ISSUE_VIEW_FIELDS, STATES, record, text, nullableText, count, list, person, labels, assignees, lowerState, reviewDecision, checkState, checks, milestone, pullRequest, issue, detail, page, graphqlError, listCommand, Options, parseOptions, listingText, detailText } from "./views.js";

import { Environment, Clock, Verb, ReviewVerb, FlowVerb, Person, Label, Assignee, CheckState, GithubRepository, CACHE_TTL, DEFAULT_LIMIT, MAX_LIMIT, GH_TIMEOUT, USAGE, REVIEW_VERBS, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, ReviewOptions, parseComments, parseReviewOptions, executeReview, executeGithub } from "./index.js";

export const FLOW_VERBS: readonly string[] = ["pr-files", "pr-file", "threads", "thread-reply", "thread-resolve", "reviewers", "request-review", "pr-ready", "auto-merge", "rerun-checks", "file-viewed", "assignable", "image"];
// These change the pull request, so the repository's cached reads go after them.

export const FLOW_WRITES: readonly string[] = ["thread-reply", "thread-resolve", "request-review", "pr-ready", "auto-merge", "rerun-checks", "file-viewed"];

export type FlowSpec = Readonly<{ positional: number; values: readonly string[]; switches: readonly string[]; numbered?: false }>;

export const FLOW_SPECS: Readonly<Record<FlowVerb, FlowSpec>> = {
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
  "image": { positional: 1, values: [], switches: [], numbered: false },
};

export type FlowOptions = Readonly<{ selector: string; number: number; json: boolean; positional: readonly string[]; values: Readonly<Record<string, string>>; switches: ReadonlySet<string> }>;

export function parseFlow(verb: FlowVerb, args: readonly string[]): Result<FlowOptions> {
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
  if (spec.numbered === false) return afterSelector.length === spec.positional ? ok({ selector, number: 0, json, positional: afterSelector, values, switches }) : usage;
  const [numberText, ...rest] = afterSelector;
  if (numberText === undefined || !/^[1-9]\d*$/.test(numberText) || rest.length !== spec.positional) return usage;
  return ok({ selector, number: Number(numberText), json, positional: rest, values, switches });
}

export function wholeNumber(flag: string, raw: string | undefined, fallback: number, maximum: number): Result<number> {
  if (raw === undefined) return ok(fallback);
  const parsedNumber = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(parsedNumber) || parsedNumber < 1 || parsedNumber > maximum) {
    return failed(maximum === Number.MAX_SAFE_INTEGER ? `${flag} must be a whole number from 1` : `${flag} must be a whole number from 1 to ${maximum}`, 2);
  }
  return ok(parsedNumber);
}

export function fileLine(file: PullRequestFile): string {
  return `${file.status}\t+${file.additions}\t-${file.deletions}\t${file.path}\n`;
}

export function personLine(entry: Person | null): string {
  return entry?.login ?? "ghost";
}

export async function executeFlow(verb: FlowVerb, args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
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
  if (verb === "image" && imageLocation(target) === null) return failed(`${target} is not a file in a GitHub repository (github.com/<owner>/<repo>/blob|raw/<ref>/<path> or raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>)`, 2);
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
  } else if (verb === "image") {
    const found = await repositoryImage(process, target);
    if (found.kind !== "ok") return found;
    output = { repository: repository.value, url: target, ...found.value };
    line = `${found.value.contentType}\t${found.value.size}\n`;
  } else {
    const found = await assignable(process, nameWithOwner, values["--query"]);
    if (found.kind !== "ok") return found;
    output = found.value;
    line = found.value.map((entry) => `${entry.login}\t${entry.name ?? ""}\n`).join("");
  }
  if (FLOW_WRITES.includes(verb)) dropCached(environment, nameWithOwner);
  return ok(json ? `${JSON.stringify(output, null, 2)}\n` : line);
}
