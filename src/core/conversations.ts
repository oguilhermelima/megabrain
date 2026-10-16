import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrated, type MigrationOptions } from "./conversations-migrate.js";

// One registry of the conversations megabrain itself created. Dispatch and foreign conversations are
// derived per listing and never stored; only what the app made and the person's hide choices live here.

export type ConversationOwner = "app-chat" | "app-terminal";
export type ConversationAliases = Readonly<{ chatId: string | null; tmux: string | null; pid: number | null; dispatchId: string | null }>;
export type Conversation = Readonly<{ owner: ConversationOwner; cwd: string; aliases: ConversationAliases; createdAt: string; hidden: boolean }>;
export type ConversationRegistry = Readonly<{
  version: 1;
  conversations: Readonly<Record<string, Conversation>>;
  // Keys of conversations that are not stored here (foreign ones) the person hid.
  hiddenKeys: readonly string[];
  // The legacy files the one-time migration read; absent until it ran.
  migratedFrom?: readonly string[];
}>;

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export const chatKey = (chatId: string): string => `chat:${chatId}`;
export const terminalKey = (terminalId: string): string => `terminal:${terminalId}`;
export const sessionKey = (agent: string, sessionId: string): string => `${agent}:${sessionId}`;

export function conversationsFile(stateDir: string): string {
  return join(stateDir, "conversations.json");
}

export function emptyRegistry(): ConversationRegistry {
  return { version: 1, conversations: {}, hiddenKeys: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type RawRead = Readonly<{ kind: "missing" | "invalid" | "ok"; registry: ConversationRegistry }>;

function readRaw(stateDir: string): RawRead {
  let raw: string;
  try { raw = readFileSync(conversationsFile(stateDir), "utf8"); }
  catch { return { kind: "missing", registry: emptyRegistry() }; }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.conversations)) return { kind: "invalid", registry: emptyRegistry() };
    const hiddenKeys = Array.isArray(value.hiddenKeys) ? value.hiddenKeys.filter((key): key is string => typeof key === "string") : [];
    const migratedFrom = Array.isArray(value.migratedFrom) ? value.migratedFrom.filter((name): name is string => typeof name === "string") : undefined;
    return { kind: "ok", registry: { version: 1, conversations: value.conversations as Record<string, Conversation>, hiddenKeys, ...(migratedFrom === undefined ? {} : { migratedFrom }) } };
  } catch { return { kind: "invalid", registry: emptyRegistry() }; }
}

// Missing, or stored before the legacy files were read. An unreadable or foreign-version file is left alone.
function needsMigration(read: RawRead): boolean {
  return read.kind === "missing" || (read.kind === "ok" && read.registry.migratedFrom === undefined);
}

// The first read runs the one-time migration from chats, app terminals, owned and hidden sessions.
export function readConversations(stateDir: string, options?: MigrationOptions): ConversationRegistry {
  const read = readRaw(stateDir);
  if (!needsMigration(read)) return read.registry;
  return updateConversations(stateDir, (registry) => registry, options);
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// A directory is the lock: mkdir is atomic across processes, and a writer that died leaves one that ages out.
function withLock<T>(stateDir: string, run: () => T): T {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = `${conversationsFile(stateDir)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; }
    catch (cause: unknown) {
      if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error("conversations.json is locked by another writer");
      sleep(10);
    }
  }
  try { return run(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

function writeRegistry(stateDir: string, registry: ConversationRegistry): void {
  const file = conversationsFile(stateDir);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

// Read, change and write under the lock, so two processes never overwrite each other's entry.
export function updateConversations(stateDir: string, change: (registry: ConversationRegistry) => ConversationRegistry, options?: MigrationOptions): ConversationRegistry {
  return withLock(stateDir, () => {
    const read = readRaw(stateDir);
    const current = needsMigration(read) ? migrated(stateDir, read.registry, options) : read.registry;
    const next = change(current);
    writeRegistry(stateDir, next);
    return next;
  });
}

export function upsertConversation(stateDir: string, key: string, conversation: Conversation): void {
  updateConversations(stateDir, (registry) => ({ ...registry, conversations: { ...registry.conversations, [key]: conversation } }));
}

export function removeConversation(stateDir: string, key: string): void {
  updateConversations(stateDir, (registry) => {
    const { [key]: _removed, ...rest } = registry.conversations;
    return { ...registry, conversations: rest };
  });
}

export function setConversationAlias(stateDir: string, key: string, aliases: Partial<ConversationAliases>): void {
  updateConversations(stateDir, (registry) => {
    const entry = registry.conversations[key];
    return entry === undefined ? registry : { ...registry, conversations: { ...registry.conversations, [key]: { ...entry, aliases: { ...entry.aliases, ...aliases } } } };
  });
}

// A provisional key becomes `agent:sessionId` once the agent's own evidence names it. Aliases and the
// hidden flag travel with the entry; an entry already under the new key absorbs the old one.
export function promoteConversation(stateDir: string, from: string, to: string): void {
  if (from === to) return;
  updateConversations(stateDir, (registry) => {
    const source = registry.conversations[from];
    if (source === undefined) return registry;
    const { [from]: _moved, ...rest } = registry.conversations;
    const target = rest[to];
    const merged: Conversation = target === undefined ? source : {
      owner: target.owner,
      cwd: target.cwd,
      aliases: {
        chatId: target.aliases.chatId ?? source.aliases.chatId,
        tmux: target.aliases.tmux ?? source.aliases.tmux,
        pid: target.aliases.pid ?? source.aliases.pid,
        dispatchId: target.aliases.dispatchId ?? source.aliases.dispatchId,
      },
      createdAt: target.createdAt < source.createdAt ? target.createdAt : source.createdAt,
      hidden: target.hidden || source.hidden,
    };
    return { ...registry, conversations: { ...rest, [to]: merged } };
  });
}

export function setConversationHidden(stateDir: string, key: string, hidden: boolean): void {
  updateConversations(stateDir, (registry) => {
    const entry = registry.conversations[key];
    if (entry !== undefined) return { ...registry, conversations: { ...registry.conversations, [key]: { ...entry, hidden } } };
    const others = registry.hiddenKeys.filter((candidate) => candidate !== key);
    return { ...registry, hiddenKeys: hidden ? [...others, key] : others };
  });
}
