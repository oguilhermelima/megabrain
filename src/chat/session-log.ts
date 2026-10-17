import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { readProcessTable } from "../core/session-origin.js";
import type { Chat, ChatEvent } from "./store.js";
import { claudeHandBack, claudeSubagent, codexEnded, codexSpawned, isClaudeSubagentTool, type SubagentEnd } from "./subagents.js";

/** One conversation entry read from an agent's own session log; `sourceId` is stable across reads, so an import can skip what it already holds. */
export type LoggedTurn = Pick<ChatEvent, "kind" | "text" | "tool" | "messageId" | "parentId" | "subagent"> & { sourceId: string; at: string };

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

function endTurn(end: SubagentEnd, name: string): Omit<LoggedTurn, "sourceId" | "at"> {
  return { kind: "tool-result", text: end.text, tool: { name, status: end.status === "completed" ? "ok" : "error" }, subagent: { id: end.id, status: end.status } };
}

/**
 * The turns of a Claude session log. Given `parentId`, the log is a subagent's own (subagents/agent-<id>.jsonl):
 * its turns carry that id and the prompt it was given is left out.
 */
export function parseClaudeLog(content: string, parentId?: string): LoggedTurn[] {
  const names = new Map<string, string>();
  const turns: LoggedTurn[] = [];
  const parent = parentId === undefined ? {} : { parentId };
  for (const row of records(content)) {
    const uuid = text(row.uuid);
    const at = text(row.timestamp);
    if ((row.type !== "user" && row.type !== "assistant") || uuid === "" || at === "" || (row.isSidechain === true && parentId === undefined) || row.isMeta === true) continue;
    const message = object(row.message);
    const found: Omit<LoggedTurn, "sourceId" | "at">[] = [];
    if (row.type === "user") {
      if (typeof message.content === "string") { if (parentId === undefined) found.push({ kind: "user", text: message.content }); }
      else {
        const typed = blocks(message.content).filter((block) => block.type === "text").map((block) => text(block.text)).join("");
        if (typed !== "" && parentId === undefined) found.push({ kind: "user", text: typed });
        for (const block of blocks(message.content).filter((candidate) => candidate.type === "tool_result")) {
          const name = names.get(text(block.tool_use_id)) ?? "tool";
          if (parentId === undefined && isClaudeSubagentTool(name)) {
            const end = claudeHandBack(text(block.tool_use_id), block, row.toolUseResult);
            if (end !== null) found.push(endTurn(end, name));
            continue;
          }
          found.push({ kind: "tool-result", text: flatten(block.content), tool: { name, status: block.is_error === true ? "error" : "ok" }, ...parent });
        }
      }
    } else {
      const messageId = text(message.id);
      const identity = { ...(messageId === "" ? {} : { messageId }), ...parent };
      for (const block of blocks(message.content)) {
        if (block.type === "thinking" && text(block.thinking) !== "") found.push({ kind: "thinking", text: text(block.thinking), ...identity });
        else if (block.type === "text" && text(block.text) !== "") found.push({ kind: "assistant", text: text(block.text), ...identity });
        else if (block.type === "tool_use") {
          const name = text(block.name);
          names.set(text(block.id), name);
          const call = { kind: "tool-call" as const, text: name, tool: { name, input: JSON.stringify(block.input ?? {}) } };
          found.push(parentId === undefined && isClaudeSubagentTool(name) ? { ...call, subagent: claudeSubagent(text(block.id), block.input) } : { ...call, ...parent });
        }
      }
    }
    turns.push(...identify(uuid, found, at));
  }
  return turns;
}

/** A background subagent's end as its own log tells it: its final message, which becomes its result; null while it has none. */
function claudeSubagentEnd(content: string, id: string): LoggedTurn | null {
  const last = records(content).filter((row) => row.type === "user" || row.type === "assistant").at(-1);
  const message = object(last?.message);
  const stop = text(message.stop_reason);
  if (last === undefined || last.type !== "assistant" || stop === "" || stop === "tool_use") return null;
  const report = blocks(message.content).filter((block) => block.type === "text").map((block) => text(block.text)).join("");
  return { ...endTurn({ id, status: "completed", text: report }, "Agent"), sourceId: `${id}:end`, at: text(last.timestamp) };
}

/** Claude keeps each subagent's log beside the session's, under <session>/subagents, named by its Agent call in a .meta.json. */
async function claudeSubagentTurns(path: string, main: LoggedTurn[]): Promise<LoggedTurn[]> {
  const directory = join(dirname(path), basename(path, ".jsonl"), "subagents");
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const started = new Set(main.flatMap((turn) => turn.kind === "tool-call" && turn.subagent !== undefined ? [turn.subagent.id] : []));
  const ended = new Set(main.flatMap((turn) => turn.kind === "tool-result" && turn.subagent !== undefined ? [turn.subagent.id] : []));
  const turns: LoggedTurn[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".meta.json")).sort()) {
    try {
      const id = text(object(JSON.parse(await readFile(join(directory, name), "utf8"))).toolUseId);
      if (!started.has(id)) continue;
      const content = await readFile(join(directory, name.replace(/\.meta\.json$/, ".jsonl")), "utf8");
      turns.push(...parseClaudeLog(content, id));
      const end = ended.has(id) ? null : claudeSubagentEnd(content, id);
      if (end !== null) turns.push(end);
    } catch { /* a subagent log being written or gone: its steps are not shown */ }
  }
  return turns;
}

const CODEX_CONTEXT = ["# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<skills_instructions>", "<permissions"];

/**
 * The turns of a Codex rollout. Given `parentId`, the rollout is a spawned thread's: its turns carry that id,
 * the parent's history it was forked with is left out (it runs under turn contexts whose turn is the root
 * turn), and so are the messages it was sent.
 */
export function parseCodexRollout(content: string, parentId?: string): LoggedTurn[] {
  const names = new Map<string, string>();
  const turns: LoggedTurn[] = [];
  const parent = parentId === undefined ? {} : { parentId };
  const rows = records(content);
  const own = parentId === undefined ? 0 : Math.max(0, rows.findIndex((row) => {
    const context = object(row.payload);
    return row.type === "turn_context" && typeof context.root_turn_id === "string" && context.turn_id !== context.root_turn_id;
  }));
  const spawns = new Map<string, string>();
  const ended = new Set<string>();
  rows.forEach((row, index) => {
    const payload = object(row.payload);
    const at = text(row.timestamp);
    const id = `codex:${typeof row.ordinal === "number" ? row.ordinal : index}`;
    if (index < own || at === "") return;
    if (row.type === "event_msg" && payload.type === "item_completed" && parentId === undefined) {
      const item = object(payload.item);
      for (const subagent of codexSpawned(item)) {
        if (spawns.has(subagent.id)) continue;
        spawns.set(subagent.id, text(item.tool));
        turns.push({ kind: "tool-call", text: text(item.tool), tool: { name: text(item.tool), input: text(item.prompt) }, subagent, sourceId: `${id}:start:${subagent.id}`, at });
      }
      for (const end of codexEnded(item)) {
        const name = spawns.get(end.id);
        if (name === undefined || ended.has(end.id)) continue;
        ended.add(end.id);
        turns.push({ ...endTurn(end, name), sourceId: `${id}:end:${end.id}`, at });
      }
      return;
    }
    if (row.type !== "response_item") return;
    const kind = text(payload.type);
    let found: Omit<LoggedTurn, "sourceId" | "at"> | undefined;
    if (kind === "message") {
      const value = blocks(payload.content).map((block) => text(block.text)).join("");
      if (payload.role === "assistant" && value !== "") found = { kind: "assistant", text: value };
      else if (payload.role === "user" && parentId === undefined && value !== "" && !CODEX_CONTEXT.some((prefix) => value.startsWith(prefix))) found = { kind: "user", text: value };
    } else if (kind === "reasoning") {
      const value = flatten(payload.summary);
      if (value !== "") found = { kind: "thinking", text: value };
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      names.set(text(payload.call_id), text(payload.name));
      found = { kind: "tool-call", text: text(payload.name), tool: { name: text(payload.name), input: text(payload.arguments ?? payload.input) } };
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      found = { kind: "tool-result", text: flatten(payload.output), tool: { name: names.get(text(payload.call_id)) ?? "tool", status: "ok" } };
    }
    if (found !== undefined) turns.push({ ...found, ...parent, sourceId: id, at });
  });
  return turns;
}

/** Each spawned thread's own rollout, found by its id, under the spawn. */
async function codexSubagentTurns(home: string, main: LoggedTurn[]): Promise<LoggedTurn[]> {
  const turns: LoggedTurn[] = [];
  for (const turn of main) {
    if (turn.kind !== "tool-call" || turn.subagent === undefined) continue;
    const path = await codexRolloutPath(home, turn.subagent.id);
    if (path === null) continue;
    try { turns.push(...parseCodexRollout(await readFile(path, "utf8"), turn.subagent.id).map((step) => ({ ...step, sourceId: `${turn.subagent?.id}:${step.sourceId}` }))); }
    catch { /* a rollout being written or gone: its steps are not shown */ }
  }
  return turns;
}

/**
 * The main log's turns with every subagent's steps, in time order. A subagent the logs never saw end
 * is stopped: the terminal that ran it is gone by the time its turns are read back.
 */
function withSubagents(main: LoggedTurn[], steps: LoggedTurn[]): LoggedTurn[] {
  const turns = [...main, ...steps].sort((left, right) => left.at < right.at ? -1 : left.at > right.at ? 1 : 0);
  const ended = new Set(turns.flatMap((turn) => turn.kind === "tool-result" && turn.subagent !== undefined ? [turn.subagent.id] : []));
  for (const start of main) {
    if (start.kind !== "tool-call" || start.subagent === undefined || ended.has(start.subagent.id)) continue;
    const id = start.subagent.id;
    const last = turns.filter((turn) => turn.parentId === id).at(-1) ?? start;
    turns.splice(turns.indexOf(last) + 1, 0, { ...endTurn({ id, status: "stopped", text: "" }, start.tool?.name ?? "Agent"), sourceId: `${id}:end`, at: last.at });
  }
  return turns;
}

async function codexRolloutPath(home: string, sessionId: string): Promise<string | null> {
  const root = join(home, ".codex", "sessions");
  try {
    const name = (await readdir(root, { recursive: true })).find((entry) => entry.endsWith(`-${sessionId}.jsonl`) && entry.split("/").at(-1)?.startsWith("rollout-"));
    return name === undefined ? null : join(root, name);
  } catch { return null; }
}

/** Where the agent keeps this chat's session log; null without a session or a rollout. */
export async function sessionLogPath(chat: Pick<Chat, "agent" | "cwd" | "agentSessionId">, home: string): Promise<string | null> {
  if (chat.agentSessionId === null) return null;
  return chat.agent === "claude" ? claudeLogPath(home, chat.cwd, chat.agentSessionId) : await codexRolloutPath(home, chat.agentSessionId);
}

const CLAUDE_INTERRUPTED = "[Request interrupted by user";
const LOCAL_COMMAND = /^<(?:command-name|command-message|local-command-[a-z]+)>/;

/**
 * Whether the log ends inside a turn: a prompt the agent has not finished answering. Claude ends a turn with an
 * assistant message that stops for any reason but a tool call, a turn_duration line, or an interruption note;
 * Codex brackets each turn with task_started and task_complete or turn_aborted.
 */
export function sessionTurnOpen(agent: Chat["agent"], content: string): boolean {
  let open = false;
  for (const row of records(content)) {
    if (agent === "codex") {
      const kind = text(object(row.payload).type);
      if (row.type === "event_msg" && (kind === "task_started" || kind === "turn_started")) open = true;
      else if (row.type === "event_msg" && (kind === "task_complete" || kind === "turn_complete" || kind === "turn_aborted")) open = false;
      continue;
    }
    if (row.isSidechain === true || row.isMeta === true) continue;
    const message = object(row.message);
    if (row.type === "system" && row.subtype === "turn_duration") open = false;
    else if (row.type === "assistant") {
      const stop = text(message.stop_reason);
      if (stop !== "" && stop !== "tool_use") open = false;
    } else if (row.type === "user") {
      const typed = typeof message.content === "string" ? message.content : blocks(message.content).filter((block) => block.type === "text").map((block) => text(block.text)).join("");
      // A slash command the TUI ran itself is no prompt: nothing answers it.
      if (typed.startsWith(CLAUDE_INTERRUPTED)) open = false;
      else if (typed !== "" && !LOCAL_COMMAND.test(typed)) open = true;
    }
  }
  return open;
}

/** Every turn the agent's own log holds for this chat's session; a missing log is no turns. */
export async function readSessionTurns(chat: Pick<Chat, "agent" | "cwd" | "agentSessionId">, home: string): Promise<LoggedTurn[]> {
  const path = await sessionLogPath(chat, home);
  if (path === null) return [];
  let main: LoggedTurn[];
  try { main = (chat.agent === "claude" ? parseClaudeLog : parseCodexRollout)(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!main.some((turn) => turn.subagent !== undefined)) return main;
  return withSubagents(main, chat.agent === "claude" ? await claudeSubagentTurns(path, main) : await codexSubagentTurns(home, main));
}

/**
 * The session a terminal TUI started on its own, proved by process ancestry: the agent whose process descends from
 * one of the chat's own pane processes. A log merely being the newest in the folder proves nothing (another agent
 * may write there), so with no pane there is no answer.
 */
export async function discoverSessionId(chat: Pick<Chat, "agent" | "cwd">, home: string, panePids: readonly number[], processAdapter: ProcessAdapter): Promise<string | null> {
  if (panePids.length === 0) return null;
  const table = await readProcessTable(processAdapter);
  const inPane = (pid: number): boolean => {
    const seen = new Set<number>();
    for (let current: number | undefined = pid; current !== undefined && current > 1 && !seen.has(current); current = table.get(current)?.ppid) {
      if (panePids.includes(current)) return true;
      seen.add(current);
    }
    return false;
  };
  if (chat.agent === "claude") {
    const directory = join(home, ".claude", "sessions");
    let names: string[];
    try { names = await readdir(directory); } catch { return null; }
    for (const name of names.filter((entry) => /^\d+\.json$/.test(entry))) {
      try {
        const entry = object(JSON.parse(await readFile(join(directory, name), "utf8")));
        const pid = Number(name.slice(0, -".json".length));
        if (entry.pid === pid && text(entry.cwd) === chat.cwd && text(entry.sessionId) !== "" && table.has(pid) && inPane(pid)) return text(entry.sessionId);
      } catch { /* unreadable registry entry: try the next */ }
    }
    return null;
  }
  const codexPids = [...table].filter(([pid, entry]) => /(?:^|\/)codex(?:\s|$)/.test(entry.command) && inPane(pid)).map(([pid]) => String(pid));
  if (codexPids.length === 0) return null;
  const open = await processAdapter.run("lsof", ["-p", codexPids.join(","), "-Fn"]);
  if (open.kind !== "ok") return null;
  for (const line of open.value.stdout.split("\n")) {
    const match = /^n.*\/rollout-[^/]*?-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}
