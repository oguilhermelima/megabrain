import { chmod, mkdir, readFile, appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type Chat = {
  id: string;
  agent: "claude" | "codex";
  model: string | null;
  effort?: string | null;
  contextTokens?: number;
  contextWindow?: number;
  usageTokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** The slash command names the agent reported at init (Claude's system/init), for the composer's menu. */
  slashCommands?: string[];
  cwd: string;
  /** Ask for approvals instead of bypassing permission prompts. */
  approvals?: boolean;
  title: string | null;
  /** Who set the title: the person by hand (never replaced), the chat summary, or the first message. Records from before this existed read as first-message. */
  titleSource?: "person" | "summary" | "first-message";
  /** The latest summary of the chat; the history is in its summaries.jsonl. */
  summary?: { text: string; updatedAt: string; model: string } | null;
  /** Readable history supplied to a fresh Claude session when its CLI cannot resume at a past turn. */
  seedContext?: string;
  /** `suspended`: no agent process, but the record keeps `agentSessionId`; the next send resumes it. `stopped` is only read from records written before that state existed. */
  state: "starting" | "idle" | "working" | "waiting-approval" | "suspended" | "stopped" | "error";
  mode: "chat" | "terminal";
  /** The single process currently allowed to write this session; the selected view is `mode`. */
  owner?: "chat" | "terminal" | "none";
  /** Last complete byte read from the agent's session log while its TUI owned the conversation. */
  terminalLogCursor?: { byteOffset: number; lastMessageId: string | null };
  agentSessionId: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  error?: string | null;
  /** When the chat last moved to its terminal: the agent's own log is imported from here on the way back. */
  terminalSince?: string;
};

export type ChatApproval = { id: string; tool: string; input: string; reason: string | null; decisions: Array<"allow" | "allow-session" | "deny"> };
/** What a running turn reports besides its messages: its output tokens so far, a retry the agent waits on, or what it is doing. */
export type ChatProgress = { tokens?: number; retry?: { attempt?: number; maxAttempts?: number; delayMs?: number; reason?: string }; status?: string };
/** `state` is stored; `delta` is a chunk of the message `messageId` and `progress` carries a ChatProgress, both for followers only. */
export type BackgroundTask = { id: string; kind: "shell" | "monitor" | "agent" | "other"; label: string; state: "running" | "completed" | "failed" | "killed" | "lost"; startedAt: string; endedAt?: string; summary?: string; exitCode?: number };
export type ChatEvent = { id: string; at: string; kind: "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "system" | "approval" | "state" | "summary" | "delta" | "progress" | "artifacts" | "turn-cut" | "background-task" | "command-output" | "rewind"; text: string; agent?: "claude" | "codex" | "grok" | "agy"; source?: "megabrain"; data?: import("./info-command-data.js").InfoCommandData; fromEventId?: string; reason?: "interrupted" | "process-exited" | "error" | "limit" | "unknown"; detail?: string; partial?: boolean; backgroundTask?: BackgroundTask; messageId?: string; /** Agent's durable turn id, used for native fork and rewind operations. */ turnId?: string; /** The agent log entry this event was imported from. */ sourceId?: string; stream?: "assistant" | "thinking"; turnStartedAt?: string; /** On a user event: the images it carried, as local files (never their bytes). */ images?: { path: string }[]; /** On a user event with images: its text and images in the order they were sent. */ parts?: ({ type: "text"; text: string } | { type: "image"; path: string })[]; tool?: { name: string; input?: string; status?: "ok" | "error" };
  /** On a step a subagent took (its thinking, text, tool calls and results): the id of that subagent. */
  parentId?: string;
  /** On the tool call that starts a subagent (no status) and on the tool result that ends it (status set, text its result). */
  subagent?: { id: string; type?: string; description?: string; status?: "completed" | "failed" | "stopped" };
  progress?: ChatProgress;
  /** On an assistant event that is a local command's output (Claude's /usage, /cost): the command it answers, slash included. */
  command?: string };
/** A message sent while a turn ran, waiting to go out as a later turn; its parts keep text and images in order. */
export type QueuedChatMessage = { id: string; parts: ({ type: "text"; text: string } | { type: "image"; path: string })[]; createdAt: string; updatedAt: string };
/** `queue` is the chat's whole queue, on the first line of every read and live after each change. */
export type ChatLine = { cursor: string; chat?: Chat; event?: ChatEvent; approval?: ChatApproval; queue?: QueuedChatMessage[] };

function safeId(id: string): boolean { return /^[a-f\d-]{36}$/i.test(id); }

export class ChatStore {
  readonly chatsDir: string;
  private readonly counts = new Map<string, number>();
  private readonly turnIds = new Map<string, Map<string, string>>();
  private readonly lastUsers = new Map<string, string>();
  constructor(readonly stateDir: string) { this.chatsDir = join(stateDir, "chats"); }

  async initialize(): Promise<void> { await mkdir(this.chatsDir, { recursive: true, mode: 0o700 }); await chmod(this.chatsDir, 0o700); }
  dir(id: string): string { if (!safeId(id)) throw new Error("invalid chat id"); return join(this.chatsDir, id); }
  private recordPath(id: string): string { return join(this.dir(id), "chat.json"); }
  private eventsPath(id: string): string { return join(this.dir(id), "events.jsonl"); }
  private turnIdsPath(id: string): string { return join(this.dir(id), "turn-ids.jsonl"); }
  private queuePath(id: string): string { return join(this.dir(id), "queue.json"); }

  async list(): Promise<Chat[]> {
    await this.initialize();
    const { readdir } = await import("node:fs/promises");
    const chats: Chat[] = [];
    for (const id of await readdir(this.chatsDir)) {
      if (!safeId(id)) continue;
      const chat = await this.get(id);
      if (chat !== null) chats.push(chat);
    }
    return chats.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<Chat | null> {
    try { return JSON.parse(await readFile(this.recordPath(id), "utf8")) as Chat; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async put(chat: Chat): Promise<void> {
    const dir = this.dir(chat.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const target = this.recordPath(chat.id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(chat)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async queue(id: string): Promise<QueuedChatMessage[]> {
    try { return JSON.parse(await readFile(this.queuePath(id), "utf8")) as QueuedChatMessage[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  async putQueue(id: string, items: readonly QueuedChatMessage[]): Promise<void> {
    const target = this.queuePath(id);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(items)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async append(id: string, event: ChatEvent, approval?: ChatApproval): Promise<ChatLine> {
    const file = this.eventsPath(id);
    // chatd is the only writer, so the count read once stays true; rereading the whole file per append made a long chat's switch cost seconds.
    const count = this.counts.get(id) ?? (await this.events(id)).length;
    const line: ChatLine = { cursor: String(count + 1), event, ...(approval ? { approval } : {}) };
    await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    if (event.kind === "user") this.lastUsers.set(id, event.id);
    if (event.kind === "user" && event.turnId !== undefined) await this.recordTurnId(id, event.id, event.turnId);
    this.counts.set(id, count + 1);
    return line;
  }

  /** Atomically replaces the visible event history after a native rewind or fork. */
  async replaceEvents(id: string, lines: readonly ChatLine[]): Promise<void> {
    const file = this.eventsPath(id);
    const normalized = lines.map((line, index) => ({ ...line, cursor: String(index + 1) }));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, normalized.map((line) => JSON.stringify(line)).join("\n") + (normalized.length ? "\n" : ""), { mode: 0o600 });
    await rename(temporary, file);
    this.counts.set(id, normalized.length);
    const lastUser = normalized.flatMap((line) => line.event?.kind === "user" ? [line.event.id] : []).at(-1);
    if (lastUser === undefined) this.lastUsers.delete(id); else this.lastUsers.set(id, lastUser);
    await this.replaceTurnIds(id, normalized);
  }

  /** Attach the app-server turn id to the most recent person event without changing cursors. */
  async annotateLastUserTurn(id: string, turnId: string): Promise<void> {
    const eventId = this.lastUsers.get(id) ?? (await this.events(id)).flatMap((line) => line.event?.kind === "user" ? [line.event.id] : []).at(-1);
    if (eventId !== undefined) await this.recordTurnId(id, eventId, turnId);
  }

  private async turnIdMap(id: string): Promise<Map<string, string>> {
    const cached = this.turnIds.get(id);
    if (cached) return cached;
    const map = new Map<string, string>();
    try {
      const content = await readFile(this.turnIdsPath(id), "utf8");
      for (const row of content.split("\n").filter(Boolean)) {
        const value = JSON.parse(row) as { eventId?: unknown; turnId?: unknown };
        if (typeof value.eventId === "string" && typeof value.turnId === "string") map.set(value.eventId, value.turnId);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.turnIds.set(id, map);
    return map;
  }

  private async recordTurnId(id: string, eventId: string, turnId: string): Promise<void> {
    const map = await this.turnIdMap(id);
    if (map.has(eventId)) return;
    await appendFile(this.turnIdsPath(id), `${JSON.stringify({ eventId, turnId })}\n`, { mode: 0o600 });
    map.set(eventId, turnId);
  }

  private async replaceTurnIds(id: string, lines: readonly ChatLine[]): Promise<void> {
    const file = this.turnIdsPath(id);
    const records = lines.flatMap((line) => line.event?.kind === "user" && line.event.turnId ? [{ eventId: line.event.id, turnId: line.event.turnId }] : []);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 });
    await rename(temporary, file);
    this.turnIds.set(id, new Map(records.map((record) => [record.eventId, record.turnId])));
  }

  /** Drops what is cached for a chat whose files were deleted. */
  forget(id: string): void { this.counts.delete(id); this.turnIds.delete(id); this.lastUsers.delete(id); }

  async events(id: string, since = 0): Promise<ChatLine[]> {
    let content: string;
    try { content = await readFile(this.eventsPath(id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const turnIds = await this.turnIdMap(id);
    return content.split("\n").filter(Boolean).map((line) => {
      const saved = JSON.parse(line) as ChatLine;
      if (saved.event?.kind === "user") this.lastUsers.set(id, saved.event.id);
      const turnId = saved.event?.kind === "user" ? turnIds.get(saved.event.id) : undefined;
      return turnId === undefined || saved.event === undefined || saved.event.turnId !== undefined ? saved : { ...saved, event: { ...saved.event, turnId } };
    }).filter((line) => Number(line.cursor) > since);
  }
}
