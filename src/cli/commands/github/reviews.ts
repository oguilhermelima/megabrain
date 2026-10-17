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
import { PullRequestFile, ReviewComment, ReviewEvent, PullRequestAction, FILE_STATUSES, writeCall, FILES_PAGE_SIZE, MAX_FILE_PAGES, normalizeFiles, filesCall, viewedStates, prFilesPage, prFile } from "./files.js";
import { GITHUB_REMOTE, githubNameWithOwner, registered, resolveRepository, cacheDirectory, cachePath, readCache, writeCache, dropCached, TRANSIENT, Attempt, attempt, gh, GraphqlAnswer, repositoryVariables, graphqlCall } from "./client.js";
import { VIEWED_QUERY, AUTHOR, LABELS, PR_QUERY, ISSUE_QUERY, PR_VIEW_FIELDS, ISSUE_VIEW_FIELDS, STATES, record, text, nullableText, count, list, person, labels, assignees, lowerState, reviewDecision, checkState, checks, milestone, pullRequest, issue, detail, page, graphqlError, listCommand, Options, parseOptions, listingText, detailText } from "./views.js";

import { Environment, Clock, Verb, ReviewVerb, FlowVerb, Person, Label, Assignee, CheckState, GithubRepository, CACHE_TTL, DEFAULT_LIMIT, MAX_LIMIT, GH_TIMEOUT, USAGE, REVIEW_VERBS, FLOW_VERBS, FLOW_WRITES, REVIEW_EVENTS, ISSUE_REASONS, MERGE_METHODS, ReviewOptions, parseComments, parseReviewOptions, FlowSpec, FLOW_SPECS, FlowOptions, parseFlow, wholeNumber, fileLine, personLine, executeFlow, executeReview, executeGithub } from "./index.js";

export const MAX_THREAD_PAGES = 50;

export const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id path line originalLine diffSide isResolved isOutdated comments(first: 100) { nodes { id ${AUTHOR} body createdAt } } }
      }
    }
  }
}`;

export const REVIEWERS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
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

export const PULL_REQUEST_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`;

export const ASSIGNABLE_QUERY = `query($owner: String!, $name: String!, $search: String) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 50, query: $search) { nodes { __typename login ... on User { name } } }
    owner { __typename ... on Organization { teams(first: 50, query: $search) { nodes { slug name organization { login } } } } }
  }
}`;

export const AUTO_MERGE_METHODS: Readonly<Record<string, string>> = { merge: "MERGE", squash: "SQUASH", rebase: "REBASE" };

export const FAILED_CONCLUSIONS: readonly string[] = ["failure", "timed_out", "cancelled", "startup_failure"];

export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

export type ReviewThread = Readonly<{
  id: string; path: string; line: number | null; side: "LEFT" | "RIGHT"; isResolved: boolean; isOutdated: boolean;
  comments: readonly Readonly<{ id: string; author: Person | null; body: string; createdAt: string }>[];
}>;

// The pull request inside a GraphQL answer, or GitHub's own reason it is not there.

export function pullRequestNode(answer: GraphqlAnswer, number: number): Result<Record<string, unknown>> {
  const found = record(record(answer.data.repository)?.pullRequest);
  return found === undefined ? failed(`gh api graphql failed: ${answer.error ?? `pull request #${number} was not found`}`) : ok(found);
}

export function threadComment(entry: Record<string, unknown>) {
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

export function requestedReviewer(entry: Record<string, unknown>) {
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

export async function pullRequestId(process: ProcessAdapter, nameWithOwner: string, number: number): Promise<Result<string>> {
  const answer = await graphqlCall(process, "gh api graphql", PULL_REQUEST_ID_QUERY, { ...repositoryVariables(nameWithOwner), number });
  if (answer.kind !== "ok") return answer;
  const found = pullRequestNode(answer.value, number);
  if (found.kind !== "ok") return found;
  const id = text(found.value.id);
  return id === "" ? failed(`gh api graphql failed: pull request #${number} has no id`) : ok(id);
}

// A mutation on a pull request needs its node id, which is one read away; the mutation is asked once.

export async function pullRequestMutation(process: ProcessAdapter, nameWithOwner: string, number: number, operation: string, declarations: string, input: string, variables: Readonly<Record<string, string>> = {}): Promise<Result<Record<string, unknown>>> {
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

// A picture a pull request body shows from its own repository. A private repository's file links
// answer 404 without a session, so the bytes come through gh's API with its token, which never
// leaves this process: the contents endpoint up to 1 MB, the git blob beyond it.

export const IMAGE_LIMIT = 20 * 1024 * 1024;

export const IMAGE_TYPES: readonly (readonly [string, (bytes: Buffer) => boolean])[] = [
  ["image/png", (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["image/jpeg", (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff],
  ["image/gif", (bytes) => ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1"))],
  ["image/webp", (bytes) => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP"],
];

export type ImageLocation = Readonly<{ owner: string; name: string; ref: string; path: string }>;

/** The repository file a github.com blob or raw link, or a raw.githubusercontent.com link, names. */

export function imageLocation(url: string): ImageLocation | null {
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { return null; }
  if (parsedUrl.protocol !== "https:") return null;
  let segments: string[];
  try { segments = parsedUrl.pathname.split("/").filter((segment) => segment !== "").map(decodeURIComponent); } catch { return null; }
  let owner: string | undefined;
  let name: string | undefined;
  let rest: string[];
  if (parsedUrl.hostname === "github.com") {
    const [first, second, kind, ...tail] = segments;
    if (kind !== "blob" && kind !== "raw") return null;
    [owner, name, rest] = [first, second, tail];
  } else if (parsedUrl.hostname === "raw.githubusercontent.com") {
    const [first, second, ...tail] = segments;
    [owner, name, rest] = [first, second, tail];
  } else return null;
  const [ref, ...path] = rest;
  if (owner === undefined || name === undefined || ref === undefined || path.length === 0 || !LOGIN.test(owner) || !/^[\w.-]+$/.test(name)) return null;
  return { owner, name, ref, path: path.join("/") };
}

export async function repositoryImage(process: ProcessAdapter, url: string): Promise<Result<{ contentType: string; size: number; data: string }>> {
  const location = imageLocation(url);
  if (location === null) return failed(`${url} is not a file in a GitHub repository`, 2);
  const repo = `repos/${location.owner}/${location.name}`;
  const encodedPath = location.path.split("/").map(encodeURIComponent).join("/");
  const found = await gh(process, ["api", `${repo}/contents/${encodedPath}?ref=${encodeURIComponent(location.ref)}`], { name: "gh api contents" });
  if (found.kind !== "ok") return found;
  const file = record(found.value);
  if (file === undefined || file.type !== "file") return failed(`${location.path} is not a file at ${location.ref}`);
  if (count(file.size) > IMAGE_LIMIT) return failed(`${location.path} is larger than ${IMAGE_LIMIT / 1024 / 1024} MB`);
  let content = text(file.content);
  if (file.encoding !== "base64" || content === "") {
    const blob = await gh(process, ["api", `${repo}/git/blobs/${text(file.sha)}`], { name: "gh api git blob" });
    if (blob.kind !== "ok") return blob;
    content = text(record(blob.value)?.content);
  }
  const bytes = Buffer.from(content, "base64");
  const type = IMAGE_TYPES.find(([, matches]) => matches(bytes))?.[0];
  if (type === undefined) return failed(`${location.path} is not a PNG, JPEG, GIF or WebP image`);
  return ok({ contentType: type, size: bytes.length, data: bytes.toString("base64") });
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
