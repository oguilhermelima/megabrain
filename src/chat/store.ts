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
  cwd: string;
  /** Ask for approvals instead of bypassing permission prompts. */
  approvals?: boolean;
  title: string | null;
  /** `suspended`: no agent process, but the record keeps `agentSessionId`; the next send resumes it. `stopped` is only read from records written before that state existed. */
  state: "starting" | "idle" | "working" | "waiting-approval" | "suspended" | "stopped" | "error";
  mode: "chat" | "terminal";
  agentSessionId: string | null;
  createdAt: string;
  lastActivityAt: string | null;
  error?: string | null;
};

export type ChatApproval = { id: string; tool: string; input: string; reason: string | null; decisions: Array<"allow" | "allow-session" | "deny"> };
/** `state` is stored; `delta` is a chunk of the message `messageId` and goes to followers only. */
export type ChatEvent = { id: string; at: string; kind: "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "system" | "approval" | "state" | "delta"; text: string; messageId?: string; stream?: "assistant" | "thinking"; turnStartedAt?: string; tool?: { name: string; input?: string; status?: "ok" | "error" } };
export type ChatLine = { cursor: string; chat?: Chat; event?: ChatEvent; approval?: ChatApproval };

function safeId(id: string): boolean { return /^[a-f\d-]{36}$/i.test(id); }

export class ChatStore {
  readonly chatsDir: string;
  constructor(readonly stateDir: string) { this.chatsDir = join(stateDir, "chats"); }

  async initialize(): Promise<void> { await mkdir(this.chatsDir, { recursive: true, mode: 0o700 }); await chmod(this.chatsDir, 0o700); }
  dir(id: string): string { if (!safeId(id)) throw new Error("invalid chat id"); return join(this.chatsDir, id); }
  private recordPath(id: string): string { return join(this.dir(id), "chat.json"); }
  private eventsPath(id: string): string { return join(this.dir(id), "events.jsonl"); }

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

  async append(id: string, event: ChatEvent, approval?: ChatApproval): Promise<ChatLine> {
    const file = this.eventsPath(id);
    const events = await this.events(id);
    const line: ChatLine = { cursor: String(events.length + 1), event, ...(approval ? { approval } : {}) };
    await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return line;
  }

  async events(id: string, since = 0): Promise<ChatLine[]> {
    let content: string;
    try { content = await readFile(this.eventsPath(id), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ChatLine).filter((line) => Number(line.cursor) > since);
  }
}
