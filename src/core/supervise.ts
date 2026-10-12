import { acquireLease } from "../adapters/state-db.js";
import type { DatabaseHandle } from "../db/db.js";

export type SupervisionCause =
  | "usage-limit"
  | "rate-limited"
  | "server-error"
  | "network"
  | "auth-required"
  | "dialog-waiting"
  | "prompt-unsubmitted"
  | "prompt-lost"
  | "process-exited"
  | "pane-gone"
  | "unknown";

export type SupervisionFinding = Readonly<{
  cause: SupervisionCause;
  resetAt?: string;
  errorCode?: string;
  errorText?: string;
  exitCode?: number;
  paneId?: string;
  lastLines?: string;
  worktreePath?: string;
  dirtyFiles?: readonly string[];
}>;

export type RecordedErrorOptions = Readonly<{
  now: number;
  idlePrompt?: boolean;
  lastProgressAt?: number;
}>;

export type PreviousFinding = SupervisionFinding & Readonly<{ notifiedAt: number }>;

const MIN_UNRESOLVED_ERROR_MS = 2 * 60_000;

// Claude transcripts carry no running-state field, so background work is read from the pane: the
// turn line ("... 1 shell, 1 monitor still running") and the footer ("... · 1 shell, 1 monitor · ← 3 agents").
// Both lines describe the same tasks, so the larger per-line count wins; agents are not counted.
export function backgroundTasks(frame: string): number | undefined {
  let most = 0;
  for (const line of frame.split(/\r?\n/)) {
    let count = 0;
    for (const match of line.matchAll(/\b(\d+) (?:shell|monitor)s?\b/g)) count += Number(match[1]);
    most = Math.max(most, count);
  }
  return most > 0 ? most : undefined;
}

export function acquireSupervisorLease(database: DatabaseHandle, holder: string, seconds: number): ReturnType<typeof acquireLease> {
  return acquireLease(database, "supervise", holder, seconds);
}

// A zombie has exited and only waits for its parent to reap it.
export function isLiveProcessState(stat: string): boolean {
  const trimmed = stat.trim();
  return trimmed !== "" && !trimmed.startsWith("Z");
}

export function hasOpenDispatches(states: readonly string[]): boolean {
  return states.some((state) => state === "spawning" || state === "running" || state === "waiting_for_reply" || state === "orphaned");
}

export function shouldNotifyFinding(previous: PreviousFinding | undefined, finding: SupervisionFinding, _now: number): boolean {
  if (finding.cause === "unknown") return false;
  if (previous === undefined || previous.cause !== finding.cause) return true;
  return previous.resetAt !== finding.resetAt
    || previous.errorCode !== finding.errorCode
    || previous.errorText !== finding.errorText
    || previous.exitCode !== finding.exitCode
    || previous.paneId !== finding.paneId;
}

export function mayAutoRecover(finding: SupervisionFinding): boolean {
  return finding.cause === "prompt-unsubmitted";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function claudeText(record: Record<string, unknown>): string | undefined {
  if (record.type !== "assistant") return undefined;
  const message = object(record.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content.flatMap((part) => {
    const block = object(part);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
  // Claude marks API failures on the assistant entry itself. The exact visible phrases below
  // also cover provider errors such as 429 that are recorded without an `error` property.
  if (record.error === undefined && !/^(?:API Error:|\d{3} Too Many Requests|You've hit your usage limit|You’ve hit your usage limit|Request timed out|Connection error|Stream disconnected)/i.test(text.trim())) return undefined;
  return text;
}

function codexText(record: Record<string, unknown>): string | undefined {
  if (record.type !== "event_msg") return undefined;
  const payload = object(record.payload);
  if (payload?.type !== "task_complete") return undefined;
  const error = object(payload.error);
  const info = object(error?.codex_error_info);
  return typeof info?.message === "string" ? info.message : undefined;
}

function recordedText(agent: string, value: unknown): string | undefined {
  const record = object(value);
  if (record === undefined) return undefined;
  return agent === "codex" ? codexText(record) : agent === "claude" ? claudeText(record) : undefined;
}

function resetTime(text: string): string | undefined {
  const patterns = [
    /(?:try again|reset(?:s)?)(?: at| after)?\s+(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i,
    /(?:try again|reset(?:s)?)(?: at| after)?\s+(\d{1,2}:\d{2}\s*(?:AM|PM))/i,
    /(?:try again|reset(?:s)?)(?: at| after)?\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^.,\n]{0,30})/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1] !== undefined) return match[1].replace(/\s+/g, " ").trim();
  }
  return undefined;
}

function classifyErrorText(text: string): SupervisionFinding {
  // Grok 1.0.50's installed CLI binary (`strings ~/.grok/bin/grok`) contains these rendered
  // messages: usage: "You hit your free usage limit."; rate: "You've hit the rate limit for your
  // plan."; server: "Service unavailable"; network: "Session recovery timed out; the server may
  // have processed the POST"; auth: "Auth error: Auth required".
  if (/(?:you['’]ve hit your usage limit|you hit your (?:free )?usage limit|usage limit reached|weekly limit.{0,60}(?:try again|reset))/i.test(text)) {
    return { cause: "usage-limit", resetAt: resetTime(text) ?? "unknown reset time", errorText: "usage limit" };
  }
  const codeMatch = /(?:API Error:\s*|unexpected status\s+|\b)(429|5\d\d|401|403)\b/i.exec(text);
  const code = codeMatch?.[1];
  if (code === "401" || code === "403" || /(?:auth error:\s*auth required|authentication response failed|authentication required|unauthorized|access token[^.]{0,80}revoked|not logged in)/i.test(text)) {
    return { cause: "auth-required", ...(code === undefined ? {} : { errorCode: code }), errorText: text.slice(0, 200) };
  }
  if (code === "429" || /429 Too Many Requests|rate limit exceeded|you['’]ve hit the rate limit for your plan|\brate limited\b/i.test(text)) return { cause: "rate-limited", errorCode: "429", errorText: text.slice(0, 200) };
  if ((code !== undefined && Number(code) >= 500) || /overloaded_error|overloaded|internal server error|\bservice unavailable\b|\bserver error\b|something went wrong on our side/i.test(text)) {
    return { cause: "server-error", ...(code === undefined ? {} : { errorCode: code }), errorText: text.slice(0, 200) };
  }
  if (/(?:request timed out|timed out waiting|session recovery timed out|connection error|stream disconnected|http_connection_failed)/i.test(text)) {
    const errorCode = /timed out/i.test(text) ? "timeout" : /stream disconnected/i.test(text) ? "stream disconnected" : "connection error";
    return { cause: "network", errorCode, errorText: text.slice(0, 200) };
  }
  return { cause: "unknown" };
}

function recordTime(record: Record<string, unknown>): number | undefined {
  const value = record.timestamp ?? record.created_at;
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

export function classifyRecordedError(agent: string, value: unknown, options: RecordedErrorOptions): SupervisionFinding {
  const record = object(value);
  const text = recordedText(agent, value);
  if (record === undefined || text === undefined || text === "") return { cause: "unknown" };
  const errorAt = recordTime(record);
  if (options.lastProgressAt !== undefined && errorAt !== undefined && options.lastProgressAt > errorAt) return { cause: "unknown" };
  if (!options.idlePrompt && (errorAt === undefined || options.now - errorAt < MIN_UNRESOLVED_ERROR_MS)) return { cause: "unknown" };
  return classifyErrorText(text);
}

export type SupervisionEvidence = Readonly<{
  frame: string;
  paneExists: boolean;
  processAlive: boolean;
  promptUnsubmitted: boolean;
  exitCode?: number;
  worktreePath?: string;
  dirtyFiles?: readonly string[];
}>;

function lastLines(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-3).join(" | ") || undefined;
}

export function classifySupervision(evidence: SupervisionEvidence): SupervisionFinding {
  if (!evidence.paneExists) return { cause: "pane-gone", worktreePath: evidence.worktreePath, dirtyFiles: evidence.dirtyFiles };
  if (!evidence.processAlive) return { cause: "process-exited", ...(evidence.exitCode === undefined ? {} : { exitCode: evidence.exitCode }), ...(lastLines(evidence.frame) === undefined ? {} : { lastLines: lastLines(evidence.frame) }), worktreePath: evidence.worktreePath, dirtyFiles: evidence.dirtyFiles };
  if (/(?:trust this project|trust this folder|permission required|allow this command|do you want to allow|press enter to continue)/i.test(evidence.frame)) return { cause: "dialog-waiting" };
  if (evidence.promptUnsubmitted) return { cause: "prompt-unsubmitted" };
  const frameFinding = classifyErrorText(evidence.frame);
  if (frameFinding.cause !== "unknown") return frameFinding;
  return { cause: "unknown" };
}

export function recommendationFor(finding: SupervisionFinding, dispatchId = "<dispatch-id>"): string | undefined {
  switch (finding.cause) {
    case "usage-limit": return `Switch this lane to another agent or wait until ${finding.resetAt ?? "the reset"}.`;
    case "rate-limited": return `Wait for the provider to recover, or continue the child with megabrain orchestrate change ${dispatchId} --text "continue"; the provider returned ${finding.errorCode ?? "429"}.`;
    case "server-error": return `Wait for the provider to recover, or continue the child with megabrain orchestrate change ${dispatchId} --text "continue"; the provider returned ${finding.errorCode ?? "a server error"}.`;
    case "network": return `Wait for the connection to recover, or continue the child with megabrain orchestrate change ${dispatchId} --text "continue"; last error: ${finding.errorCode ?? "network error"}.`;
    case "auth-required": return "Ask the operator to log in to the agent, then inspect the dispatch.";
    case "dialog-waiting": return "Please answer the dialog, or respawn this lane in the same worktree.";
    case "prompt-unsubmitted": return "The prompt was resubmitted automatically; inspect the dispatch to confirm it started.";
    case "prompt-lost": return `The prompt never reached the agent: it is idle at an empty composer with no receipt. Please resend the brief with megabrain orchestrate reply ${dispatchId} --text "<brief>".`;
    case "process-exited":
    case "pane-gone": {
      const changes = finding.dirtyFiles ?? [];
      const detail = changes.length > 0 ? ` Uncommitted changes: ${changes.join(", ")}.` : "";
      return `You can respawn this lane in the same worktree.${detail}`;
    }
    case "unknown": return undefined;
  }
}
