import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { callChatd, ChatDaemon, CHAT_PROTOCOL_VERSION } from "../../src/chat/daemon.js";
import { claudeLogPath } from "../../src/chat/session-log.js";
import { ChatStore, type Chat, type ChatEvent } from "../../src/chat/store.js";
import { upsertConversation } from "../../src/core/conversations.js";
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
  test("switching a terminal chat back to chat ends all three app terminals resuming its session before the agent resumes", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    upsertConversation(env.state, `claude:${chat.agentSessionId}`, { owner: "app-chat", cwd: env.cwd, aliases: { chatId: chat.id, tmux: "megabrain-app:mb-app-aliased", pid: null, dispatchId: null }, createdAt: chat.createdAt, hidden: false });
    tuiInTmux(env, "mb-app-aliased", chat.agentSessionId ?? "");
    tuiInTmux(env, "mb-app-earlier", chat.agentSessionId ?? "");
    tuiInTmux(env, "mb-app-oldest", chat.agentSessionId ?? "");
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await stateOf(daemon, chat.id, "idle");
    // Claude is idle as soon as it runs; its first line of output comes after.
    await until(async () => spawned(env), (list) => list.length > 0, "the resumed agent");

    expect(hasSession(env, "mb-app-aliased")).toBe(false);
    expect(hasSession(env, "mb-app-earlier")).toBe(false);
    expect(hasSession(env, "mb-app-oldest")).toBe(false);
    expect(spawned(env)).toHaveLength(1);
    const holders = await liveSessionHolders("claude", chat.agentSessionId ?? "", { home: env.root, processes: adapterOf(env) });
    expect(holders.map((holder) => holder.pid)).toEqual([spawned(env)[0]?.pid ?? -1]);
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
    await stateOf(daemon, chat.id, "idle");

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
    tuiInTmux(env, "mb-app-working", chat.agentSessionId ?? "");
    const path = claudeLogPath(env.root, env.cwd, chat.agentSessionId ?? "");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), message: { role: "user", content: "still working" } })}\n`);
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "continue" }] });
    await stateOf(daemon, chat.id, "working");
    expect(spawned(env)).toHaveLength(0);
    writeFileSync(path, `${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { id: "m1", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } })}\n`);
    await stateOf(daemon, chat.id, "idle");

    expect(hasSession(env, "mb-app-working")).toBe(false);
    expect(spawned(env)).toHaveLength(1);
    expect(spawned(env)[0]?.argv).toContain(chat.agentSessionId);
  });

  test("switching back to chat records a non-empty TUI composer line before closing its terminal", async () => {
    const env = sandbox();
    fakeClaude(env);
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    tuiInTmux(env, "mb-app-draft", chat.agentSessionId ?? "");
    const daemon = await daemonFor(env);

    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await stateOf(daemon, chat.id, "idle");

    expect(await eventsOf(daemon, chat.id)).toContainEqual(expect.objectContaining({ kind: "system", text: "Unsent text from the terminal: unsent words" }));
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
    const settled = await until(() => daemon.store.get(chat.id), (current) => current?.state === "suspended" && current.error !== null, "refused resume");

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
    const daemon = await daemonFor(env);
    const result = await daemon.handle({ operation: "mode", id: chat.id, mode: "terminal" }) as { chat: Chat; command: string[] };
    expect(result.chat.terminalSince).toBe("2026-10-16T09:00:00.000Z");
    expect(result.command).toContain(chat.agentSessionId ?? "");
  });
});

describe("draining chatd before an upgrade", () => {
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

    // The next daemon sends what waited, resuming that chat.
    const next = await daemonFor(env);
    await until(async () => visible(await eventsOf(next, waiting.id)), (shown) => shown.includes("assistant:answer:after the upgrade"), "queued message delivered by the new daemon");
  });

  test("a newer CLI asks an older chatd to drain instead of handing over", async () => {
    const env = sandbox();
    const old = await daemonFor(env, {}, 1);
    const environment = environmentOf(env);
    const adapter = { startDetached: async () => ({ kind: "error", error: "embedded" }) };
    await callChatd(env.state, { operation: "list" }, environment, adapter);
    await until(async () => existsSync(join(env.state, "chatd", "chatd.pid")), (present) => !present, "older chatd left");
    expect(old.store).toBeDefined();
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
    claudeLog(env, chat, [prompt("u1", "2026-10-16T09:01:00.000Z", "kill the port"), toolUse("a1", "2026-10-16T09:01:01.000Z")]);
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await stateOf(daemon, chat.id, "idle");
    const shown = visible(await eventsOf(daemon, chat.id));
    expect(shown.indexOf("system:Interrupted")).toBeGreaterThan(shown.indexOf("tool-call:Bash"));
  });
});

describe("a chat in terminal mode", () => {
  test("shows the TUI's state from the session log: working during an unfinished turn, idle at its end or when the TUI is gone", async () => {
    const env = sandbox();
    const chat = record(env, { mode: "terminal", state: "idle", terminalSince: "2026-10-16T09:00:00.000Z" });
    await new ChatStore(env.state).put(chat);
    const log = claudeLog(env, chat, [prompt("u1", "2026-10-16T09:01:00.000Z", "kill the port"), toolUse("a1", "2026-10-16T09:01:01.000Z")]);
    tuiInTmux(env, "mb-app-tui", chat.agentSessionId ?? "");
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
