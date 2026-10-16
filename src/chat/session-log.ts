import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Chat, ChatEvent } from "./store.js";

/** One conversation entry read from an agent's own session log; `sourceId` is stable across reads, so an import can skip what it already holds. */
export type LoggedTurn = Pick<ChatEvent, "kind" | "text" | "tool" | "messageId"> & { sourceId: string; at: string };

function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function records(content: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    // The agent may be mid-write: a cut last line is not an entry yet.
    try { rows.push(object(JSON.parse(line))); } catch { /* partial line */ }
  }
  return rows;
}
function blocks(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
function flatten(value: unknown): string { return Array.isArray(value) ? value.map((part) => text(object(part).text)).join("") : text(value); }
/** An entry's own id when it yields one event, else the id with the event's position. */
function identify(id: string, turns: Omit<LoggedTurn, "sourceId" | "at">[], at: string): LoggedTurn[] {
  return turns.map((turn, index) => ({ ...turn, sourceId: turns.length === 1 ? id : `${id}:${index}`, at }));
}

/** Claude keeps each project's sessions under its cwd with every character outside [A-Za-z0-9] as a dash. */
export function claudeLogPath(home: string, cwd: string, sessionId: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
}

export function parseClaudeLog(content: string): LoggedTurn[] {
  const names = new Map<string, string>();
  const turns: LoggedTurn[] = [];
  for (const row of records(content)) {
    const uuid = text(row.uuid);
    const at = text(row.timestamp);
    if ((row.type !== "user" && row.type !== "assistant") || uuid === "" || at === "" || row.isSidechain === true || row.isMeta === true) continue;
    const message = object(row.message);
    const found: Omit<LoggedTurn, "sourceId" | "at">[] = [];
    if (row.type === "user") {
      if (typeof message.content === "string") found.push({ kind: "user", text: message.content });
      else {
        const typed = blocks(message.content).filter((block) => block.type === "text").map((block) => text(block.text)).join("");
        if (typed !== "") found.push({ kind: "user", text: typed });
        for (const block of blocks(message.content).filter((candidate) => candidate.type === "tool_result")) {
          found.push({ kind: "tool-result", text: flatten(block.content), tool: { name: names.get(text(block.tool_use_id)) ?? "tool", status: block.is_error === true ? "error" : "ok" } });
        }
      }
    } else {
      const messageId = text(message.id);
      const identity = messageId === "" ? {} : { messageId };
      for (const block of blocks(message.content)) {
        if (block.type === "thinking" && text(block.thinking) !== "") found.push({ kind: "thinking", text: text(block.thinking), ...identity });
        else if (block.type === "text" && text(block.text) !== "") found.push({ kind: "assistant", text: text(block.text), ...identity });
        else if (block.type === "tool_use") {
          names.set(text(block.id), text(block.name));
          found.push({ kind: "tool-call", text: text(block.name), tool: { name: text(block.name), input: JSON.stringify(block.input ?? {}) } });
        }
      }
    }
    turns.push(...identify(uuid, found, at));
  }
  return turns;
}

const CODEX_CONTEXT = ["# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<skills_instructions>", "<permissions"];

export function parseCodexRollout(content: string): LoggedTurn[] {
  const names = new Map<string, string>();
  const turns: LoggedTurn[] = [];
  records(content).forEach((row, index) => {
    const payload = object(row.payload);
    const at = text(row.timestamp);
    if (row.type !== "response_item" || at === "") return;
    const id = `codex:${typeof row.ordinal === "number" ? row.ordinal : index}`;
    const kind = text(payload.type);
    let found: Omit<LoggedTurn, "sourceId" | "at"> | undefined;
    if (kind === "message") {
      const value = blocks(payload.content).map((block) => text(block.text)).join("");
      if (payload.role === "assistant" && value !== "") found = { kind: "assistant", text: value };
      else if (payload.role === "user" && value !== "" && !CODEX_CONTEXT.some((prefix) => value.startsWith(prefix))) found = { kind: "user", text: value };
    } else if (kind === "reasoning") {
      const value = flatten(payload.summary);
      if (value !== "") found = { kind: "thinking", text: value };
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      names.set(text(payload.call_id), text(payload.name));
      found = { kind: "tool-call", text: text(payload.name), tool: { name: text(payload.name), input: text(payload.arguments ?? payload.input) } };
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      found = { kind: "tool-result", text: flatten(payload.output), tool: { name: names.get(text(payload.call_id)) ?? "tool", status: "ok" } };
    }
    if (found !== undefined) turns.push({ ...found, sourceId: id, at });
  });
  return turns;
}

async function codexRolloutPath(home: string, sessionId: string): Promise<string | null> {
  const root = join(home, ".codex", "sessions");
  try {
    const name = (await readdir(root, { recursive: true })).find((entry) => entry.endsWith(`-${sessionId}.jsonl`) && entry.split("/").at(-1)?.startsWith("rollout-"));
    return name === undefined ? null : join(root, name);
  } catch { return null; }
}

/** Every turn the agent's own log holds for this chat's session; a missing log is no turns. */
export async function readSessionTurns(chat: Pick<Chat, "agent" | "cwd" | "agentSessionId">, home: string): Promise<LoggedTurn[]> {
  if (chat.agentSessionId === null) return [];
  const path = chat.agent === "claude" ? claudeLogPath(home, chat.cwd, chat.agentSessionId) : await codexRolloutPath(home, chat.agentSessionId);
  if (path === null) return [];
  try { return (chat.agent === "claude" ? parseClaudeLog : parseCodexRollout)(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** The session a terminal TUI started on its own: the newest log in this chat's cwd written after `since`, or null. */
export async function discoverSessionId(chat: Pick<Chat, "agent" | "cwd">, home: string, since: string): Promise<string | null> {
  const after = Date.parse(since);
  const newest = async (root: string, accept: (name: string) => boolean): Promise<string[]> => {
    try {
      const found: { name: string; at: number }[] = [];
      for (const name of await readdir(root, { recursive: true })) {
        if (!accept(name)) continue;
        const at = (await stat(join(root, name))).mtimeMs;
        if (at > after) found.push({ name, at });
      }
      return found.sort((a, b) => b.at - a.at).map((item) => item.name);
    } catch { return []; }
  };
  if (chat.agent === "claude") {
    const root = join(home, ".claude", "projects", chat.cwd.replace(/[^A-Za-z0-9]/g, "-"));
    const [name] = await newest(root, (entry) => entry.endsWith(".jsonl") && !entry.includes("/"));
    return name === undefined ? null : name.slice(0, -".jsonl".length);
  }
  const root = join(home, ".codex", "sessions");
  for (const name of await newest(root, (entry) => entry.endsWith(".jsonl") && (entry.split("/").at(-1) ?? "").startsWith("rollout-"))) {
    try {
      const meta = object(object(JSON.parse((await readFile(join(root, name), "utf8")).split("\n")[0] ?? "")).payload);
      if (text(meta.cwd) === chat.cwd && text(meta.id) !== "") return text(meta.id);
    } catch { /* unreadable log: try the next */ }
  }
  return null;
}
