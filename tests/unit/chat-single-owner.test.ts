import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { callChatd, chatdStatus, ChatDaemon, CHAT_PROTOCOL_VERSION, CHAT_PROTOCOL_MIN_VERSION, retireChatd } from "../../src/chat/daemon.js";
import { claudeLogPath } from "../../src/chat/session-log.js";
import { ChatStore, type Chat, type ChatEvent } from "../../src/chat/store.js";
import { readConversations, setConversationAlias, upsertConversation } from "../../src/core/conversations.js";
import { liveSessionHolders } from "../../src/core/session-holders.js";
import { executeChat } from "../../src/cli/commands/chat.js";

// One live agent process per conversation. Every tmux call the code makes to the app's server lands on a
// private server of this test, through a tmux shim first on PATH; the person's real server is never addressed.

const REAL_TMUX = spawnSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
const directories: string[] = [];
const daemons: ChatDaemon[] = [];
const servers: string[] = [];
const processes: ChildProcess[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const child of processes.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) spawnSync(REAL_TMUX, ["-L", server, "kill-server"], { stdio: "ignore" });
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-owner-"));
  directories.push(root);
  const env = { root, state: join(root, "state"), cwd: join(root, "project"), bin: join(root, "bin"), tui: join(root, "tui"), capture: join(root, "capture.jsonl"), server: `mbtest-${randomUUID().slice(0, 8)}` };
  for (const dir of [env.state, env.cwd, env.bin, env.tui]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  servers.push(env.server);
  writeFileSync(join(env.bin, "tmux"), `#!/bin/sh\nif [ "$1" = "-L" ] && [ "$2" = "megabrain-app" ]; then shift 2; for arg in "$@"; do if [ "$arg" = "capture-pane" ]; then printf '  ❯ unsent words\\n'; exit 0; fi; done; exec ${REAL_TMUX} -L ${env.server} "$@"; fi\nexec ${REAL_TMUX} "$@"\n`);
  chmodSync(join(env.bin, "tmux"), 0o700);
  // The TUI stand-in: a process named claude that holds its session until killed.
  writeFileSync(join(env.tui, "claude"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  chmodSync(join(env.tui, "claude"), 0o700);
  writeFileSync(env.capture, "");
  return env;
}
type Env = ReturnType<typeof sandbox>;

const environmentOf = (env: Env, extra: Record<string, string> = {}) => ({ HOME: env.root, CHAT_CAPTURE: env.capture, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, ...extra });
const adapterOf = (env: Env): ProcessAdapter => {
  const base = createProcessAdapter();
  return { ...base, run: (command, args, options) => base.run(command, args, { ...options, env: { PATH: environmentOf(env).PATH, ...options?.env } }) };
};

// Stream-json Claude: "slow" answers after a pause, "crash" starts a tool call and dies.
const FAKE_CLAUDE = `
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify({ argv, pid: process.pid }) + "\\n");
const at = argv.indexOf("--resume");
const session = at === -1 ? "fresh-" + process.pid : argv[at + 1];
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content.map((part) => part.text).join("");
  if (text === "crash") {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m-crash", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "megabrain port kill 8081" } }] } }) + "\\n");
    setTimeout(() => process.exit(1), 50);
    return;
  }
  const answer = () => {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m" + Date.now(), content: [{ type: "text", text: "answer:" + text }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", session_id: session, is_error: false }) + "\\n");
  };
  if (text === "slow") setTimeout(answer, 600); else answer();
});
`;

function fakeClaude(env: Env) {
  writeFileSync(join(env.bin, "claude"), `#!${process.execPath}\n${FAKE_CLAUDE}\n`);
  chmodSync(join(env.bin, "claude"), 0o700);
}

function record(env: Env, overrides: Partial<Chat> = {}): Chat {
  return {
    id: randomUUID(), agent: "claude", model: null, cwd: env.cwd, title: "owner", state: "suspended", mode: "chat",
    agentSessionId: randomUUID(), createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: "2026-10-16T09:00:00.000Z", error: null, ...overrides,
  };
}

/** A TUI resuming the session inside an app terminal on the private server. */
function tuiInTmux(env: Env, session: string, sessionId: string): void {
  const created = spawnSync(REAL_TMUX, ["-L", env.server, "new-session", "-d", "-s", session, "-c", env.cwd, join(env.tui, "claude"), "--resume", sessionId, "--dangerously-skip-permissions"]);
  expect(created.status).toBe(0);
}
function linkTerminal(env: Env, chat: Chat, session: string): void {
  const entry = Object.entries(readConversations(env.state).conversations).find(([, value]) => value.aliases.chatId === chat.id);
  if (entry !== undefined) setConversationAlias(env.state, entry[0], { tmux: `megabrain-app:${session}` });
  else upsertConversation(env.state, `${chat.agent}:${chat.agentSessionId ?? chat.id}`, { owner: "app-chat", cwd: env.cwd, aliases: { chatId: chat.id, tmux: `megabrain-app:${session}`, pid: null, dispatchId: null }, createdAt: chat.createdAt, hidden: false });
}
/** An app TUI that lets SIGTERM finish cleanup instead of exiting immediately. */
function slowTuiInTmux(env: Env, session: string, sessionId: string): number {
  const script = join(env.tui, "claude");
  writeFileSync(script, `#!${process.execPath}
const { mkdirSync, writeFileSync, unlinkSync } = require("node:fs");
const { join } = require("node:path");
const dir = join(process.env.HOME, ".claude", "sessions");
mkdirSync(dir, { recursive: true });
const record = join(dir, process.pid + ".json");
writeFileSync(record, JSON.stringify({ pid: process.pid, sessionId: ${JSON.stringify(sessionId)}, cwd: ${JSON.stringify(env.cwd)} }));
process.on("SIGTERM", () => setTimeout(() => { try { unlinkSync(record); } catch {} process.exit(0); }, 2000));
setInterval(() => {}, 1000);
`);
  chmodSync(script, 0o700);
  const created = spawnSync(REAL_TMUX, ["-L", env.server, "new-session", "-d", "-s", session, "-c", env.cwd, script, "--resume", sessionId]);
  expect(created.status).toBe(0);
  const pane = spawnSync(REAL_TMUX, ["-L", env.server, "list-panes", "-t", `=${session}`, "-F", "#{pane_pid}"], { encoding: "utf8" });
  return Number(pane.stdout.trim());
}
/** A TUI resuming the session in a terminal megabrain does not own. */
function tuiOutside(env: Env, sessionId: string): ChildProcess {
  const child = spawn(join(env.tui, "claude"), ["--resume", sessionId], { cwd: env.cwd, stdio: "ignore" });
  processes.push(child);
  return child;
}
const hasSession = (env: Env, session: string) => spawnSync(REAL_TMUX, ["-L", env.server, "has-session", "-t", `=${session}`], { stdio: "ignore" }).status === 0;
const spawned = (env: Env) => readFileSync(env.capture, "utf8").split("\n").filter((line) => line.includes("\"argv\"")).map((line) => JSON.parse(line) as { argv: string[]; pid: number });

async function daemonFor(env: Env, extra: Record<string, string> = {}, build?: number): Promise<ChatDaemon> {
  const daemon = new ChatDaemon(env.state, environmentOf(env, extra), CHAT_PROTOCOL_VERSION, build);
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  return daemon;
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, attempts = 200): Promise<T> {
  let value = await read();
  for (let attempt = 0; attempt < attempts && !done(value); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = await read();
  }
  if (!done(value)) throw new Error(`${what}: ${JSON.stringify(value)}`);
  return value;
}
const stateOf = (daemon: ChatDaemon, id: string, state: Chat["state"]) => until(() => daemon.store.get(id), (chat) => chat?.state === state, `chat did not reach ${state}`);
async function eventsOf(daemon: ChatDaemon, id: string): Promise<ChatEvent[]> {
  return (await daemon.store.events(id)).flatMap((line) => line.event === undefined ? [] : [line.event]);
}
const visible = (list: ChatEvent[]) => list.filter((item) => item.kind !== "state").map((item) => `${item.kind}:${item.text}`);

function claudeLog(env: Env, chat: Chat, rows: Record<string, unknown>[]): string {
  const path = claudeLogPath(env.root, env.cwd, chat.agentSessionId ?? "");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
  return path;
}
const prompt = (uuid: string, at: string, text: string) => ({ type: "user", uuid, timestamp: at, message: { role: "user", content: text } });
const toolUse = (uuid: string, at: string) => ({ type: "assistant", uuid, timestamp: at, message: { id: `msg-${uuid}`, stop_reason: "tool_use", content: [{ type: "tool_use", id: `tool-${uuid}`, name: "Bash", input: { command: "megabrain port kill 8081" } }] } });
const endTurn = (uuid: string, at: string) => ({ type: "assistant", uuid, timestamp: at, message: { id: `msg-${uuid}`, stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });

describe("the processes that hold an agent session", () => {
  test("are found inside the app's tmux server and outside it, and never the tmux server or an excluded pid", async () => {
    const env = sandbox();
    const sessionId = randomUUID();
    tuiInTmux(env, "mb-app-holder", sessionId);
    const outside = tuiOutside(env, sessionId);
    const excluded = tuiOutside(env, sessionId);
    const holders = await until(
      () => liveSessionHolders("claude", sessionId, { home: env.root, processes: adapterOf(env), exclude: new Set([excluded.pid ?? 0]), cwd: env.cwd }),
      (found) => found.length === 2,
      "holders",
    );
    expect(holders.map((holder) => holder.tmuxSession).sort()).toEqual(["mb-app-holder", null].sort());
    expect(holders.find((holder) => holder.tmuxSession === null)?.pid).toBe(outside.pid);
    expect(await liveSessionHolders("claude", randomUUID(), { home: env.root, processes: adapterOf(env) })).toEqual([]);
    // Claude in another directory cannot reach this session's log, so it is no second writer.
    expect(await liveSessionHolders("claude", sessionId, { home: env.root, processes: adapterOf(env), exclude: new Set([excluded.pid ?? 0]), cwd: env.root })).toEqual([]);
  });

  test("include a Claude registered under the session id even when its command line does not name it", async () => {
    const env = sandbox();
    const sessionId = randomUUID();
    const child = spawn(join(env.tui, "claude"), [], { cwd: env.cwd, stdio: "ignore" });
    processes.push(child);
    mkdirSync(join(env.root, ".claude", "sessions"), { recursive: true });
    writeFileSync(join(env.root, ".claude", "sessions", `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId, cwd: env.cwd }));
    const holders = await until(() => liveSessionHolders("claude", sessionId, { home: env.root, processes: adapterOf(env) }), (found) => found.length === 1, "registered holder");
    expect(holders[0]?.pid).toBe(child.pid);
  });
});

describe("one live agent process per chat", () => {
  test("a recorded chatd child left holding the session is ended before retry resumes it", async () => {
    const env = sandbox();
    fakeClaude(env);
    const sessionId = randomUUID();
    const chat = record(env, { state: "suspended", agentSessionId: sessionId });
    await new ChatStore(env.state).put(chat);
    const holder = tuiOutside(env, sessionId);
    await until(() => liveSessionHolders("claude", sessionId, { home: env.root, processes: adapterOf(env), cwd: env.cwd }), (found) => found.length === 1, "orphaned chatd child");
    mkdirSync(join(env.state, "chatd", "children"), { recursive: true });
    writeFileSync(join(env.state, "chatd", "children", `${chat.id}.json`), JSON.stringify({ pid: holder.pid }));
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "resume after upgrade" }] });
    await stateOf(daemon, chat.id, "idle");
    await until(() => liveSessionHolders("claude", sessionId, { home: env.root, processes: adapterOf(env), cwd: env.cwd }), (found) => found.every((entry) => entry.pid !== holder.pid), "recorded holder closed");
    expect(spawned(env).some((entry) => entry.argv.includes(sessionId))).toBe(true);
  });

  test("switching to the chat view ends app terminals before resuming one session", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-aliased", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-aliased");
    tuiInTmux(env, "mb-app-earlier", chat.agentSessionId ?? "");
    tuiInTmux(env, "mb-app-oldest", chat.agentSessionId ?? "");
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await until(() => spawned(env), (children) => children.length === 1, "resumed agent to spawn");
    expect(hasSession(env, "mb-app-aliased")).toBe(false);
    expect(hasSession(env, "mb-app-earlier")).toBe(false);
    expect(hasSession(env, "mb-app-oldest")).toBe(false);
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]?.argv).toContain(chat.agentSessionId);
  });

  test("switching to the chat view closes a slow app TUI before resuming", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    const panePid = slowTuiInTmux(env, "mb-app-slow-exit", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-slow-exit");
    const daemon = await daemonFor(env);

    const startedAt = Date.now();
    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(() => process.kill(panePid, 0)).toThrow();
    expect(hasSession(env, "mb-app-slow-exit")).toBe(false);
    await until(() => spawned(env), (children) => children.length === 1, "resumed agent to spawn");
    expect((await daemon.store.get(chat.id))?.mode).toBe("chat");
  });

  test("refuses to stop an app TUI during an unfinished turn and keeps terminal mode", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "working", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    claudeLog(env, chat, [prompt("mid-turn-user", new Date(Date.now() + 1000).toISOString(), "still running"), toolUse("mid-turn-tool", new Date(Date.now() + 1001).toISOString())]);
    tuiInTmux(env, "mb-app-mid-turn", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-mid-turn");
    const daemon = await daemonFor(env);

    await expect(daemon.handle({ operation: "mode", id: chat.id, mode: "chat" })).rejects.toThrow("terminal is still working");

    expect((await daemon.requireChat(chat.id)).mode).toBe("terminal");
    expect(hasSession(env, "mb-app-mid-turn")).toBe(true);
    expect(spawned(env)).toHaveLength(0);
  });

  test("reports a foreign owner before stopping the app TUI and preserves terminal mode", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-foreign-check", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-foreign-check");
    const foreign = tuiOutside(env, chat.agentSessionId ?? "");
    const daemon = await daemonFor(env);
    await until(() => liveSessionHolders("claude", chat.agentSessionId ?? "", { home: env.root, processes: adapterOf(env), cwd: env.cwd }), (found) => found.length === 2, "app and foreign holders");

    await expect(daemon.handle({ operation: "mode", id: chat.id, mode: "chat" })).rejects.toThrow(`pid ${foreign.pid}`);

    expect((await daemon.requireChat(chat.id)).mode).toBe("terminal");
    expect(hasSession(env, "mb-app-foreign-check")).toBe(true);
    expect(foreign.exitCode).toBeNull();
    expect(spawned(env)).toHaveLength(0);
  });

  test("switching to the chat view ends its linked terminal before starting one writer", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-view-switch", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-view-switch");
    const daemon = await daemonFor(env);

    const result = await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" }) as { chat: Chat };

    expect(result.chat.mode).toBe("chat");
    expect(hasSession(env, "mb-app-view-switch")).toBe(false);
    await until(() => spawned(env), (children) => children.length === 1, "resumed agent to spawn");
    expect(spawned(env)[0]?.argv).toContain(chat.agentSessionId);
  });

  test("a chat send during a terminal turn reports terminal-busy and leaves the TUI alone", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "chat", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-busy-send", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-busy-send");
    claudeLog(env, chat, [prompt("busy-user", new Date().toISOString(), "still working"), toolUse("busy-call", new Date().toISOString())]);
    const daemon = await daemonFor(env);

    let failure: (Error & { code?: string }) | null = null;
    try { await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "keep this draft" }] }); }
    catch (error) { failure = error as Error & { code?: string }; }

    expect(failure?.code).toBe("terminal-busy");
    expect(failure?.message).toContain("terminal is still working");
    expect(hasSession(env, "mb-app-busy-send")).toBe(true);
    expect(spawned(env)).toHaveLength(0);
    expect((await eventsOf(daemon, chat.id)).some((item) => item.kind === "user" && item.text === "keep this draft")).toBe(false);
  });

  test("a send closes idle app-owned duplicate holders and resumes the same session", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env);
    await new ChatStore(env.state).put(chat);
    upsertConversation(env.state, `claude:${chat.agentSessionId}`, { owner: "app-chat", cwd: env.cwd, aliases: { chatId: chat.id, tmux: null, pid: null, dispatchId: null }, createdAt: chat.createdAt, hidden: false });
    tuiInTmux(env, "mb-app-duplicate-a", chat.agentSessionId ?? "");
    tuiInTmux(env, "mb-app-duplicate-b", chat.agentSessionId ?? "");
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "continue" }] });
    await until(() => spawned(env), (children) => children.length === 1, "resumed agent to spawn");

    expect(hasSession(env, "mb-app-duplicate-a")).toBe(false);
    expect(hasSession(env, "mb-app-duplicate-b")).toBe(false);
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]?.argv).toContain(chat.agentSessionId);
  });

  test("a working app-owned holder keeps the chat working until its turn finishes, then resumes", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env);
    await new ChatStore(env.state).put(chat);
    const path = claudeLogPath(env.root, env.cwd, chat.agentSessionId ?? "");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "still working" } })}\n`);
    tuiInTmux(env, "mb-app-working", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-working");
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "continue" }] });
    await stateOf(daemon, chat.id, "working");
    expect(spawned(env)).toHaveLength(0);
    writeFileSync(path, `${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })}\n`);
    await stateOf(daemon, chat.id, "idle");
    await until(async () => spawned(env), (children) => children.length === 1, "resumed agent to spawn");

    expect(hasSession(env, "mb-app-working")).toBe(false);
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]?.argv).toContain(chat.agentSessionId);
  });

  test("a concurrent terminal refresh keeps the chat working while its queued handoff is in progress", async () => {
    const env = sandbox();
    const chat = record(env, { state: "working", owner: "terminal" });
    const path = claudeLogPath(env.root, env.cwd, chat.agentSessionId ?? "");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "still working" } })}\n${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })}\n`);
    const daemon = await daemonFor(env);
    await daemon.store.put(chat);
    daemon.foreignHolders = async () => [{ pid: process.pid, tmuxSession: "mb-app-handoff", cwd: env.cwd }];
    await daemon.enqueue(chat, [{ type: "text", text: "continue" }]);
    daemon.terminalHandoffs.add(chat.id);

    await daemon.refreshTerminalChats();

    expect((await daemon.store.get(chat.id))?.state).toBe("working");
    expect(spawned(env)).toHaveLength(0);
  });

  test("switching to the chat view records a non-empty TUI composer line before resuming", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-draft", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-draft");
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await stateOf(daemon, chat.id, "idle");

    expect(await eventsOf(daemon, chat.id)).toContainEqual(expect.objectContaining({ kind: "system", text: "Unsent text from the terminal: unsent words" }));
    expect(hasSession(env, "mb-app-draft")).toBe(false);
  });

  test("a resume is refused while a process the app does not own holds the session, and nothing is spawned", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env);
    await new ChatStore(env.state).put(chat);
    const outside = tuiOutside(env, chat.agentSessionId ?? "");
    const daemon = await daemonFor(env);
    await until(() => liveSessionHolders("claude", chat.agentSessionId ?? "", { home: env.root, processes: adapterOf(env) }), (found) => found.length === 1, "outside holder");

    await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "hello" }] });
    const settled = await until(() => daemon.store.get(chat.id), (current) => current?.state === "error" && current.error !== null, "refused resume");

    expect(settled?.error ?? "").toContain("already open in another process");
    expect(settled?.error ?? "").toContain(`pid ${outside.pid}`);
    expect(settled?.error ?? "").toContain(`cwd ${realpathSync(env.cwd)}`);
    expect(spawned(env)).toHaveLength(0);
    await expect(daemon.handle({ operation: "mode", id: chat.id, mode: "terminal" })).rejects.toThrow("already open in another process");
  });

  test("asking for the terminal of a chat already in terminal mode changes nothing", async () => {
    const env = sandbox();
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-terminal-noop", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-terminal-noop");
    const daemon = await daemonFor(env);
    const result = await daemon.handle({ operation: "mode", id: chat.id, mode: "terminal" }) as { chat: Chat; command: string[] };
    expect(result.chat.terminalSince).toBe("2026-10-16T09:00:00.000Z");
    expect(result.command).toContain(chat.agentSessionId ?? "");
  });
});

describe("draining chatd before an upgrade", () => {
  test("close settles child cleanup before resolving and never starts another agent", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "slow" }] }) as Chat;
    await stateOf(daemon, chat.id, "working");
    await until(async () => spawned(env), (children) => children.length === 1, "agent to spawn");
    const childRecord = join(env.state, "chatd", "children", `${chat.id}.json`);

    await daemon.close();
    expect(existsSync(childRecord)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(existsSync(childRecord)).toBe(false);
    expect(spawned(env)).toHaveLength(1);
    expect(await daemon.store.get(chat.id)).toMatchObject({ state: "working" });
  });

  test("finishes the running turn, takes no new turn, hands queued messages to the next daemon and exits", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const working = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "slow" }] }) as Chat;
    await stateOf(daemon, working.id, "working");
    const waiting = record(env);
    await daemon.store.put(waiting);

    const drained = daemon.handle({ operation: "drain" }) as Promise<{ drained: boolean; resumes: string[] }>;
    await until(async () => await daemon.handle({ operation: "daemon-status" }) as { draining: boolean }, (status) => status.draining, "draining");
    const queued = await daemon.handle({ operation: "send", id: waiting.id, parts: [{ type: "text", text: "after the upgrade" }] }) as { queued: unknown };
    await expect(daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [] })).rejects.toThrow("draining");
    const result = await drained;

    expect(queued.queued).not.toBeNull();
    expect(visible(await eventsOf(daemon, working.id))).toContain("assistant:answer:slow");
    expect(visible(await eventsOf(daemon, working.id))).not.toContain("system:Interrupted");
    expect(result.resumes).toEqual([waiting.id]);
    expect(existsSync(join(env.state, "chatd", "chatd.pid"))).toBe(false);
    const childPid = Number(readFileSync(env.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line).pid).at(-1));
    expect(() => process.kill(childPid, 0)).toThrow();

    // The next daemon sends what waited, resuming that chat.
    const next = await daemonFor(env);
    await until(async () => visible(await eventsOf(next, waiting.id)), (shown) => shown.includes("assistant:answer:after the upgrade"), "queued message delivered by the new daemon");
  });

  test("a newer CLI keeps using an older but compatible chatd", async () => {
    const env = sandbox();
    const old = await daemonFor(env, {}, 1);
    const environment = environmentOf(env);
    const adapter = { startDetached: async () => ({ kind: "error", error: "embedded" }) };
    await callChatd(env.state, { operation: "list" }, environment, adapter);
    expect(existsSync(join(env.state, "chatd", "chatd.pid"))).toBe(true);
    expect((await chatdStatus(env.state)).compatible).toBe(true);
    expect(old.closed).toBe(false);
  });

  test("reconnects to a compatible daemon without cutting its live streaming turn", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "slow" }] }) as Chat;
    await stateOf(daemon, chat.id, "working");

    const listed = await callChatd(env.state, { operation: "list" }, environmentOf(env), adapterOf(env)) as Chat[];
    await stateOf(daemon, chat.id, "idle");
    const status = await chatdStatus(env.state);

    expect(listed.some((entry) => entry.id === chat.id)).toBe(true);
    expect(visible(await eventsOf(daemon, chat.id))).toContain("assistant:answer:slow");
    expect(status).toMatchObject({ compatible: true, liveChats: 0, protocol: { version: CHAT_PROTOCOL_VERSION, min: CHAT_PROTOCOL_MIN_VERSION, max: CHAT_PROTOCOL_VERSION } });
  });

  test("a compatible client can die while chatd and its agent keep streaming", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "slow" }] }) as Chat;
    await stateOf(daemon, chat.id, "working");
    const agent = await until(async () => spawned(env), (children) => children.length === 1, "agent process to start");
    const agentPid = agent[0]?.pid;
    expect(agentPid).toBeDefined();
    const socketClient = spawn(process.execPath, ["-e", `const net = require("node:net"); const socket = net.createConnection(${JSON.stringify(join(env.state, "chatd", "s"))}); socket.on("connect", () => { socket.write(JSON.stringify({ operation: "events", id: ${JSON.stringify(chat.id)}, since: 0, follow: true }) + "\\n"); process.stdout.write("connected\\n"); }); socket.on("data", () => {}); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    processes.push(socketClient);
    await new Promise<void>((resolve, reject) => {
      let output = "";
      socketClient.stdout?.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; if (output.includes("connected\n")) resolve(); });
      socketClient.once("error", reject);
      socketClient.once("exit", (code) => { if (code !== null && code !== 0) reject(new Error(`socket client exited ${code}`)); });
    });
    socketClient.kill("SIGKILL");
    await new Promise<void>((resolve) => socketClient.once("close", () => resolve()));

    expect(() => process.kill(agentPid ?? 0, 0)).not.toThrow();
    expect(existsSync(join(env.state, "chatd", "chatd.pid"))).toBe(true);
    expect(visible(await eventsOf(daemon, chat.id))).not.toContain("system:Interrupted");
    await stateOf(daemon, chat.id, "idle");
  });

  test("retire waits for chats to become idle and the next client can start a daemon", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "slow" }] }) as Chat;
    await stateOf(daemon, chat.id, "working");

    const retiring = retireChatd(env.state);
    const superseded = await until(async () => await daemon.handle({ operation: "daemon-status" }) as { superseded: boolean }, (status) => status.superseded, "superseded chatd");
    expect(superseded.superseded).toBe(true);
    await retiring;

    expect(existsSync(join(env.state, "chatd", "chatd.pid"))).toBe(false);
    const next = await daemonFor(env);
    expect(next).not.toBe(daemon);
    expect((await next.store.get(chat.id))?.state).toBe("suspended");
    expect(visible(await eventsOf(next, chat.id))).toContain("assistant:answer:slow");
  });

  test("rejects an incompatible protocol hello with the number of live chats", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "slow" }] }) as Chat;
    await stateOf(daemon, chat.id, "working");

    await expect(callChatd(env.state, { operation: "hello", protocol: { version: 99, min: 99, max: 99 } }, environmentOf(env), adapterOf(env)))
      .rejects.toMatchObject({ code: "chatd-incompatible", liveChats: 1 });
    await stateOf(daemon, chat.id, "idle");
  });

  test("a holder refusal can be retried after its holder exits, preserving the queued message", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { state: "error", error: "already open in another process", agentSessionId: "old-session" });
    const store = new ChatStore(env.state);
    await store.put(chat);
    const daemon = await daemonFor(env);
    await store.putQueue(chat.id, [{ id: randomUUID(), parts: [{ type: "text", text: "keep this" }], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
    await expect(daemon.handle({ operation: "resume", id: chat.id })).resolves.toBeDefined();
    const resumed = await until(() => store.get(chat.id), (value) => value?.state === "idle", "resumed chat");
    expect(resumed?.error).toBeNull();
    await until(async () => visible(await eventsOf(daemon, chat.id)), (shown) => shown.includes("assistant:answer:keep this"), "queued message delivered after retry");
  });

  test("chat daemon status reports a stopped daemon without starting one", async () => {
    const env = sandbox();
    const result = await executeChat(["daemon", "status", "--json"], { HOME: env.root, MEGABRAIN_STATE_DIR: env.state, PATH: environmentOf(env).PATH }, adapterOf(env));
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ running: false });
    expect(existsSync(join(env.state, "chatd", "chatd.pid"))).toBe(false);
  });
});

describe("turns cut short", () => {
  test("an agent that dies mid-turn leaves an Interrupted end, so no view shows the turn running", async () => {
    const env = sandbox();
    fakeClaude(env);
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd, parts: [{ type: "text", text: "crash" }] }) as Chat;
    const settled = await until(() => daemon.store.get(chat.id), (current) => current?.state === "suspended", "crashed chat");
    expect(settled?.state).toBe("suspended");
    const shown = visible(await eventsOf(daemon, chat.id));
    expect(shown.indexOf("system:Interrupted")).toBeGreaterThan(shown.indexOf("tool-call:Bash"));
  });

  test("a chatd that died mid-turn ends that turn on the next start", async () => {
    const env = sandbox();
    const chat = record(env, { state: "working" });
    await new ChatStore(env.state).put(chat);
    const daemon = await daemonFor(env);
    expect((await daemon.store.get(chat.id))?.state).toBe("suspended");
    expect(visible(await eventsOf(daemon, chat.id))).toContain("system:Interrupted");
  });

  test("a terminal turn imported unfinished, with no TUI left to finish it, is ended", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    linkTerminal(env, chat, "mb-app-terminal-exited");
    claudeLog(env, chat, [prompt("u1", "2026-10-16T09:01:00.000Z", "kill the port"), toolUse("a1", "2026-10-16T09:01:01.000Z")]);
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await stateOf(daemon, chat.id, "idle");
    const shown = visible(await eventsOf(daemon, chat.id));
    expect(shown.indexOf("system:Interrupted")).toBeGreaterThan(shown.indexOf("tool-call:Bash"));
  });
});

describe("a chat in terminal mode", () => {
  test("starts terminal polling only while a terminal-mode chat needs refresh", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env, { MEGABRAIN_CHAT_TERMINAL_POLL_MS: "60", MEGABRAIN_KNOWLEDGE_SCANNER: "off" });
    expect(daemon.terminalTimer).toBeUndefined();
    const chat = await daemon.handle({ operation: "start", agent: "agy", cwd: env.cwd }) as Chat;
    linkTerminal(env, chat, "mb-app-agy-poll");
    await daemon.syncTerminalPolling();
    expect(daemon.terminalTimer).toBeDefined();
    await daemon.remove(chat.id);
    expect(daemon.terminalTimer).toBeUndefined();
  });

  test("retains and exposes a terminal refresh failure while later refreshes continue", async () => {
    const env = sandbox();
    let calls = 0;
    const daemon = await daemonFor(env, { MEGABRAIN_CHAT_TERMINAL_POLL_MS: "60", MEGABRAIN_KNOWLEDGE_SCANNER: "off" });
    const chat = await daemon.startChat({ operation: "start", agent: "agy", cwd: env.cwd });
    linkTerminal(env, chat, "mb-app-agy-refresh-error");
    await daemon.syncTerminalPolling();
    daemon.refreshTerminalChats = async () => {
      calls += 1;
      if (calls === 1) throw new Error("ownership lookup failed");
    };
    let status: { terminalRefreshError?: string } = {};
    for (let attempt = 0; attempt < 80; attempt += 1) {
      status = await daemon.daemonStatus() as unknown as { terminalRefreshError?: string };
      if (status.terminalRefreshError !== undefined && calls > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(status.terminalRefreshError).toContain("ownership lookup failed");
    expect(calls).toBeGreaterThan(1);
  });

  test("runs one coalesced refresh after a periodic tick lands during an active scan", async () => {
    const env = sandbox();
    let calls = 0;
    let release = () => {};
    let markFirst = () => {};
    let markSecond = () => {};
    const first = new Promise<void>((resolve) => { markFirst = resolve; });
    const second = new Promise<void>((resolve) => { markSecond = resolve; });
    const daemon = await daemonFor(env, { MEGABRAIN_CHAT_TERMINAL_POLL_MS: "200", MEGABRAIN_KNOWLEDGE_SCANNER: "off" });
    const chat = await daemon.startChat({ operation: "start", agent: "agy", cwd: env.cwd });
    linkTerminal(env, chat, "mb-app-agy-refresh-coalesced");
    await daemon.syncTerminalPolling();
    daemon.refreshTerminalChats = async () => {
      calls += 1;
      if (calls === 1) { markFirst(); await new Promise<void>((resolve) => { release = resolve; }); }
      if (calls === 2) markSecond();
    };
    try {
      await first;
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(calls).toBe(1);
      release();
      const ranImmediately = await Promise.race([second.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50))]);
      expect(ranImmediately).toBe(true);
    } finally { release(); }
  });

  test("shows the TUI's state from the session log: working during an unfinished turn, idle at its end or when the TUI is gone", async () => {
    const env = sandbox();
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    const log = claudeLog(env, chat, [prompt("u1", "2026-10-16T09:01:00.000Z", "kill the port"), toolUse("a1", "2026-10-16T09:01:01.000Z")]);
    tuiInTmux(env, "mb-app-tui", chat.agentSessionId ?? "");
    linkTerminal(env, chat, "mb-app-tui");
    const daemon = await daemonFor(env, { MEGABRAIN_CHAT_TERMINAL_POLL_MS: "40" });

    await stateOf(daemon, chat.id, "working");
    appendFileSync(log, `${JSON.stringify(endTurn("a2", "2026-10-16T09:01:05.000Z"))}\n`);
    await stateOf(daemon, chat.id, "idle");

    appendFileSync(log, `${JSON.stringify(prompt("u2", "2026-10-16T09:02:00.000Z", "again"))}\n`);
    await stateOf(daemon, chat.id, "working");
    spawnSync(REAL_TMUX, ["-L", env.server, "kill-session", "-t", "=mb-app-tui"]);
    await stateOf(daemon, chat.id, "idle");
  });
});
