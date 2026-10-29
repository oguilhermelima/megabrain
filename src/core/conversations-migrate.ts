import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Chat } from "../chat/store.js";
import { OWNED_TMUX_SERVER } from "./session-ownership.js";
import { APP_SESSION_PREFIX } from "./app-terminals.js";
import { chatKey, readConversations, sessionKey, terminalKey, type Conversation, type ConversationRegistry } from "./conversations.js";

// The one-time import of today's files. They stay on disk untouched; the registry records that it read them.

export type MigrationOptions = Readonly<{ isTmuxAlive: (session: string) => boolean }>;

const NO_ALIASES = { chatId: null, tmux: null, pid: null, dispatchId: null } as const;

export function tmuxSessionAlive(session: string): boolean {
  const result = spawnSync("tmux", ["-L", OWNED_TMUX_SERVER, "has-session", "-t", `=${session}`], { stdio: "ignore" });
  return result.status === 0;
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function hasUserEvent(file: string): boolean {
  try { return readFileSync(file, "utf8").split("\n").some((line) => line.includes('"kind":"user"') && (JSON.parse(line) as { event?: { kind?: string } }).event?.kind === "user"); }
  catch { return false; }
}

function readChats(stateDir: string): Chat[] {
  const root = join(stateDir, "chats");
  let ids: string[];
  try { ids = readdirSync(root); } catch { return []; }
  return ids.flatMap((id) => {
    const value = readJson(join(root, id, "chat.json"));
    return isRecord(value) && str(value.id) !== undefined && str(value.cwd) !== undefined && (value.agent === "claude" || value.agent === "codex") ? [value as unknown as Chat] : [];
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function resumedSession(command: string): { agent: "claude" | "codex"; id: string } | undefined {
  const claude = /(?:^|\s)claude\b.*?--resume\s+(\S+)/.exec(command)?.[1];
  if (claude !== undefined) return { agent: "claude", id: claude };
  const codex = /(?:^|\s)codex\s+resume\s+(\S+)/.exec(command)?.[1];
  return codex === undefined ? undefined : { agent: "codex", id: codex };
}

function sameLegacyTerminal(chat: Chat, command: string, cwd: string): boolean {
  if (chat.cwd !== cwd) return false;
  const resumed = resumedSession(command);
  if (resumed !== undefined) return resumed.agent === chat.agent && resumed.id === chat.agentSessionId;
  const executable = command.trim().split(/\s+/, 1)[0]?.split(/[\\/]/).at(-1);
  return chat.agentSessionId === null && executable === chat.agent;
}

// The registry as the legacy files describe it, merged under what is already stored.
export function migrated(stateDir: string, registry: ConversationRegistry, options: MigrationOptions = { isTmuxAlive: tmuxSessionAlive }): ConversationRegistry {
  const conversations: Record<string, Conversation> = { ...registry.conversations };
  const sources: string[] = [];
  const add = (key: string, entry: Conversation): void => { if (conversations[key] === undefined) conversations[key] = entry; };
  const addAlias = (key: string, tmux: string): void => {
    const existing = conversations[key];
    if (existing !== undefined && existing.aliases.tmux === null) conversations[key] = { ...existing, aliases: { ...existing.aliases, tmux } };
  };

  const chats = readChats(stateDir);
  if (existsSync(join(stateDir, "chats"))) sources.push("chats");
  const chatKeys = new Map<string, string>();
  const unused = new Set<string>();
  const hosted = new Set<string>();
  for (const chat of chats) {
    const key = chat.agentSessionId === null || chat.agentSessionId === undefined ? chatKey(chat.id) : sessionKey(chat.agent, chat.agentSessionId);
    const empty = key.startsWith("chat:") && chat.title === null && !hasUserEvent(join(stateDir, "chats", chat.id, "events.jsonl"));
    add(key, { owner: "app-chat", cwd: chat.cwd, aliases: { ...NO_ALIASES, chatId: chat.id }, createdAt: chat.createdAt, hidden: false });
    if (empty) unused.add(chat.id);
    chatKeys.set(chat.id, key);
  }

  const terminals = readJson(join(stateDir, "app-terminals.json"));
  if (isRecord(terminals)) {
    sources.push("app-terminals.json");
    for (const [name, value] of Object.entries(terminals)) {
      if (!name.startsWith(APP_SESSION_PREFIX) || !isRecord(value)) continue;
      const command = (str(value.command) ?? "").trim();
      const cwd = str(value.cwd) ?? "";
      const tmux = `${OWNED_TMUX_SERVER}:${name}`;
      const alive = options.isTmuxAlive(name);
      const host = chats.find((chat) => chat.mode === "terminal" && sameLegacyTerminal(chat, command, cwd));
      if (host !== undefined) {
        addAlias(chatKeys.get(host.id) ?? chatKey(host.id), tmux);
        if (alive) hosted.add(host.id);
        continue;
      }
      const createdAt = str(value.createdAt) ?? new Date(0).toISOString();
      const resumed = resumedSession(command);
      const key = alive ? terminalKey(name.slice(APP_SESSION_PREFIX.length)) : resumed === undefined ? undefined : sessionKey(resumed.agent, resumed.id);
      if (key === undefined) continue;
      add(key, { owner: "app-terminal", cwd, aliases: { ...NO_ALIASES, tmux }, createdAt, hidden: false });
      addAlias(key, tmux);
    }
  }

  // A chat that never had a turn is a placeholder, gone with its agent.
  const running = new Set(["starting", "idle", "working", "waiting-approval"]);
  for (const chat of chats) {
    if (!unused.has(chat.id)) continue;
    if (chat.mode === "terminal" && hosted.has(chat.id)) continue;
    const key = chatKeys.get(chat.id);
    if (key !== undefined) delete conversations[key];
    // A running empty chat belongs to chatd, which collects it on its next start.
    if (chat.mode === "chat" && running.has(chat.state)) continue;
    rmSync(join(stateDir, "chats", chat.id), { recursive: true, force: true });
  }

  const owned = readJson(join(stateDir, "owned-sessions.json"));
  if (isRecord(owned)) {
    sources.push("owned-sessions.json");
    for (const [key, value] of Object.entries(owned)) {
      const session = isRecord(value) ? str(value.tmuxSession) : undefined;
      if (!isRecord(value) || session === undefined || !options.isTmuxAlive(session)) continue;
      const tmux = `${str(value.tmuxServer) ?? OWNED_TMUX_SERVER}:${session}`;
      add(key, { owner: "app-terminal", cwd: str(value.cwd) ?? "", aliases: { ...NO_ALIASES, tmux }, createdAt: str(value.ownedAt) ?? new Date(0).toISOString(), hidden: false });
      addAlias(key, tmux);
    }
  }

  const hiddenKeys = new Set(registry.hiddenKeys);
  const hidden = readJson(join(stateDir, "hidden-sessions.json"));
  if (isRecord(hidden) && isRecord(hidden.sessions)) {
    sources.push("hidden-sessions.json");
    for (const key of Object.keys(hidden.sessions)) {
      const entry = conversations[key];
      if (entry === undefined) hiddenKeys.add(key);
      else conversations[key] = { ...entry, hidden: true };
    }
  }
  return { version: 1, conversations, hiddenKeys: [...hiddenKeys], migratedFrom: sources };
}

// Runs the migration now if it has not run; the result is the stored registry.
export function migrateConversations(stateDir: string, options?: MigrationOptions): ConversationRegistry {
  return readConversations(stateDir, options);
}
