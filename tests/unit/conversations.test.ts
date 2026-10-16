import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chatKey,
  promoteConversation,
  readConversations,
  removeConversation,
  setConversationAlias,
  setConversationHidden,
  terminalKey,
  upsertConversation,
  type Conversation,
} from "../../src/core/conversations.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function stateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "megabrain-conversations-"));
  directories.push(directory);
  return directory;
}

const NONE = { chatId: null, tmux: null, pid: null, dispatchId: null };
function chatConversation(chatId: string, overrides: Partial<Conversation> = {}): Conversation {
  return { owner: "app-chat", cwd: "/Users/operator/project", aliases: { ...NONE, chatId }, createdAt: "2026-10-16T10:00:00.000Z", hidden: false, ...overrides };
}

describe("conversation registry", () => {
  test("reads as empty when nothing was ever written", () => {
    const state = stateDir();
    expect(readConversations(state).conversations).toEqual({});
    expect(readConversations(state).version).toBe(1);
  });

  test("an unknown version or a corrupt file reads as empty", () => {
    const state = stateDir();
    writeFileSync(join(state, "conversations.json"), JSON.stringify({ version: 2, conversations: { "claude:x": chatConversation("c") } }));
    expect(readConversations(state).conversations).toEqual({});
    writeFileSync(join(state, "conversations.json"), "{ not json");
    expect(readConversations(state).conversations).toEqual({});
  });

  test("writes a private file and leaves no temporary file behind", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1"));
    const file = join(state, "conversations.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(state).filter((name) => name.includes("tmp") || name.endsWith(".lock"))).toEqual([]);
    expect(readConversations(state).conversations["chat:c1"]?.owner).toBe("app-chat");
  });

  test("promotion keeps aliases and hidden and drops the provisional key", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1", { hidden: true, aliases: { ...NONE, chatId: "c1", tmux: "megabrain-app:mb-app-1" } }));
    promoteConversation(state, chatKey("c1"), "claude:abc");
    const { conversations } = readConversations(state);
    expect(conversations["chat:c1"]).toBeUndefined();
    expect(conversations["claude:abc"]?.hidden).toBe(true);
    expect(conversations["claude:abc"]?.aliases).toEqual({ ...NONE, chatId: "c1", tmux: "megabrain-app:mb-app-1" });
  });

  test("promotion onto an existing key merges aliases instead of replacing it", () => {
    const state = stateDir();
    upsertConversation(state, "claude:abc", { owner: "app-terminal", cwd: "/Users/operator/project", aliases: { ...NONE, tmux: "megabrain-app:mb-claude-abc" }, createdAt: "2026-10-16T09:00:00.000Z", hidden: false });
    upsertConversation(state, terminalKey("t1"), { owner: "app-terminal", cwd: "/Users/operator/project", aliases: { ...NONE, pid: 42 }, createdAt: "2026-10-16T10:00:00.000Z", hidden: false });
    promoteConversation(state, terminalKey("t1"), "claude:abc");
    const entry = readConversations(state).conversations["claude:abc"];
    expect(entry?.aliases).toEqual({ ...NONE, tmux: "megabrain-app:mb-claude-abc", pid: 42 });
    expect(entry?.createdAt).toBe("2026-10-16T09:00:00.000Z");
    expect(readConversations(state).conversations["terminal:t1"]).toBeUndefined();
  });

  test("promoting a key that is not there changes nothing", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1"));
    promoteConversation(state, chatKey("missing"), "claude:abc");
    expect(Object.keys(readConversations(state).conversations)).toEqual(["chat:c1"]);
  });

  test("an alias is added and cleared on one entry", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1"));
    setConversationAlias(state, chatKey("c1"), { tmux: "megabrain-app:mb-app-1" });
    expect(readConversations(state).conversations["chat:c1"]?.aliases.tmux).toBe("megabrain-app:mb-app-1");
    setConversationAlias(state, chatKey("c1"), { tmux: null });
    expect(readConversations(state).conversations["chat:c1"]?.aliases).toEqual({ ...NONE, chatId: "c1" });
  });

  test("hiding a stored conversation flips its flag; hiding an unknown key is remembered", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1"));
    setConversationHidden(state, chatKey("c1"), true);
    expect(readConversations(state).conversations["chat:c1"]?.hidden).toBe(true);
    setConversationHidden(state, "codex:foreign", true);
    expect(readConversations(state).hiddenKeys).toEqual(["codex:foreign"]);
    setConversationHidden(state, "codex:foreign", false);
    setConversationHidden(state, chatKey("c1"), false);
    expect(readConversations(state).hiddenKeys).toEqual([]);
    expect(readConversations(state).conversations["chat:c1"]?.hidden).toBe(false);
  });

  test("concurrent writers in separate processes do not lose an entry", async () => {
    const state = stateDir();
    const module = join(import.meta.dir, "../../src/core/conversations.ts");
    const script = `import { upsertConversation } from ${JSON.stringify(module)};
      upsertConversation(process.argv[1], "claude:" + process.argv[2], { owner: "app-chat", cwd: "/x", aliases: { chatId: process.argv[2], tmux: null, pid: null, dispatchId: null }, createdAt: "2026-10-16T10:00:00.000Z", hidden: false });`;
    const writers = Array.from({ length: 8 }, (_, index) => Bun.spawn([process.execPath, "-e", script, state, String(index)], { stdout: "ignore", stderr: "pipe" }));
    for (const writer of writers) expect(await writer.exited).toBe(0);
    expect(Object.keys(readConversations(state).conversations).sort()).toEqual(Array.from({ length: 8 }, (_, index) => `claude:${index}`));
  });

  test("a stale lock left by a dead writer does not block the next write", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1"));
    const lock = join(state, "conversations.json.lock");
    require("node:fs").mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    require("node:fs").utimesSync(lock, old, old);
    upsertConversation(state, chatKey("c2"), chatConversation("c2"));
    expect(Object.keys(readConversations(state).conversations).sort()).toEqual(["chat:c1", "chat:c2"]);
    expect(existsSync(lock)).toBe(false);
  });

  test("removing an entry drops it and nothing else", () => {
    const state = stateDir();
    upsertConversation(state, chatKey("c1"), chatConversation("c1"));
    upsertConversation(state, chatKey("c2"), chatConversation("c2"));
    removeConversation(state, chatKey("c1"));
    expect(Object.keys(readConversations(state).conversations)).toEqual(["chat:c2"]);
    expect(JSON.parse(readFileSync(join(state, "conversations.json"), "utf8")).version).toBe(1);
  });
});
