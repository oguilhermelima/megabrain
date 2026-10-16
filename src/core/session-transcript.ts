import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { findClaudeTranscript, findClaudeTranscriptForWorktree, findCodexRollout } from "./context-meter.js";

export type TranscriptAgent = "claude" | "codex" | "grok" | "agy";
export type TranscriptSource = TranscriptAgent | "terminal";
export type TranscriptKind = "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "system";
export type TranscriptTool = Readonly<{ name: string; input?: string; status?: "ok" | "error" }>;
export type TranscriptOrigin = Readonly<{ kind: "parent" | "child"; label: string; dispatchId: string | null; sessionId: string | null }>;
export type TranscriptNotice = Readonly<{
  kind: "finished" | "ask" | "stuck" | "failed" | "limit" | "other";
  agent: TranscriptAgent | null;
  label: string | null;
  dispatchId: string | null;
  summary: string;
}>;
export type TranscriptImage = Readonly<{ path: string }> | Readonly<{ dataUrl: string }>;
export type TranscriptEvent = Readonly<{ id: string; at: string | null; kind: TranscriptKind; text: string; tool?: TranscriptTool; origin?: TranscriptOrigin; notice?: TranscriptNotice; images?: readonly TranscriptImage[] }>;
export type SessionTranscript = Readonly<{
  dispatchId: string | null;
  sessionId: string | null;
  agent: string;
  source: TranscriptSource;
  cursor: string;
  events: readonly TranscriptEvent[];
  truncated?: true;
}>;

type JsonRecord = Record<string, unknown>;
type LineEvent = Readonly<{ event: TranscriptEvent; offset: number }>;

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

function textValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => {
    const item = record(part);
    return textValue(item?.text ?? item?.thinking ?? item?.content ?? "");
  }).filter(Boolean).join("\n");
  return "";
}

function jsonText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function shellCommand(name: string, input: string | undefined): string | undefined {
  if (input === undefined || (name !== "exec" && name.toLowerCase() !== "bash")) return undefined;
  const commandFrom = (value: unknown): string | undefined => {
    const item = record(value);
    const command = string(item?.cmd) ?? string(item?.command);
    return command?.split("\n", 1)[0]?.slice(0, 200);
  };
  try {
    const parsed: unknown = JSON.parse(input);
    const command = commandFrom(parsed);
    if (command !== undefined) return command;
  } catch { /* Some Codex logs serialize the wrapper call as source text. */ }
  const match = /(?:cmd|command)\s*:\s*("(?:\\.|[^"\\])*")/.exec(input);
  if (match?.[1] === undefined) return undefined;
  try {
    const command: unknown = JSON.parse(match[1]);
    return typeof command === "string" ? command.split("\n", 1)[0]?.slice(0, 200) : undefined;
  } catch { return undefined; }
}

function toolText(name: string, input: string | undefined): string {
  return shellCommand(name, input) ?? name;
}

function capText(value: string): string {
  const marker = "\n[truncated]";
  return value.length <= 8000 ? value : `${value.slice(0, 8000 - marker.length)}${marker}`;
}

function event(at: unknown, kind: TranscriptKind, text: string, tool?: TranscriptTool): Omit<TranscriptEvent, "id"> {
  const date = typeof at === "string" ? new Date(at)
    : typeof at === "number" && Number.isFinite(at) ? new Date(at < 100000000000 ? at * 1000 : at)
      : undefined;
  const timestamp = date !== undefined && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  const safeTool = tool === undefined ? undefined : {
    name: capText(tool.name),
    ...(tool.input === undefined ? {} : { input: capText(tool.input) }),
    ...(tool.status === undefined ? {} : { status: tool.status }),
  };
  return { at: timestamp, kind, text: capText(text), ...(safeTool === undefined ? {} : { tool: safeTool }) };
}

function contentEvents(content: unknown, role: string, at: unknown): Omit<TranscriptEvent, "id">[] {
  if (typeof content === "string") return content === "" ? [] : [event(at, roleKind(role), content)];
  if (!Array.isArray(content)) return [];
  const events: Omit<TranscriptEvent, "id">[] = [];
  for (const rawPart of content) {
    const part = record(rawPart);
    if (part === undefined) continue;
    const type = string(part.type) ?? "";
    if (type === "thinking" || type === "reasoning") {
      const value = textValue(part.thinking ?? part.text ?? part.content);
      if (value !== "") events.push(event(at, "thinking", value));
    } else if (type === "tool_use" || type === "tool_call" || type === "function_call" || type === "custom_tool_call") {
      const name = string(part.name) ?? string(part.tool_name) ?? "tool";
      const input = jsonText(part.input ?? part.arguments);
      events.push(event(at, "tool-call", toolText(name, input), { name, ...(input === undefined ? {} : { input }) }));
    } else if (type === "tool_result" || type === "function_call_output" || type === "custom_tool_call_output") {
      const result = textValue(part.content ?? part.output ?? part.text);
      const isError = part.is_error === true || part.status === "error" || part.status === "failed";
      const name = string(part.name) ?? string(part.tool_name) ?? "tool";
      events.push(event(at, "tool-result", result, { name, status: isError ? "error" : "ok" }));
    } else if (["text", "input_text", "output_text", "refusal"].includes(type)) {
      const value = textValue(part.text ?? part.content);
      if (value !== "") events.push(event(at, roleKind(role), value));
    }
  }
  return events;
}

function roleKind(role: string): TranscriptKind {
  return role === "user" ? "user" : role === "system" || role === "developer" ? "system" : "assistant";
}

function tagValue(text: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<${escaped}>([\\s\\S]*?)</${escaped}>`, "i").exec(text)?.[1]?.trim();
}

// Claude Code's own text around a cross-session envelope (measured on 2.1.299): a lead line, the
// envelope, a "This came from another Claude session" paragraph and an optional reply instruction.
const PEER_LEAD = /Another Claude session sent a message(?: while you were working)?:\s*$/;
const PEER_TAIL = /^\s*This came from another Claude session[\s\S]*?permission laundering\.(?:\s*After completing your current task[^\n]*)?/;

function stripPeerWrapper(text: string, envelope: string): string {
  const at = text.indexOf(envelope);
  if (at < 0) return text;
  const before = text.slice(0, at).replace(PEER_LEAD, "");
  const after = text.slice(at + envelope.length).replace(PEER_TAIL, "");
  return before + after;
}

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_SOURCE_LINE = /^[ \t]*\[Image: source: ([^\]\n]+)\][ \t]*\r?\n?/gm;

// Claude writes a pasted image as an "[Image: source: <path>]" line (the "[Image #N]" marker stays in
// the text) and an attached one as an image content block.
function pullImages(text: string, images: TranscriptImage[]): string {
  return text.replace(IMAGE_SOURCE_LINE, (_, path: string) => { images.push({ path: path.trim() }); return ""; });
}

function imageBlock(part: JsonRecord): TranscriptImage | undefined {
  const source = record(part.source);
  if (source === undefined) return undefined;
  const data = string(source.data);
  if (data !== undefined) {
    if (Math.floor(data.length * 3 / 4) > MAX_INLINE_IMAGE_BYTES) return undefined;
    return { dataUrl: `data:${string(source.media_type) ?? "image/png"};base64,${data}` };
  }
  const path = string(source.path);
  return path === undefined ? undefined : { path };
}

function withImages(events: Omit<TranscriptEvent, "id">[], images: readonly TranscriptImage[], at: unknown): Omit<TranscriptEvent, "id">[] {
  if (images.length === 0) return events;
  const index = events.findIndex(({ kind }) => kind === "user");
  if (index < 0) return [...events, { ...event(at, "user", ""), images }];
  return events.map((item, position) => position === index ? { ...item, images } : item);
}

const NOTICE_HEADER = /^\S+\s+(claude|codex|grok|agy)\s+·\s+(.+?)\s+(finished|has a question|is stuck|hit its limit|failed)\s*$/u;
const NOTICE_KINDS = { finished: "finished", "has a question": "ask", "is stuck": "stuck", "hit its limit": "limit", failed: "failed" } as const;

// Reads the envelope megabrain writes: header line, one-sentence summary, details pointer.
function parseNotice(body: string): TranscriptNotice {
  const lines = body.trim().split(/\r?\n/);
  const header = NOTICE_HEADER.exec(lines[0] ?? "");
  const dispatchId = /details:\s*megabrain orchestrate watch ([a-z0-9]+)\b/i.exec(body)?.[1] ?? null;
  const summary = lines.slice(1).find((line) => line.trim() !== "" && !/^→/.test(line.trim()))?.trim() ?? "";
  if (header === null) return { kind: "other", agent: null, label: null, dispatchId, summary };
  return {
    kind: NOTICE_KINDS[header[3] as keyof typeof NOTICE_KINDS],
    agent: header[1] as TranscriptAgent,
    label: header[2] ?? null,
    dispatchId,
    summary,
  };
}

function claudeUserText(text: string, at: unknown): Omit<TranscriptEvent, "id">[] {
  const events: Omit<TranscriptEvent, "id">[] = [];
  const withoutInjected = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  const task = /<task-notification>([\s\S]*?)<\/task-notification>/i.exec(withoutInjected);
  let remaining = withoutInjected;
  if (task !== null) {
    const body = task[1] ?? "";
    const rawSummary = tagValue(body, "summary") ?? "Background command";
    const summaryText = rawSummary.replace(/^Background command\s+/i, "")
      .replace(/\s+was stopped because[\s\S]*$/i, "")
      .replace(/\s+(?:completed|failed)(?:\s+\(exit code [^)]+\))?\s*$/i, "")
      .replace(/^"([\s\S]*)"$/, "$1")
      .replace(/\b([A-Z][A-Z0-9_]*)=(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s;]+/gi, "$1=[redacted]")
      .replace(/\/(?:private\/tmp|tmp|Users)\/[^\s"'<>;&|]+/g, "[path]")
      .replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
      .trim();
    const summary = summaryText.length <= 120 ? summaryText : "";
    const status = tagValue(body, "status") ?? (/\b(?:failed|killed|stopped)\b/i.test(rawSummary) ? "failed" : "completed");
    const exitCode = tagValue(body, "exit-code") ?? tagValue(body, "exitCode")
      ?? /\(exit code ([^)]+)\)/i.exec(rawSummary)?.[1];
    const failed = /fail|error|killed|stopped/i.test(status) || (exitCode !== undefined && exitCode !== "0");
    const suffix = exitCode === undefined ? "" : ` (exit code ${exitCode})`;
    events.push(event(at, "system", `Background command${summary === "" ? "" : ` ${summary}`} ${failed ? "failed" : "completed"}${suffix}`));
    remaining = remaining.replace(task[0], "");
  }
  const peer = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/i.exec(remaining);
  if (peer !== null) {
    const name = /from-name="([^"]+)"/i.exec(peer[1])?.[1];
    const firstLine = peer[2]?.trim().split(/\r?\n/, 1)[0] ?? "";
    const dispatchDetail = name?.toLowerCase() === "megabrain"
      ? /details:\s*megabrain orchestrate watch [a-z0-9]{8}\b/i.exec(peer[2] ?? "")?.[0]
      : undefined;
    if (firstLine !== "") {
      const base = event(at, "system", `Message from ${name ?? "another session"}: ${firstLine}${dispatchDetail === undefined ? "" : `\n${dispatchDetail}`}`);
      events.push(name?.toLowerCase() === "megabrain" ? { ...base, notice: parseNotice(peer[2] ?? "") } : base);
    }
    remaining = stripPeerWrapper(remaining, peer[0]);
  }
  const command = tagValue(remaining, "command-name");
  const args = tagValue(remaining, "command-args");
  const stdout = tagValue(remaining, "local-command-stdout");
  if (command !== undefined) {
    events.push(event(at, "system", `${command}${args === undefined ? "" : ` ${args}`}`));
    if (stdout !== undefined && stdout !== "") events.push(event(at, "tool-result", stdout, { name: "local command", status: "ok" }));
    remaining = remaining.replace(/<command-name>[\s\S]*?<\/command-name>|<command-args>[\s\S]*?<\/command-args>|<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "");
  }
  const userText = remaining.replace(/<[^>]+>/g, "").trim();
  if (userText !== "") events.unshift(event(at, "user", userText));
  return events;
}

function claudeLine(value: JsonRecord): Omit<TranscriptEvent, "id">[] {
  const type = string(value.type) ?? "";
  if (type !== "user" && type !== "assistant" && type !== "system") return [];
  const message = record(value.message);
  const role = string(message?.role) ?? type;
  if (role === "user") {
    const content = message?.content;
    if (typeof content === "string") {
      const images: TranscriptImage[] = [];
      return withImages(claudeUserText(pullImages(content, images), value.timestamp), images, value.timestamp);
    }
    if (Array.isArray(content)) {
      const events: Omit<TranscriptEvent, "id">[] = [];
      const images: TranscriptImage[] = [];
      for (const partValue of content) {
        const part = record(partValue);
        if (part === undefined) continue;
        if (string(part.type) === "text") events.push(...claudeUserText(pullImages(string(part.text) ?? "", images), value.timestamp));
        else if (string(part.type) === "image") {
          const image = imageBlock(part);
          if (image !== undefined) images.push(image);
        } else if (string(part.type) === "task-notification") {
          const summary = string(part.summary) ?? "Background command";
          const status = string(part.status) ?? "completed";
          const exitCode = typeof part.exitCode === "number" ? String(part.exitCode) : undefined;
          const failed = /fail|error/i.test(status) || (exitCode !== undefined && exitCode !== "0");
          events.push(event(value.timestamp, "system", `Background command ${summary} ${failed ? "failed" : "completed"}${exitCode === undefined ? "" : ` (exit code ${exitCode})`}`));
        }
        else events.push(...contentEvents([part], role, value.timestamp));
      }
      return withImages(events, images, value.timestamp);
    }
  }
  return contentEvents(message?.content, role, value.timestamp);
}

function codexPartEvents(payload: JsonRecord, at: unknown): Omit<TranscriptEvent, "id">[] {
  const type = string(payload.type) ?? "";
  if (type === "message") return contentEvents(payload.content, string(payload.role) ?? "assistant", at);
  if (type === "reasoning") {
    const summary = textValue(payload.summary ?? payload.content);
    return summary === "" ? [] : [event(at, "thinking", summary)];
  }
  if (["function_call", "custom_tool_call", "local_shell_call"].includes(type)) {
    const name = string(payload.name) ?? string(payload.tool_name) ?? (type === "local_shell_call" ? "shell" : "tool");
    const input = jsonText(payload.arguments ?? payload.input);
    return [event(at, "tool-call", toolText(name, input), { name, ...(input === undefined ? {} : { input }) })];
  }
  if (["function_call_output", "custom_tool_call_output"].includes(type)) {
    const output = textValue(payload.output ?? payload.content);
    const status = payload.status === "error" || payload.status === "failed" ? "error" : "ok";
    return [event(at, "tool-result", output, { name: string(payload.name) ?? "tool", status })];
  }
  return [];
}

function codexLine(value: JsonRecord): Omit<TranscriptEvent, "id">[] {
  if (value.type !== "response_item") return [];
  const payload = record(value.payload);
  return payload === undefined ? [] : codexPartEvents(payload, value.timestamp);
}

function grokLine(value: JsonRecord): Omit<TranscriptEvent, "id">[] {
  const params = record(value.params);
  const update = record(params?.update);
  if (update === undefined) return [];
  const type = string(update?.sessionUpdate) ?? "";
  const at = value.timestamp;
  const content = record(update?.content);
  const text = textValue(content?.text ?? content?.content ?? update?.text);
  if (type === "user_message_chunk") return text === "" ? [] : [event(at, "user", text)];
  if (type === "agent_message_chunk") return text === "" ? [] : [event(at, "assistant", text)];
  if (type === "thinking" || type === "agent_thought_chunk" || type === "thought_chunk") return text === "" ? [] : [event(at, "thinking", text)];
  if (type === "tool_call") {
    const call = record(update.toolCall) ?? update;
    const meta = record(record(record(update._meta)?.["x.ai/tool"]));
    const name = string(call.name) ?? string(call.toolName) ?? string(meta?.name) ?? string(update.title) ?? "tool";
    const input = jsonText(call.input ?? call.arguments ?? call.parameters ?? update.rawInput);
    return [event(at, "tool-call", name, { name, ...(input === undefined ? {} : { input }) })];
  }
  if (type === "tool_result" || type === "tool_call_update") {
    const result = record(update.toolResult) ?? update;
    const output = textValue(result.content ?? result.output ?? result.text);
    const meta = record(record(record(result._meta)?.["x.ai/tool"]));
    const status = result.status === "error" || result.status === "failed" || result.isError === true ? "error" : "ok";
    return [event(at, "tool-result", output, { name: string(result.name) ?? string(meta?.name) ?? string(result.title) ?? "tool", status })];
  }
  return [];
}

function parseLine(agent: TranscriptAgent, value: JsonRecord): Omit<TranscriptEvent, "id">[] {
  if (agent === "claude") return claudeLine(value);
  if (agent === "codex") return codexLine(value);
  if (agent === "grok") return grokLine(value);
  return [];
}

function cursorOffset(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor === "") return 0;
  const match = /^v1:(0|[1-9]\d*)$/.exec(cursor);
  if (match?.[1] === undefined) return undefined;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : undefined;
}

export function parseSessionLog(agent: TranscriptAgent, source: string, contents: string, since?: string, limit = 300): Readonly<{ cursor: string; events: readonly TranscriptEvent[]; truncated?: true }> | undefined {
  const after = cursorOffset(since);
  if (after === undefined) return undefined;
  const bytes = Buffer.from(contents, "utf8");
  const events: LineEvent[] = [];
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    if (newline < 0) break;
    const end = newline + 1;
    const line = bytes.subarray(start, newline).toString("utf8").replace(/\r$/, "");
    try {
      const parsed = record(JSON.parse(line) as unknown);
      if (parsed !== undefined) {
        const values = parseLine(agent, parsed);
        values.forEach((value, index) => {
          events.push({ event: { ...value, id: `${source}:${start}:${index}` }, offset: start });
        });
      }
    } catch { /* Ignore malformed and partial records; the next complete line remains readable. */ }
    start = end;
  }
  const cursor = `v1:${start}`;
  const matched = events.filter((entry) => entry.offset >= after).map(({ event: item }) => item);
  const truncated = matched.length > limit;
  return { cursor, events: truncated ? matched.slice(-limit) : matched, ...(truncated ? { truncated: true as const } : {}) };
}

export function isTranscriptCursor(cursor: string): boolean {
  return cursorOffset(cursor) !== undefined || /^terminal:[a-f0-9]{64}$/.test(cursor);
}

async function findGrokTranscript(root: string, sessionId: string): Promise<string | undefined> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) continue;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === sessionId) {
          const transcriptPath = join(path, "updates.jsonl");
          try { if ((await stat(transcriptPath)).isFile()) return transcriptPath; } catch { /* Search the remaining session roots. */ }
        }
        pending.push(path);
      }
    }
  }
  return undefined;
}

export async function sessionLogPath(agent: TranscriptAgent, home: string, sessionId: string, cwd?: string, grokHome?: string): Promise<string | undefined> {
  if (sessionId === "" || sessionId.includes("/") || sessionId.includes("\\") || sessionId === "." || sessionId === "..") return undefined;
  if (agent === "claude") return findClaudeTranscript(home, sessionId);
  if (agent === "codex") return findCodexRollout(home, sessionId);
  if (agent === "grok") {
    if (cwd !== undefined && cwd !== "") {
      const path = join(grokHome ?? join(home, ".grok"), "sessions", encodeURIComponent(cwd), sessionId, "updates.jsonl");
      return path;
    }
    return findGrokTranscript(join(grokHome ?? join(home, ".grok"), "sessions"), sessionId);
  }
  return undefined;
}

export async function readTranscriptEvents(agent: TranscriptAgent, home: string, sessionId: string | undefined, cwd: string | undefined, grokHome: string | undefined, since: string | undefined, limit = 300, pathOverride?: string): Promise<Readonly<{ source: TranscriptSource; sessionId: string | null; cursor: string; events: readonly TranscriptEvent[]; truncated?: true }> | undefined> {
  if (sessionId === undefined || sessionId === "" || agent === "agy") return undefined;
  const path = pathOverride ?? await sessionLogPath(agent, home, sessionId, cwd, grokHome);
  if (path === undefined) return undefined;
  let contents: string;
  try { contents = await readFile(path, "utf8"); } catch { return undefined; }
  const source = createHash("sha256").update(path).digest("hex").slice(0, 16);
  const parsed = parseSessionLog(agent, source, contents, since, limit);
  return parsed === undefined ? undefined : { ...parsed, source: agent, sessionId };
}

export function terminalTranscript(text: string, dispatchId: string | null, sessionId: string | null, agent: string, since?: string): SessionTranscript {
  const hash = createHash("sha256").update(text).digest("hex");
  const cursor = `terminal:${hash}`;
  const eventId = `terminal:${hash}`;
  return {
    dispatchId, sessionId, agent, source: "terminal", cursor,
    events: since === cursor ? [] : [{ id: eventId, at: null, kind: "system", text: capText(text) }],
  };
}

export function formatSessionTranscript(transcript: SessionTranscript, json: boolean): string {
  if (json) return `${JSON.stringify(transcript, null, 2)}\n`;
  return `${transcript.events.map((item) => `${item.kind}\n${item.text}`).join("\n\n")}\n`;
}
