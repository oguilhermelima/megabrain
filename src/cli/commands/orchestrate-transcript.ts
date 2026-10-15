import { basename } from "node:path";
import { createProcessAdapter, type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { findClaudeTranscriptForWorktree } from "../../core/context-meter.js";
import { formatSessionTranscript, isTranscriptCursor, readTranscriptEvents, terminalTranscript, type SessionTranscript, type TranscriptAgent } from "../../core/session-transcript.js";
import { usageText } from "../../core/usage.js";
import { executeOrchestrateRead, parentMeta } from "./orchestrate-read-liveness.js";
import { listDispatches, stateDatabase } from "../../adapters/state-db.js";
import { tagTranscriptOrigins, type TranscriptOriginDispatch } from "../../core/transcript-origin.js";

type Environment = Readonly<Record<string, string | undefined>>;
type RecordValue = Record<string, unknown>;
const transcriptAgents = new Set<TranscriptAgent>(["claude", "codex", "grok", "agy"]);
const stringValue = (value: unknown): string => typeof value === "string" ? value : "";
const objectValue = (value: unknown): RecordValue | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined;

function transcriptSessionId(meta: RecordValue, agent: string): string | undefined {
  if (agent === "codex") return stringValue(meta.agentThreadId) || undefined;
  if (agent === "grok") return stringValue(meta.grokSessionId) || stringValue(meta.agentSessionId) || undefined;
  return stringValue(meta.agentSessionId) || undefined;
}

function originDispatch(value: Record<string, unknown>): TranscriptOriginDispatch | undefined {
  const dispatchId = stringValue(value.dispatchId);
  if (dispatchId === "") return undefined;
  return {
    dispatchId,
    ...(typeof value.chatName === "string" ? { chatName: value.chatName } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
    ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
    ...(typeof value.parentAgent === "string" ? { parentAgent: value.parentAgent } : {}),
    ...(typeof value.parentChatName === "string" ? { parentChatName: value.parentChatName } : {}),
    ...(typeof value.parentSessionId === "string" ? { parentSessionId: value.parentSessionId } : {}),
  };
}

function parseTranscriptSession(value: string): Result<Readonly<{ agent: TranscriptAgent; id: string }>> {
  const separator = value.indexOf(":");
  const prefix = separator < 0 ? "" : value.slice(0, separator);
  const id = separator < 0 ? "" : value.slice(separator + 1);
  if (!transcriptAgents.has(prefix as TranscriptAgent)) return failed(`unknown agent in session id: ${prefix || value}`, 2);
  if (id === "" || id.includes("/") || id.includes("\\")) return failed("--session must use <agent>:<session-id>", 2);
  return ok({ agent: prefix as TranscriptAgent, id });
}

function transcriptOptions(args: readonly string[]): Result<Readonly<{ id?: string; session?: string; since?: string; limit: number; json: boolean }>> {
  let id: string | undefined;
  let session: string | undefined;
  let since: string | undefined;
  let limit = 300;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--session") {
      if (session !== undefined) return failed("--session may only be supplied once", 2);
      session = args[index + 1];
      if (session === undefined || session.startsWith("--")) return failed("--session requires <agent>:<session-id>", 2);
      index += 1;
    } else if (argument === "--since") {
      if (since !== undefined) return failed("--since may only be supplied once", 2);
      since = args[index + 1];
      if (since === undefined || since.startsWith("--")) return failed("--since requires a cursor", 2);
      index += 1;
    } else if (argument === "--limit") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return failed("--limit requires a number from 1 to 2000", 2);
      limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000) return failed("--limit must be a number from 1 to 2000", 2);
      index += 1;
    } else if (argument === "--json") json = true;
    else if (argument === "-h" || argument === "--help") return ok({ json, id: "--help", limit });
    else if (argument.startsWith("-")) return failed(`unknown orchestrate transcript option: ${argument}`, 2);
    else if (id === undefined) id = argument;
    else return failed("orchestrate transcript accepts one dispatch id", 2);
  }
  if ((id === undefined) === (session === undefined)) return failed(usageText("orchestrate-transcript"), 2);
  return ok({ ...(id === undefined ? {} : { id }), ...(session === undefined ? {} : { session }), ...(since === undefined ? {} : { since }), limit, json });
}

async function terminalFallback(dispatchId: string, agent: string, sessionId: string | undefined, since: string | undefined, json: boolean, environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const read = await executeOrchestrateRead([dispatchId, "--json"], environment, process);
  let text: string;
  if (read.kind === "ok") {
    try {
      const value = objectValue(JSON.parse(read.value) as unknown);
      const hostText = (payload: unknown): string | undefined => {
        const host = objectValue(payload);
        const result = objectValue(host?.result);
        const terminal = objectValue(result?.terminal);
        return Array.isArray(terminal?.tail) ? terminal.tail.filter((line): line is string => typeof line === "string").join("\n") : undefined;
      };
      const wrappedText = stringValue(value?.text);
      text = hostText(value) ?? (wrappedText === "" ? "" : (() => {
        try { return hostText(JSON.parse(wrappedText) as unknown) ?? wrappedText; } catch { return wrappedText; }
      })());
    } catch { text = read.value; }
  } else return failed(read.error, read.exitCode);
  const transcript: SessionTranscript = terminalTranscript(text, dispatchId, sessionId ?? null, agent, since);
  return ok(formatSessionTranscript(transcript, json));
}

export async function executeOrchestrateTranscript(args: readonly string[], environment: Environment, process: ProcessAdapter = createProcessAdapter()): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok(usageText("orchestrate-transcript"));
  const options = transcriptOptions(args);
  if (options.kind !== "ok") return options;
  if (options.value.id === "--help") return ok(usageText("orchestrate-transcript"));
  if (options.value.since !== undefined && !isTranscriptCursor(options.value.since)) return failed("--since must be a cursor returned by orchestrate transcript", 2);
  const home = environment.HOME ?? "";
  if (options.value.session !== undefined) {
    const parsed = parseTranscriptSession(options.value.session);
    if (parsed.kind !== "ok") return parsed;
    const result = home === "" ? undefined : await readTranscriptEvents(parsed.value.agent, home, parsed.value.id, undefined, environment.GROK_HOME, options.value.since, options.value.limit);
    if (result === undefined) return failed(`session log unavailable for ${parsed.value.agent}:${parsed.value.id}; no dispatch terminal is associated with this session`);
    const database = stateDatabase(environment);
    if (database.kind !== "ok") return failed(database.error, database.exitCode);
    const stored = listDispatches(database.value);
    if (stored.kind !== "ok") return stored;
    const dispatches = stored.value.flatMap((item) => {
      const value = originDispatch(item);
      return value === undefined ? [] : [value];
    });
    const events = tagTranscriptOrigins(result.events, null, dispatches);
    const transcript: SessionTranscript = { dispatchId: null, sessionId: result.sessionId, agent: parsed.value.agent, source: result.source, cursor: result.cursor, events, ...(result.truncated ? { truncated: true } : {}) };
    return ok(formatSessionTranscript(transcript, options.value.json));
  }
  const dispatchId = options.value.id;
  if (dispatchId === undefined) return failed(usageText("orchestrate-transcript"), 2);
  const resolved = await parentMeta(dispatchId, environment, process, true);
  if (resolved.kind !== "ok") return resolved;
  const { meta, dispatchId: resolvedId } = resolved.value;
  const agent = stringValue(meta.agent) || "unknown";
  let sessionId = transcriptSessionId(meta, agent);
  let pathOverride: string | undefined;
  if (sessionId === undefined && agent === "claude" && home !== "") {
    pathOverride = await findClaudeTranscriptForWorktree(home, stringValue(meta.worktreePath), stringValue(meta.createdAt));
    if (pathOverride !== undefined) sessionId = basename(pathOverride, ".jsonl");
  }
  const result = home === "" || !transcriptAgents.has(agent as TranscriptAgent) ? undefined
    : await readTranscriptEvents(agent as TranscriptAgent, home, sessionId, stringValue(meta.worktreePath) || undefined, environment.GROK_HOME, options.value.since, options.value.limit, pathOverride);
  if (result !== undefined) {
    const currentDispatch = originDispatch({ ...meta, dispatchId: resolvedId }) ?? null;
    const events = tagTranscriptOrigins(result.events, currentDispatch, []);
    const transcript: SessionTranscript = { dispatchId: resolvedId, sessionId: result.sessionId, agent, source: result.source, cursor: result.cursor, events, ...(result.truncated ? { truncated: true } : {}) };
    return ok(formatSessionTranscript(transcript, options.value.json));
  }
  return terminalFallback(resolvedId, agent, sessionId, options.value.since, options.value.json, environment, process);
}
