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
  /** `suspended`: no agent process, but the record keeps `agentSessionId`; the next send resumes it. `stopped` is only read from records written before that state existed. */
  state: "starting" | "idle" | "working" | "waiting-approval" | "suspended" | "stopped" | "error";
  mode: "chat" | "terminal";
  agentSessionId: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  error?: string | null;
  /** When the chat last moved to its terminal: the agent's own log is imported from here on the way back. */
  terminalSince?: string;
};

export type ChatApproval = { id: string; tool: string; input: string; reason: string | null; decisions: Array<"allow" | "allow-session" | "deny"> };
/** `state` is stored; `delta` is a chunk of the message `messageId` and goes to followers only. */
export type ChatEvent = { id: string; at: string; kind: "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "system" | "approval" | "state" | "summary" | "delta"; text: string; messageId?: string; /** The agent log entry this event was imported from. */ sourceId?: string; stream?: "assistant" | "thinking"; turnStartedAt?: string; /** On a user event: the images it carried, as local files (never their bytes). */ images?: { path: string }[]; /** On a user event with images: its text and images in the order they were sent. */ parts?: ({ type: "text"; text: string } | { type: "image"; path: string })[]; tool?: { name: string; input?: string; status?: "ok" | "error" };
  /** On a step a subagent took (its thinking, text, tool calls and results): the id of that subagent. */
  parentId?: string;
  /** On the tool call that starts a subagent (no status) and on the tool result that ends it (status set, text its result). */
  subagent?: { id: string; type?: string; description?: string; status?: "completed" | "failed" | "stopped" } };
/** A message sent while a turn ran, waiting to go out as a later turn; its parts keep text and images in order. */
export type QueuedChatMessage = { id: string; parts: ({ type: "text"; text: string } | { type: "image"; path: string })[]; createdAt: string; updatedAt: string };
/** `queue` is the chat's whole queue, on the first line of every read and live after each change. */
export type ChatLine = { cursor: string; chat?: Chat; event?: ChatEvent; approval?: ChatApproval; queue?: QueuedChatMessage[] };

function safeId(id: string): boolean { return /^[a-f\d-]{36}$/i.test(id); }

export class ChatStore {
  readonly chatsDir: string;
  private readonly counts = new Map<string, number>();
  constructor(readonly stateDir: string) { this.chatsDir = join(stateDir, "chats"); }

  async initialize(): Promise<void> { await mkdir(this.chatsDir, { recursive: true, mode: 0o700 }); await chmod(this.chatsDir, 0o700); }
  dir(id: string): string { if (!safeId(id)) throw new Error("invalid chat id"); return join(this.chatsDir, id); }
  private recordPath(id: string): string { return join(this.dir(id), "chat.json"); }
  private eventsPath(id: string): string { return join(this.dir(id), "events.jsonl"); }
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
    this.counts.set(id, count + 1);
    return line;
  }

  /** Drops what is cached for a chat whose files were deleted. */
  forget(id: string): void { this.counts.delete(id); }

  async events(id: string, since = 0): Promise<ChatLine[]> {
    let content: string;
    try { content = await readFile(this.eventsPath(id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChatLine).filter((line) => Number(line.cursor) > since);
  }
}
