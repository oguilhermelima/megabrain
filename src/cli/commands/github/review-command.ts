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

import { Environment, Clock, Verb, ReviewVerb, FlowVerb, Person, Label, Assignee, CheckState, GithubRepository, CACHE_TTL, DEFAULT_LIMIT, MAX_LIMIT, GH_TIMEOUT, USAGE, executeGithub } from "./index.js";
import { resolveRepository, dropCached } from "./client.js";
import { submitReview, addComment, setIssueState, setPrState } from "./reviews.js";
import { record, text } from "./views.js";
import type { ReviewEvent, ReviewComment } from "./files.js";

export const REVIEW_VERBS: readonly string[] = ["review", "comment", "issue-state", "pr-state"];

export const REVIEW_EVENTS: Readonly<Record<string, string>> = { "approve": "APPROVE", "request-changes": "REQUEST_CHANGES", "comment": "COMMENT" };

export const ISSUE_REASONS: Readonly<Record<string, string>> = { "completed": "completed", "not planned": "not_planned" };

export const MERGE_METHODS: readonly string[] = ["merge", "squash", "rebase"];

export type ReviewOptions = Readonly<{
  selector: string; number: number; json: boolean; event: ReviewEvent | undefined; body: string | undefined;
  comments: readonly ReviewComment[] | undefined; state: string | undefined; reason: string | undefined; method: string | undefined;
}>;

export function parseComments(raw: string): Result<readonly ReviewComment[]> {
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

export function parseReviewOptions(verb: ReviewVerb, args: readonly string[]): Result<ReviewOptions> {
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

export async function executeReview(verb: ReviewVerb, args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
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

