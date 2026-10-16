import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { claudeLogPath } from "../../src/chat/session-log.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";
import { chatKey, readConversations, upsertConversation } from "../../src/core/conversations.js";

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
const sleepers: Array<{ kill: () => void }> = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const sleeper of sleepers.splice(0)) sleeper.kill();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ID = "7c1f0c52-8f5e-4d1e-9a55-0d3f2b6a1e22";
const NONE = { chatId: null, tmux: null, pid: null, dispatchId: null };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-chat-registry-"));
  directories.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  for (const directory of [state, cwd, bin]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { root, state, cwd, bin };
}
type Env = ReturnType<typeof sandbox>;

function script(bin: string, name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
}

// Like the real one, it prints system/init only after its first user line.
const FAKE_CLAUDE = `
const readline = require("node:readline");
let started = false;
readline.createInterface({ input: process.stdin }).on("line", () => {
  if (!started) { started = true; process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fresh-session" }) + "\\n"); }
  process.stdout.write(JSON.stringify({ type: "result", session_id: "fresh-session", is_error: false }) + "\\n");
});
`;

// A tmux that logs its argv and names the test process as the pane process of any session.
function fakeTmux(env: Env, panePid: number): string {
  const log = join(env.root, "tmux.log");
  script(env.bin, "tmux", `
require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
if (process.argv.includes("list-panes")) process.stdout.write(${JSON.stringify(String(panePid))} + "\\n");
`);
  return log;
}

async function daemonFor(env: Env): Promise<ChatDaemon> {
  const environment = { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  const daemon = new ChatDaemon(env.state, environment);
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  return daemon;
}

function terminalChat(env: Env, overrides: Partial<Chat> = {}): Chat {
  return {
    id: ID, agent: "claude", model: null, cwd: env.cwd, title: "remember", state: "idle", mode: "terminal",
    agentSessionId: null, createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: "2026-10-16T10:05:00.000Z", terminalSince: "2026-10-16T10:05:00.000Z", ...overrides,
  };
}

function seedRegistry(env: Env, tmux: string | null) {
  upsertConversation(env.state, chatKey(ID), { owner: "app-chat", cwd: env.cwd, aliases: { ...NONE, chatId: ID, tmux }, createdAt: "2026-10-16T09:00:00.000Z", hidden: false });
}

// A Claude registry entry (~/.claude/sessions/<pid>.json) for a process the test owns.
function claudeRegistryEntry(env: Env, pid: number, sessionId: string) {
  const directory = join(env.root, ".claude", "sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd: env.cwd, startedAt: Date.now(), status: "idle" }));
  const log = claudeLogPath(env.root, env.cwd, sessionId);
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(log, "");
}

async function waitFor<T>(read: () => T | undefined | false): Promise<T> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not reached");
}

describe("chatd and the conversation registry", () => {
  test("a chat with a message is registered under its chat key, then promoted when the agent reports its session", async () => {
    const env = sandbox();
    script(env.bin, "claude", FAKE_CLAUDE);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "hello" }] }) as Chat;
    const promoted = await waitFor(() => readConversations(env.state).conversations["claude:fresh-session"]);
    expect(promoted.owner).toBe("app-chat");
    expect(promoted.aliases.chatId).toBe(chat.id);
    expect(readConversations(env.state).conversations[chatKey(chat.id)]).toBeUndefined();
  });

  test("a start without a message leaves no record and no registry entry after the daemon restarts", async () => {
    const env = sandbox();
    script(env.bin, "claude", FAKE_CLAUDE);
    const first = await daemonFor(env);
    const chat = await first.handle({ operation: "start", agent: "claude", cwd: env.cwd }) as Chat;
    expect(readConversations(env.state).conversations[chatKey(chat.id)]).toBeUndefined();
    await first.close();
    daemons.splice(daemons.indexOf(first), 1);
    const second = await daemonFor(env);
    expect(await second.store.list()).toEqual([]);
    expect(existsSync(join(env.state, "chats", chat.id))).toBe(false);
  });

  test("a chat that had a turn survives the same restart", async () => {
    const env = sandbox();
    await new ChatStore(env.state).put(terminalChat(env, { mode: "chat", state: "suspended", agentSessionId: "kept-session" }));
    const daemon = await daemonFor(env);
    expect((await daemon.store.list()).map((chat) => chat.id)).toEqual([ID]);
  });

  test("remove kills the terminal-mode tmux alias on the app's server and drops the entry", async () => {
    const env = sandbox();
    const log = fakeTmux(env, process.pid);
    await new ChatStore(env.state).put(terminalChat(env, { mode: "chat", state: "suspended", agentSessionId: "kept-session" }));
    upsertConversation(env.state, "claude:kept-session", { owner: "app-chat", cwd: env.cwd, aliases: { ...NONE, chatId: ID, tmux: "megabrain-app:mb-app-ccbf5391" }, createdAt: "2026-10-16T09:00:00.000Z", hidden: false });
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "remove", id: ID });
    expect(readFileSync(log, "utf8")).toContain("-L megabrain-app kill-session -t =mb-app-ccbf5391");
    expect(readConversations(env.state).conversations["claude:kept-session"]).toBeUndefined();
  });

  test("remove never touches a tmux session outside the app's server", async () => {
    const env = sandbox();
    const log = fakeTmux(env, process.pid);
    await new ChatStore(env.state).put(terminalChat(env, { mode: "chat", state: "suspended", agentSessionId: "kept-session" }));
    upsertConversation(env.state, "claude:kept-session", { owner: "app-chat", cwd: env.cwd, aliases: { ...NONE, chatId: ID, tmux: "default:work" }, createdAt: "2026-10-16T09:00:00.000Z", hidden: false });
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "remove", id: ID });
    expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("kill-session");
  });
});

describe("returning from terminal mode", () => {
  test("a second agent writing in the same folder is not adopted", async () => {
    const env = sandbox();
    script(env.bin, "claude", FAKE_CLAUDE);
    const sleeper = Bun.spawn(["sleep", "60"]);
    sleepers.push(sleeper);
    fakeTmux(env, process.pid);
    // The other agent's pid does not descend from the chat's pane (the pane is this test's process; "1" is launchd).
    claudeRegistryEntry(env, 1, "someone-elses-session");
    seedRegistry(env, "megabrain-app:mb-app-ccbf5391");
    await new ChatStore(env.state).put(terminalChat(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    const chat = await daemon.store.get(ID);
    expect(chat?.agentSessionId).not.toBe("someone-elses-session");
  });

  test("without a tmux alias nothing is guessed from the folder", async () => {
    const env = sandbox();
    script(env.bin, "claude", FAKE_CLAUDE);
    claudeRegistryEntry(env, 1, "someone-elses-session");
    seedRegistry(env, null);
    await new ChatStore(env.state).put(terminalChat(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    expect((await daemon.store.get(ID))?.agentSessionId).not.toBe("someone-elses-session");
  });

  test("the session of a process that descends from the chat's own pane is adopted", async () => {
    const env = sandbox();
    script(env.bin, "claude", FAKE_CLAUDE);
    const sleeper = Bun.spawn(["sleep", "60"]);
    sleepers.push(sleeper);
    fakeTmux(env, process.pid);
    claudeRegistryEntry(env, sleeper.pid, "the-tui-session");
    seedRegistry(env, "megabrain-app:mb-app-ccbf5391");
    await new ChatStore(env.state).put(terminalChat(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    expect((await daemon.store.get(ID))?.agentSessionId).toBe("the-tui-session");
    expect(readConversations(env.state).conversations["claude:the-tui-session"]?.aliases.chatId).toBe(ID);
  });
});
