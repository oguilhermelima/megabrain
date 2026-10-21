import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";
import { ChatDaemon, CHAT_PROTOCOL_MIN_VERSION, CHAT_PROTOCOL_VERSION } from "../../src/chat/daemon.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ID = "7c1f0c52-8f5e-4d1e-9a55-0d3f2b6a1e11";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-resume-"));
  directories.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(bin);
  return { root, state, cwd, bin, capture: join(root, "capture.jsonl"), pids: join(root, "pids.txt") };
}
type Env = ReturnType<typeof sandbox>;

function fakeAgent(bin: string, name: "claude" | "codex", body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
}

// Records argv and pid, then behaves like stream-json Claude: the session id is the one it was resumed from.
const FAKE_CLAUDE = `
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const argv = process.argv.slice(2);
appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify({ argv }) + "\\n");
appendFileSync(process.env.CHAT_PIDS, process.pid + "\\n");
const resumeAt = argv.indexOf("--resume");
const session = resumeAt === -1 ? "fresh-session" : argv[resumeAt + 1];
if (process.env.CHAT_FAIL_RESUME && resumeAt !== -1) { process.stderr.write("No conversation found with session ID: " + session + "\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: session }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line);
  const text = input.message.content.map((part) => part.text).join("");
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify({ user: text }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "m" + Date.now(), content: [{ type: "text", text: "answer:" + text }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: session, is_error: false }) + "\\n");
});
`;

const FAKE_CODEX = `
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start" || request.method === "thread/resume") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId ?? "new-thread" } } }) + "\\n");
  if (request.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "t1" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/started", params: { turnId: "t1" } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\\n");
  }
});
`;

function environment(env: Env): Record<string, string> {
  return { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: env.capture, CHAT_PIDS: env.pids };
}

function record(env: Env, overrides: Partial<Chat> = {}): Chat {
  return {
    id: ID, agent: "claude", model: null, cwd: env.cwd, title: "remember", state: "idle", mode: "chat",
    agentSessionId: "recorded-session", createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), ...overrides,
  };
}

async function daemonFor(env: Env, extra: Record<string, string> = {}): Promise<ChatDaemon> {
  const daemon = new ChatDaemon(env.state, { ...environment(env), ...extra });
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

async function waitForCapturedMethod(env: Env, method: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (captured(env).some((row) => row.method === method)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Codex did not receive ${method}`);
}

async function waitForCompletedTurn(daemon: ChatDaemon): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const states = (await eventTexts(daemon)).filter((value) => value.startsWith("state:"));
    const started = states.indexOf("state:working");
    if (started !== -1 && states.slice(started + 1).includes("state:idle")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Codex turn did not return to idle after starting");
}

async function waitForClaudeTurn(daemon: ChatDaemon, text: string): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const events = (await daemon.store.events(ID)).flatMap((line) => line.event === undefined ? [] : [line.event]);
    const user = events.findIndex((event) => event.kind === "user" && event.text === text);
    const answer = events.findIndex((event, index) => index > user && event.kind === "assistant" && event.text === `answer:${text}`);
    const working = events.findIndex((event, index) => index > user && event.kind === "state" && event.text === "working");
    if (user !== -1 && answer > user && working > user && events.slice(working + 1).some((event) => event.kind === "state" && event.text === "idle")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Claude did not complete the turn for ${text}`);
}

function captured(env: Env): Array<Record<string, unknown>> {
  return existsSync(env.capture) ? readFileSync(env.capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}
const send = (daemon: ChatDaemon, text: string, extra: Record<string, unknown> = {}) => daemon.handle({ operation: "send", id: ID, parts: [{ type: "text", text }], ...extra });
async function eventTexts(daemon: ChatDaemon): Promise<string[]> {
  return (await daemon.store.events(ID)).flatMap((line) => line.event === undefined ? [] : [`${line.event.kind}:${line.event.text}`]);
}

describe("chats survive a daemon restart", () => {
  test.each(["idle", "working", "waiting-approval", "starting"] as const)("a %s chat becomes suspended and keeps its session id", async (state) => {
    const env = sandbox();
    await new ChatStore(env.state).put(record(env, { state }));
    const daemon = await daemonFor(env);
    expect(await daemon.store.get(ID)).toMatchObject({ state: "suspended", agentSessionId: "recorded-session", error: null });
  });

  test("a turn cut by the restart is marked interrupted in the transcript; an idle one is not", async () => {
    const env = sandbox();
    await new ChatStore(env.state).put(record(env, { state: "working" }));
    const daemon = await daemonFor(env);
    expect(await eventTexts(daemon)).toContain("system:Interrupted");
    daemons.pop();
    await daemon.close();
    const idle = sandbox();
    await new ChatStore(idle.state).put(record(idle, { state: "idle" }));
    const quiet = await daemonFor(idle);
    expect(await eventTexts(quiet)).not.toContain("system:Interrupted");
  });

  test("every background task left running is killed when the daemon restarts", async () => {
    const env = sandbox();
    const store = new ChatStore(env.state);
    await store.put(record(env, { state: "idle" }));
    for (const [id, kind] of [["shell-1", "shell"], ["monitor-1", "monitor"], ["agent-1", "agent"]] as const) {
      await store.append(ID, { id: `task-${id}`, at: new Date().toISOString(), kind: "background-task", text: id, backgroundTask: { id, kind, label: id, state: "running", startedAt: new Date().toISOString() } });
    }
    const daemon = await daemonFor(env);
    const tasks = (await daemon.store.events(ID)).flatMap((line) => line.event?.backgroundTask ? [line.event.backgroundTask] : []);
    expect(tasks.map((task) => [task.id, task.state])).toEqual([["shell-1", "running"], ["monitor-1", "running"], ["agent-1", "running"], ["shell-1", "killed"], ["monitor-1", "killed"], ["agent-1", "killed"]]);
    expect(tasks.slice(-3).map(({ endedAt, summary }) => [endedAt, summary])).toEqual(expect.arrayContaining([[expect.any(String), "agent process ended"], [expect.any(String), "agent process ended"], [expect.any(String), "agent process ended"]]));
  });

  test("a send to a suspended Claude chat respawns it with --resume and the recorded id, then delivers the message", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env, { state: "working" }));
    const daemon = await daemonFor(env);
    await send(daemon, "which word?");
    const chat = await waitState(daemon, "idle");
    expect(chat.agentSessionId).toBe("recorded-session");
    const launches = captured(env).flatMap((row) => Array.isArray(row.argv) ? [row.argv as string[]] : []);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.slice(launches[0].indexOf("--resume"), launches[0].indexOf("--resume") + 2)).toEqual(["--resume", "recorded-session"]);
    expect(launches[0]).toContain("stream-json");
    expect(captured(env)).toContainEqual({ user: "which word?" });
    const texts = await eventTexts(daemon);
    expect(texts).toContain("assistant:answer:which word?");
    const states = texts.filter((text) => text.startsWith("state:"));
    expect(states.slice(-3)).toEqual(["state:starting", "state:working", "state:idle"]);
  });

  test("a send to a suspended Codex chat resumes the recorded thread", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "codex", FAKE_CODEX);
    await new ChatStore(env.state).put(record(env, { agent: "codex", state: "idle", agentSessionId: "thread-9" }));
    const daemon = await daemonFor(env);
    await send(daemon, "continue");
    await waitForCapturedMethod(env, "turn/start");
    await waitForCompletedTurn(daemon);
    const methods = captured(env).map((row) => row.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(captured(env).find((row) => row.method === "thread/resume")).toMatchObject({ params: { threadId: "thread-9" } });
    expect(captured(env).find((row) => row.method === "turn/start")).toMatchObject({ params: { threadId: "thread-9" } });
  });

  test("an explicit stop leaves the chat resumable from the same composer", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await send(daemon, "one");
    await waitForClaudeTurn(daemon, "one");
    await daemon.handle({ operation: "stop", id: ID });
    expect(await daemon.store.get(ID)).toMatchObject({ state: "suspended", agentSessionId: "recorded-session" });
    await send(daemon, "two");
    await waitForClaudeTurn(daemon, "two");
    expect(captured(env)).toContainEqual({ user: "two" });
  });

  test("a legacy stopped record with a session id also resumes on send", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    const store = new ChatStore(env.state);
    await store.put(record(env, { state: "stopped" }));
    const daemon = new ChatDaemon(env.state, environment(env));
    daemons.push(daemon);
    await daemon.start();
    await send(daemon, "hello again");
    await waitState(daemon, "idle");
    expect(captured(env)).toContainEqual({ user: "hello again" });
  });

  test("a failed launch with no session retries on send and clears its stale error", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env, { state: "error", error: "spawn E2BIG", agentSessionId: null }));
    const daemon = await daemonFor(env);

    await send(daemon, "try again");
    await waitForClaudeTurn(daemon, "try again");

    expect(await daemon.store.get(ID)).toMatchObject({ state: "idle", error: null, agentSessionId: "fresh-session" });
    expect(captured(env)).toContainEqual({ user: "try again" });
    expect(captured(env).filter((row) => Array.isArray(row.argv))).toHaveLength(1);
  });

  test("a failed resume leaves the chat suspended with the error, and the message is not replayed on a fresh start", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env, { CHAT_FAIL_RESUME: "1" });
    await send(daemon, "first try");
    const failedChat = await waitState(daemon, "suspended");
    expect(failedChat.error).toContain("No conversation found");
    expect(failedChat.agentSessionId).toBe("recorded-session");
    expect(captured(env).filter((row) => "user" in row)).toHaveLength(0);

    await send(daemon, "second try", { fresh: true });
    const fresh = await waitState(daemon, "idle");
    expect(fresh.agentSessionId).toBe("fresh-session");
    expect(fresh.error).toBeNull();
    const launches = captured(env).flatMap((row) => Array.isArray(row.argv) ? [row.argv as string[]] : []);
    expect(launches.at(-1)).not.toContain("--resume");
    expect(captured(env).filter((row) => "user" in row)).toEqual([{ user: "second try" }]);
  });

  test("remove still deletes a suspended chat", async () => {
    const env = sandbox();
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await daemon.handle({ operation: "remove", id: ID });
    expect(await daemon.store.get(ID)).toBeNull();
  });
});

describe("chatd protocol handover", () => {
  const detachFails: ProcessAdapter = {
    async run(command) { return failed(`${command} unavailable`); },
    async startDetached(command) { return failed(`${command} unexpectedly detached`); },
    invocationCount() { return 0; },
  };
  const list = (env: Env) => route(["chat", "list", "--json"], { environment: { ...environment(env), MEGABRAIN_STATE_DIR: env.state }, processAdapter: detachFails });

  test("the handshake reports the protocol version", async () => {
    const env = sandbox();
    const daemon = await daemonFor(env);
    expect(await daemon.handle({ operation: "hello" })).toMatchObject({
      protocol: { version: CHAT_PROTOCOL_VERSION, min: CHAT_PROTOCOL_MIN_VERSION, max: CHAT_PROTOCOL_VERSION },
      daemonVersion: expect.any(String),
      liveChats: 0,
    });
    expect(CHAT_PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  test("a client whose version matches keeps the running daemon and its agent processes", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env));
    const daemon = await daemonFor(env);
    await send(daemon, "go");
    await waitState(daemon, "idle");
    const pid = Number(readFileSync(env.pids, "utf8").trim().split("\n").at(-1));
    expect((await list(env)).kind).toBe("ok");
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await daemon.store.get(ID)).toMatchObject({ state: "idle" });
  });

  test("a newer client keeps using a compatible older daemon without suspending its chats", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", FAKE_CLAUDE);
    await new ChatStore(env.state).put(record(env));
    const old = new ChatDaemon(env.state, environment(env), CHAT_PROTOCOL_VERSION - 1);
    await old.start();
    await old.listen();
    daemons.push(old);
    await send(old, "go");
    await waitState(old, "idle");
    const pid = Number(readFileSync(env.pids, "utf8").trim().split("\n").at(-1));
    const listed = await list(env);
    expect(listed.kind).toBe("ok");
    if (listed.kind === "ok") expect(JSON.parse(listed.value)).toContainEqual(expect.objectContaining({ id: ID, state: "idle", agentSessionId: "recorded-session" }));
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(await old.store.get(ID)).toMatchObject({ state: "idle" });
  });

  test("handover waits for a working chat and reports it when the bound runs out", async () => {
    const env = sandbox();
    await new ChatStore(env.state).put(record(env, { state: "idle" }));
    const daemon = await daemonFor(env, { MEGABRAIN_CHATD_HANDOVER_TIMEOUT_MS: "150" });
    const chat = (await daemon.store.get(ID)) as Chat;
    await daemon.store.put({ ...chat, state: "working" });
    const started = Date.now();
    const result = await daemon.handle({ operation: "handover" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(result).toMatchObject({ handedOver: true, interrupted: [ID] });
    expect(await daemon.store.get(ID)).toMatchObject({ state: "suspended" });
    expect(await eventTexts(daemon)).toContain("system:Interrupted");
    expect(existsSync(join(env.state, "chatd", "s"))).toBe(false);
  });
});
