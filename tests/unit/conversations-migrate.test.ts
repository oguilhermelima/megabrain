import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConversations } from "../../src/core/conversations.js";
import { migrateConversations } from "../../src/core/conversations-migrate.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const CWD = "/Users/operator/juntin";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type ChatSeed = { n: number; agent?: "claude" | "codex"; session?: string | null; mode?: "chat" | "terminal"; user?: boolean; cwd?: string; state?: string };

function stateWith(options: { chats?: ChatSeed[]; terminals?: Record<string, object>; owned?: Record<string, object>; hidden?: Record<string, string | null> }): string {
  const state = mkdtempSync(join(tmpdir(), "megabrain-migrate-"));
  directories.push(state);
  for (const seed of options.chats ?? []) {
    const id = uuid(seed.n);
    const directory = join(state, "chats", id);
    mkdirSync(directory, { recursive: true });
    const chat = {
      id, agent: seed.agent ?? "claude", model: null, cwd: seed.cwd ?? CWD, title: seed.user === true ? "Fixture chat" : null,
      state: seed.state ?? "suspended", mode: seed.mode ?? "chat", agentSessionId: seed.session ?? null,
      createdAt: `2026-10-1${seed.n % 9}T10:00:00.000Z`, lastActivityAt: null, error: null,
    };
    writeFileSync(join(directory, "chat.json"), `${JSON.stringify(chat)}\n`);
    const events = seed.user === true ? [{ cursor: "1", event: { id: "e1", at: chat.createdAt, kind: "user", text: "hello" } }] : [{ cursor: "1", event: { id: "e0", at: chat.createdAt, kind: "system", text: "Started chat" } }];
    writeFileSync(join(directory, "events.jsonl"), events.map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  if (options.terminals !== undefined) writeFileSync(join(state, "app-terminals.json"), JSON.stringify(options.terminals));
  if (options.owned !== undefined) writeFileSync(join(state, "owned-sessions.json"), JSON.stringify(options.owned));
  if (options.hidden !== undefined) writeFileSync(join(state, "hidden-sessions.json"), JSON.stringify({ version: 1, sessions: options.hidden }));
  return state;
}

const aliveNone = { isTmuxAlive: () => false };
const record = (command: string, cwd = CWD) => ({ title: "claude", command, cwd, createdAt: "2026-10-16T09:00:00.000Z" });

describe("migration from the legacy JSON files", () => {
  test("nine chats become five entries and the four that never had a turn are deleted", () => {
    const chats: ChatSeed[] = [
      ...[1, 2, 3, 4].map((n): ChatSeed => ({ n, session: `session-${n}`, user: true })),
      { n: 5, user: true, state: "idle" },
      ...[6, 7, 8, 9].map((n): ChatSeed => ({ n })),
    ];
    const state = stateWith({ chats });
    migrateConversations(state, aliveNone);
    const { conversations } = readConversations(state);
    expect(Object.keys(conversations)).toHaveLength(5);
    expect(conversations["claude:session-1"]?.owner).toBe("app-chat");
    expect(conversations["claude:session-1"]?.aliases.chatId).toBe(uuid(1));
    expect(conversations[`chat:${uuid(5)}`]?.hidden).toBe(false);
    for (const n of [6, 7, 8, 9]) expect(existsSync(join(state, "chats", uuid(n)))).toBe(false);
    for (const n of [1, 2, 3, 4, 5]) expect(existsSync(join(state, "chats", uuid(n), "chat.json"))).toBe(true);
  });

  test("an empty chat whose agent is still running is left alone: not registered, not deleted", () => {
    const state = stateWith({ chats: [{ n: 1, state: "idle" }, { n: 2, state: "working" }, { n: 3, state: "starting" }] });
    migrateConversations(state, aliveNone);
    expect(readConversations(state).conversations).toEqual({});
    for (const n of [1, 2, 3]) expect(existsSync(join(state, "chats", uuid(n), "chat.json"))).toBe(true);
  });

  test("an empty terminal-mode chat is deleted when its TUI is gone and kept while it lives", () => {
    const dead = stateWith({ chats: [{ n: 1, mode: "terminal", state: "idle" }], terminals: { "mb-app-ccbf5391": record("claude --dangerously-skip-permissions") } });
    migrateConversations(dead, aliveNone);
    expect(readConversations(dead).conversations).toEqual({});
    expect(existsSync(join(dead, "chats", uuid(1)))).toBe(false);
    const live = stateWith({ chats: [{ n: 1, mode: "terminal", state: "idle" }], terminals: { "mb-app-ccbf5391": record("claude --dangerously-skip-permissions") } });
    migrateConversations(live, { isTmuxAlive: () => true });
    expect(Object.keys(readConversations(live).conversations)).toEqual([`chat:${uuid(1)}`]);
  });

  test("a dead terminal record with no session is dropped", () => {
    const state = stateWith({ terminals: { "mb-app-ccbf5391": record("claude --dangerously-skip-permissions") } });
    migrateConversations(state, aliveNone);
    expect(readConversations(state).conversations).toEqual({});
  });

  test("a live terminal record becomes an app-terminal entry with its tmux alias", () => {
    const state = stateWith({ terminals: { "mb-app-aaaa1111": record("zsh") } });
    migrateConversations(state, { isTmuxAlive: (session) => session === "mb-app-aaaa1111" });
    const entry = readConversations(state).conversations["terminal:aaaa1111"];
    expect(entry?.owner).toBe("app-terminal");
    expect(entry?.aliases.tmux).toBe("megabrain-app:mb-app-aaaa1111");
    expect(entry?.cwd).toBe(CWD);
  });

  test("a dead terminal record that resumed a known session stays as that ended conversation", () => {
    const state = stateWith({ terminals: { "mb-app-bbbb2222": record("claude --resume fa2f6670-1111 --dangerously-skip-permissions") } });
    migrateConversations(state, aliveNone);
    const entry = readConversations(state).conversations["claude:fa2f6670-1111"];
    expect(entry?.owner).toBe("app-terminal");
    expect(entry?.aliases.tmux).toBe("megabrain-app:mb-app-bbbb2222");
  });

  test("the terminal-mode TUI record of a chat folds into that chat's entry", () => {
    const state = stateWith({
      chats: [{ n: 1, mode: "terminal", state: "idle" }],
      terminals: { "mb-app-ccbf5391": record("claude --dangerously-skip-permissions") },
    });
    migrateConversations(state, { isTmuxAlive: () => true });
    const { conversations } = readConversations(state);
    expect(Object.keys(conversations)).toEqual([`chat:${uuid(1)}`]);
    expect(conversations[`chat:${uuid(1)}`]?.aliases.tmux).toBe("megabrain-app:mb-app-ccbf5391");
  });

  test("a terminal in another folder with the same command is not folded into the chat", () => {
    const state = stateWith({
      chats: [{ n: 1, session: "session-1", user: true, mode: "terminal", state: "idle" }],
      terminals: { "mb-app-dddd4444": record("claude --dangerously-skip-permissions", "/Users/operator/other") },
    });
    migrateConversations(state, { isTmuxAlive: () => true });
    expect(Object.keys(readConversations(state).conversations).sort()).toEqual(["claude:session-1", "terminal:dddd4444"]);
  });

  test("an owned session whose tmux session is gone is dropped; a live one keeps its alias", () => {
    const owned = {
      "claude:live-session": { tmuxServer: "megabrain-app", tmuxSession: "mb-claude-live-ses", command: "claude --resume live-session", cwd: CWD, ownedAt: "2026-10-16T08:00:00.000Z" },
      "codex:dead-session": { tmuxServer: "megabrain-app", tmuxSession: "mb-codex-dead-ses", command: "codex resume dead-session", cwd: CWD, ownedAt: "2026-10-16T08:00:00.000Z" },
    };
    const state = stateWith({ owned });
    migrateConversations(state, { isTmuxAlive: (session) => session === "mb-claude-live-ses" });
    const { conversations } = readConversations(state);
    expect(Object.keys(conversations)).toEqual(["claude:live-session"]);
    expect(conversations["claude:live-session"]?.aliases.tmux).toBe("megabrain-app:mb-claude-live-ses");
  });

  test("an owned session that is also a chat's session adds its alias to the chat entry", () => {
    const owned = { "claude:session-1": { tmuxServer: "megabrain-app", tmuxSession: "mb-claude-session-", command: "claude --resume session-1", cwd: CWD, ownedAt: "2026-10-16T08:00:00.000Z" } };
    const state = stateWith({ chats: [{ n: 1, session: "session-1", user: true }], owned });
    migrateConversations(state, { isTmuxAlive: () => true });
    const { conversations } = readConversations(state);
    expect(Object.keys(conversations)).toEqual(["claude:session-1"]);
    expect(conversations["claude:session-1"]?.owner).toBe("app-chat");
    expect(conversations["claude:session-1"]?.aliases.tmux).toBe("megabrain-app:mb-claude-session-");
  });

  test("hidden sessions mark stored conversations and keep the ids no source reports", () => {
    const state = stateWith({ chats: [{ n: 1, session: "session-1", user: true }], hidden: { "claude:session-1": "2026-10-15T10:00:00.000Z", "codex:foreign-1": null } });
    migrateConversations(state, aliveNone);
    const registry = readConversations(state);
    expect(registry.conversations["claude:session-1"]?.hidden).toBe(true);
    expect(registry.hiddenKeys).toEqual(["codex:foreign-1"]);
  });

  test("it is idempotent and the legacy files are left in place", () => {
    const state = stateWith({ chats: [{ n: 1, session: "session-1", user: true }], terminals: { "mb-app-eeee5555": record("zsh") }, hidden: { "codex:x": null } });
    migrateConversations(state, { isTmuxAlive: () => true });
    const first = readFileSync(join(state, "conversations.json"), "utf8");
    migrateConversations(state, { isTmuxAlive: () => false });
    expect(readFileSync(join(state, "conversations.json"), "utf8")).toBe(first);
    expect(readConversations(state).migratedFrom).toEqual(["chats", "app-terminals.json", "hidden-sessions.json"]);
    for (const name of ["app-terminals.json", "hidden-sessions.json"]) expect(existsSync(join(state, name))).toBe(true);
  });

  test("a second run does not resurrect an entry the person closed", () => {
    const state = stateWith({ chats: [{ n: 1, session: "session-1", user: true }] });
    migrateConversations(state, aliveNone);
    rmSync(join(state, "conversations.json"));
    writeFileSync(join(state, "conversations.json"), JSON.stringify({ version: 1, conversations: {}, hiddenKeys: [], migratedFrom: ["chats"] }));
    migrateConversations(state, aliveNone);
    expect(readConversations(state).conversations).toEqual({});
  });

  test("the first read of the registry runs the migration", () => {
    const state = stateWith({ chats: [{ n: 1, session: "session-1", user: true }] });
    expect(Object.keys(readConversations(state, { isTmuxAlive: () => false }).conversations)).toEqual(["claude:session-1"]);
  });

  test("a state directory with no legacy files migrates to an empty registry once", () => {
    const state = stateWith({});
    expect(readConversations(state, aliveNone).migratedFrom).toEqual([]);
  });
});
