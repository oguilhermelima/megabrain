import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { claudeLogPath, parseClaudeLog, parseCodexRollout } from "../../src/chat/session-log.js";
import { ChatStore, type Chat, type ChatEvent } from "../../src/chat/store.js";

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ID = "7c1f0c52-8f5e-4d1e-9a55-0d3f2b6a1e22";
const CLAUDE_LOG = readFileSync(join(import.meta.dir, "../fixtures/chat-session/claude-session.jsonl"), "utf8");
const CONTEXT_LOG = readFileSync(join(import.meta.dir, "../fixtures/chat-claude-context-zero.jsonl"), "utf8");
const CODEX_LOG = readFileSync(join(import.meta.dir, "../fixtures/chat-session/codex-rollout.jsonl"), "utf8");
const SWITCHED_AT = "2026-10-16T10:05:00.000Z";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-turns-"));
  directories.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(bin);
  return { root, state, cwd, bin, sessionId: `recorded-${randomUUID()}` };
}
type Env = ReturnType<typeof sandbox>;

function fakeAgent(bin: string, name: string, body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
}

// Stream-json Claude that answers every line and keeps the session id it was resumed from.
const FAKE_CLAUDE = `
const readline = require("node:readline");
const argv = process.argv.slice(2);
const at = argv.indexOf("--resume");
const session = at === -1 ? "fresh-session" : argv[at + 1];
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const text = JSON.parse(line).message.content.map((part) => part.text).join("");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m" + Date.now(), content: [{ type: "text", text: "answer:" + text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: session, is_error: false }) + "\\n");
});
`;

const FAKE_CODEX = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/resume") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId } } }) + "\\n");
});
`;

function record(env: Env, overrides: Partial<Chat> = {}): Chat {
  return {
    id: ID, agent: "claude", model: null, cwd: env.cwd, title: "remember", state: "idle", mode: "terminal",
    agentSessionId: env.sessionId, createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: SWITCHED_AT, terminalSince: SWITCHED_AT, ...overrides,
  };
}

function writeClaudeLog(env: Env, content = CLAUDE_LOG) {
  const path = claudeLogPath(env.root, env.cwd, env.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.replaceAll("recorded-session", env.sessionId));
}
function writeCodexLog(env: Env) {
  const dir = join(env.root, ".codex", "sessions", "2026", "10", "16");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-2026-10-16T10-00-00-thread-9.jsonl"), CODEX_LOG);
}

async function daemonFor(env: Env): Promise<ChatDaemon> {
  const environment = { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  const daemon = new ChatDaemon(env.state, environment);
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  return daemon;
}

async function waitState(daemon: ChatDaemon, state: string): Promise<Chat> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const chat = await daemon.store.get(ID);
    if (chat?.state === state) return chat;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`chat did not reach ${state}: ${JSON.stringify(await daemon.store.get(ID))}`);
}
async function events(daemon: ChatDaemon): Promise<ChatEvent[]> {
  return (await daemon.store.events(ID)).flatMap((line) => line.event === undefined ? [] : [line.event]);
}
async function untilEvent(daemon: ChatDaemon, predicate: (event: ChatEvent) => boolean, what: string): Promise<ChatEvent> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const found = (await events(daemon)).find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`terminal log did not follow ${what}`);
}
async function untilCursor(daemon: ChatDaemon, path: string, messageId: string): Promise<void> {
  const byteOffset = readFileSync(path).byteLength;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const cursor = (await daemon.store.get(ID) as (Chat & { terminalLogCursor?: { byteOffset: number; lastMessageId: string | null } }) | null)?.terminalLogCursor;
    if (cursor?.byteOffset === byteOffset && cursor.lastMessageId === messageId) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`terminal log cursor did not advance to ${messageId}`);
}
const shown = (list: ChatEvent[]) => list.filter((item) => item.kind !== "state" && item.kind !== "system").map((item) => `${item.kind}:${item.text}`);
const TERMINAL_TURNS = [
  "user:typed in terminal",
  "thinking:pondering the files",
  "tool-call:Bash",
  "tool-result:notes.txt\n",
  "assistant:found notes.txt",
  "user:second typed message with two parts",
  "assistant:second answer",
];

describe("the Claude session log", () => {
  test("lives under the cwd with every non-alphanumeric character as a dash", () => {
    expect(claudeLogPath("/h", "/Users/me/.work/app 2", "abc")).toBe("/h/.claude/projects/-Users-me--work-app-2/abc.jsonl");
  });

  test("parses user, thinking, tool call, tool result and assistant entries in order, each with its entry uuid", () => {
    const parsed = parseClaudeLog(CLAUDE_LOG);
    expect(parsed.map((item) => item.sourceId)).toEqual(["u1", "a0", "u2", "a1", "a2", "u3", "a3", "u4", "a4"]);
    const terminal = parsed.filter((item) => item.at > SWITCHED_AT);
    expect(terminal.map((item) => `${item.kind}:${item.text}`)).toEqual(TERMINAL_TURNS);
    expect(terminal[2]?.tool).toEqual({ name: "Bash", input: JSON.stringify({ command: "ls /home/user/project" }) });
    expect(terminal[3]?.tool).toEqual({ name: "Bash", status: "ok" });
  });

  test("skips sidechains, meta messages, attachments and bookkeeping lines, and survives a half-written last line", () => {
    const texts = parseClaudeLog(`${CLAUDE_LOG}{"type":"assistant","uuid":"cut`).map((item) => item.text);
    expect(texts).not.toContain("sidechain noise");
    expect(texts.join("")).not.toContain("local-command-caveat");
    expect(texts).toHaveLength(9);
  });
});

describe("the Codex rollout", () => {
  test("parses messages, reasoning, tool calls and outputs and skips developer text and bookkeeping", () => {
    const parsed = parseCodexRollout(CODEX_LOG);
    expect(parsed.filter((item) => item.at > SWITCHED_AT).map((item) => `${item.kind}:${item.text}`)).toEqual([
      "user:typed in terminal", "thinking:pondering the files", "tool-call:shell", "tool-result:notes.txt\n", "assistant:found notes.txt",
    ]);
    expect(new Set(parsed.map((item) => item.sourceId)).size).toBe(parsed.length);
  });
});

describe("switching back to chat imports what the terminal did", () => {
  test("follows appended Claude messages and tool events while the terminal owns the session, once each", async () => {
    const env = sandbox();
    writeClaudeLog(env, "");
    const chat = record(env, { terminalSince: SWITCHED_AT });
    await new ChatStore(env.state).put(chat);
    const daemon = await daemonFor(env);
    const path = claudeLogPath(env.root, env.cwd, env.sessionId);
    const now = new Date().toISOString();
    const rows = [
      { type: "user", uuid: "follow-u1", timestamp: now, message: { role: "user", content: "look up a file" } },
      { type: "assistant", uuid: "follow-a1", timestamp: now, message: { id: "follow-m1", stop_reason: "tool_use", content: [{ type: "tool_use", id: "follow-tool", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", uuid: "follow-u2", timestamp: now, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "follow-tool", content: "file.txt" }] } },
      { type: "assistant", uuid: "follow-a2", timestamp: now, message: { id: "follow-m2", stop_reason: "end_turn", content: [{ type: "text", text: "found it" }] } },
    ];

    appendFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await untilEvent(daemon, (item) => item.text === "found it", "Claude events");
    await daemon.refreshTerminalChats();

    expect(shown(await events(daemon))).toEqual(["user:look up a file", "tool-call:Bash", "tool-result:file.txt", "assistant:found it"]);
  });

  test("persists the terminal log cursor and catches up after chatd restarts", async () => {
    const env = sandbox();
    writeClaudeLog(env, "");
    const chat = record(env, { terminalSince: SWITCHED_AT });
    const store = new ChatStore(env.state);
    await store.put(chat);
    const daemon = await daemonFor(env);
    await daemon.refreshTerminalChats();
    const path = claudeLogPath(env.root, env.cwd, env.sessionId);
    const at = new Date().toISOString();
    const firstRows = [
      { type: "user", uuid: "cursor-u1", timestamp: at, message: { role: "user", content: "first terminal turn" } },
      { type: "assistant", uuid: "cursor-a1", timestamp: at, message: { id: "cursor-message-1", stop_reason: "end_turn", content: [{ type: "text", text: "first answer" }] } },
    ];
    appendFileSync(path, `${firstRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await untilEvent(daemon, (item) => item.text === "first answer", "the first terminal turn");
    await untilCursor(daemon, path, "cursor-message-1");

    const cursor = (await store.get(ID) as (Chat & { terminalLogCursor?: { byteOffset: number; lastMessageId: string | null } }) | null)?.terminalLogCursor;
    expect(cursor).toEqual({ byteOffset: readFileSync(path).byteLength, lastMessageId: "cursor-message-1" });
    await daemon.close();

    const laterRows = [
      { type: "user", uuid: "cursor-u2", timestamp: at, message: { role: "user", content: "second terminal turn" } },
      { type: "assistant", uuid: "cursor-a2", timestamp: at, message: { id: "cursor-message-2", stop_reason: "end_turn", content: [{ type: "text", text: "second answer" }] } },
    ];
    appendFileSync(path, `${laterRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const restarted = await daemonFor(env);
    await untilEvent(restarted, (item) => item.text === "second answer", "the terminal turn written while chatd was stopped");
    await untilCursor(restarted, path, "cursor-message-2");

    expect(shown(await events(restarted))).toEqual(["user:first terminal turn", "assistant:first answer", "user:second terminal turn", "assistant:second answer"]);
    const updated = (await store.get(ID) as (Chat & { terminalLogCursor?: { byteOffset: number; lastMessageId: string | null } }) | null)?.terminalLogCursor;
    expect(updated).toEqual({ byteOffset: readFileSync(path).byteLength, lastMessageId: "cursor-message-2" });
  });

  test("follows appended Codex rollout events while the terminal owns the thread, once each", async () => {
    const env = sandbox();
    writeCodexLog(env);
    const chat = record(env, { agent: "codex", agentSessionId: "thread-9", terminalSince: SWITCHED_AT });
    await new ChatStore(env.state).put(chat);
    const daemon = await daemonFor(env);
    const path = join(env.root, ".codex", "sessions", "2026", "10", "16", "rollout-2026-10-16T10-00-00-thread-9.jsonl");
    const at = new Date().toISOString();
    appendFileSync(path, `${JSON.stringify({ timestamp: at, ordinal: 10, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "open another file" }] } })}\n${JSON.stringify({ timestamp: at, ordinal: 11, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "opened it" }] } })}\n`);

    await untilEvent(daemon, (item) => item.text === "opened it", "Codex events");
    await daemon.refreshTerminalChats();

    expect(shown(await events(daemon))).toEqual([
      "user:typed in terminal", "thinking:pondering the files", "tool-call:shell", "tool-result:notes.txt\n", "assistant:found notes.txt",
      "user:open another file", "assistant:opened it",
    ]);
  });

  test("restores missing context from the latest real Claude request, ignoring synthetic usage", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env, CONTEXT_LOG);
    await new ChatStore(env.state).put(record(env, { contextTokens: 0, contextWindow: 1000000, terminalSince: "2026-10-17T15:52:00.000Z" }));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    const resumed = await waitState(daemon, "idle");
    expect(resumed).toMatchObject({ contextTokens: 250074, contextWindow: 1000000 });
  });

  test("restores missing context when resuming a chat from its session log", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env, CONTEXT_LOG);
    await new ChatStore(env.state).put(record(env, { mode: "chat", state: "suspended", terminalSince: undefined, contextTokens: 0, contextWindow: 1000000 }));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "resume", id: ID });
    const resumed = await waitState(daemon, "idle");
    expect(resumed).toMatchObject({ contextTokens: 250074, contextWindow: 1000000 });
  });

  test("Claude: every terminal turn lands in the chat, in order, and nothing from before the switch is repeated", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    expect(shown(await events(daemon))).toEqual(TERMINAL_TURNS);
  });

  test("an imported event keeps the time the terminal turn happened", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    expect((await events(daemon)).find((item) => item.text === "typed in terminal")?.at).toBe("2026-10-16T10:06:00.000Z");
  });

  test("switching again, even with the same marker, never shows a turn twice", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env);
    const store = new ChatStore(env.state);
    await store.put(record(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    await store.put({ ...(await store.get(ID) as Chat), mode: "terminal", state: "idle" });
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    expect(shown(await events(daemon))).toEqual(TERMINAL_TURNS);
  });

  test("concurrent refreshes import each terminal event once", async () => {
    const env = sandbox();
    writeClaudeLog(env);
    const chat = record(env);
    await new ChatStore(env.state).put(chat);
    const daemon = await daemonFor(env);
    await Promise.all([
      daemon.importTerminalTurns(chat, false),
      daemon.importTerminalTurns(chat, false),
    ]);

    expect(shown(await events(daemon))).toEqual(TERMINAL_TURNS);
  });

  test("a second visit imports only the turns written since the first", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env);
    const daemon = await daemonFor(env);
    await new ChatStore(env.state).put(record(env));
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    await daemon.handle({ operation: "mode", id: ID, mode: "terminal" });
    const later = `${JSON.stringify({ parentUuid: null, isSidechain: false, type: "user", uuid: "u9", timestamp: new Date(Date.now() + 1000).toISOString(), sessionId: env.sessionId, message: { role: "user", content: "third visit" } })}\n`;
    writeClaudeLog(env, CLAUDE_LOG + later);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    expect(shown(await events(daemon))).toEqual([...TERMINAL_TURNS, "user:third visit"]);
  });

  test("a missing session log changes nothing and does not stop the switch", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    expect(shown(await events(daemon))).toEqual([]);
  });

  test("Codex: the rollout's terminal turns land in the chat", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "codex", FAKE_CODEX);
    writeCodexLog(env);
    await new ChatStore(env.state).put(record(env, { agent: "codex", agentSessionId: "thread-9" }));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    expect(shown(await events(daemon))).toEqual(["user:typed in terminal", "thinking:pondering the files", "tool-call:shell", "tool-result:notes.txt\n", "assistant:found notes.txt"]);
  });

  test("the imported turns are in place before the chat reports starting, so a follower never sees a gap", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    writeClaudeLog(env);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    const all = await events(daemon);
    const starting = all.findIndex((item) => item.kind === "state" && item.text === "starting");
    const lastImported = all.findIndex((item) => item.text === "second answer");
    expect(lastImported).toBeGreaterThan(-1);
    expect(starting).toBeGreaterThan(lastImported);
  });
});

describe("state across switches", () => {
  test("the terminal marker is the switch time, and the chat is idle on both sides of the switch", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    const daemon = await daemonFor(env);
    await new ChatStore(env.state).put(record(env, { mode: "chat", terminalSince: undefined }));
    const before = Date.now();
    const result = await daemon.handle({ operation: "mode", id: ID, mode: "terminal" }) as { chat: Chat };
    expect(result.chat).toMatchObject({ mode: "terminal", state: "idle" });
    expect(Date.parse(result.chat.terminalSince ?? "")).toBeGreaterThanOrEqual(before);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    expect(await waitState(daemon, "idle")).toMatchObject({ mode: "chat" });
  });

  test("no state event after a switch carries a timestamp from an earlier turn", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    const daemon = await daemonFor(env);
    await new ChatStore(env.state).put(record(env, { mode: "chat", terminalSince: undefined }));
    await daemon.handle({ operation: "send", id: ID, parts: [{ type: "text", text: "one" }] });
    await waitState(daemon, "idle");
    const firstTurn = (await events(daemon)).find((item) => item.kind === "state" && item.text === "working")?.turnStartedAt;
    expect(firstTurn).toBeDefined();
    await daemon.handle({ operation: "mode", id: ID, mode: "terminal" });
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    await waitState(daemon, "idle");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sentAt = Date.now();
    await daemon.handle({ operation: "send", id: ID, parts: [{ type: "text", text: "two" }] });
    await waitState(daemon, "idle");
    const states = (await events(daemon)).filter((item) => item.kind === "state");
    const afterSwitch = states.slice(states.map((item) => item.text).lastIndexOf("starting"));
    for (const item of afterSwitch) {
      if (item.text === "working") expect(Date.parse(item.turnStartedAt ?? "")).toBeGreaterThanOrEqual(sentAt);
      else expect(item.turnStartedAt).toBeUndefined();
    }
    expect(afterSwitch.some((item) => item.text === "working")).toBe(true);
  });
});

describe("switching to the terminal", () => {
  test("the answer carries the command that opens the agent's TUI, the same one terminal-command returns", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    const daemon = await daemonFor(env);
    await new ChatStore(env.state).put(record(env, { mode: "chat", terminalSince: undefined }));
    const result = await daemon.handle({ operation: "mode", id: ID, mode: "terminal" }) as { command: string[] | null };
    expect(result.command).toEqual(await daemon.handle({ operation: "terminal-command", id: ID }) as string[]);
    expect(result.command?.slice(0, 3)).toEqual(["claude", "--resume", env.sessionId]);
  });

  test("a chat with no agent session yet opens a fresh TUI", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env);
    await new ChatStore(env.state).put(record(env, { mode: "chat", terminalSince: undefined, agentSessionId: null }));
    const result = await daemon.handle({ operation: "mode", id: ID, mode: "terminal" }) as { command: string[] | null; chat: Chat };
    expect(result).toMatchObject({ command: ["claude", "--dangerously-skip-permissions"], chat: { mode: "terminal" } });
  });
});

describe("the event cursor", () => {
  test("counts on without gaps or repeats, also for a store that opens the file later", async () => {
    const env = sandbox();
    mkdirSync(join(env.state, "chats", ID), { recursive: true });
    const first = new ChatStore(env.state);
    const make = (text: string): ChatEvent => ({ id: text, at: new Date().toISOString(), kind: "user", text });
    const cursors = [(await first.append(ID, make("a"))).cursor, (await first.append(ID, make("b"))).cursor, (await first.append(ID, make("c"))).cursor];
    cursors.push((await new ChatStore(env.state).append(ID, make("d"))).cursor);
    expect(cursors).toEqual(["1", "2", "3", "4"]);
    expect((await first.events(ID)).map((line) => line.cursor)).toEqual(["1", "2", "3", "4"]);
  });
});
