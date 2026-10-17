import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";
import { ChatDaemon } from "../../src/chat/daemon.js";
import type { Chat, ChatLine } from "../../src/chat/store.js";

// The queue of a native chat: a message sent while a turn runs waits in the daemon, persisted beside
// the chat's events, and goes out as the next turn when the running one ends, one per turn.

type Part = { type: "text"; text: string } | { type: "image"; path: string };
type Item = { id: string; parts: Part[]; createdAt: string; updatedAt: string };

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
/** Pids of live processes whose command line mentions the directory (the fake agents run from it). */
function processesIn(directory: string): number[] {
  const found = spawnSync("pgrep", ["-f", directory], { encoding: "utf8" });
  return found.stdout.split("\n").filter(Boolean).map(Number).filter((pid) => pid !== process.pid);
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  const leaked: string[] = [];
  for (const directory of directories.splice(0)) {
    let pids = processesIn(directory);
    for (let attempt = 0; attempt < 50 && pids.length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      pids = processesIn(directory);
    }
    for (const pid of pids) { leaked.push(`${pid} in ${directory}`); try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    rmSync(directory, { recursive: true, force: true });
  }
  expect(leaked).toEqual([]);
});

const processAdapter: ProcessAdapter = {
  async run(command) { return failed(`${command} unavailable`); },
  async startDetached(command) { return failed(`${command} unexpectedly detached`); },
  invocationCount() { return 0; },
};

// Claude holds each turn open until the test releases it: one line in the release file per turn.
const gatedClaude = `
const readline = require("node:readline");
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const released = () => existsSync(process.env.CHAT_RELEASE) ? readFileSync(process.env.CHAT_RELEASE, "utf8").split("\\n").filter(Boolean).length : 0;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "queue-session" }) + "\\n");
let turns = 0;
process.on("SIGINT", () => process.stdout.write(JSON.stringify({ type: "result", session_id: "queue-session", is_error: true }) + "\\n"));
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(input.message.content) + "\\n");
  const number = ++turns;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "reply-" + number, content: [{ type: "text", text: "reply-" + number }] } }) + "\\n");
  const timer = setInterval(() => {
    if (released() < number) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: "result", session_id: "queue-session", is_error: false }) + "\\n");
  }, 10);
});
`;

// Codex starts a turn per turn/start and completes it when the test releases it; steer is recorded.
const gatedCodex = `
const readline = require("node:readline");
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const released = () => existsSync(process.env.CHAT_RELEASE) ? readFileSync(process.env.CHAT_RELEASE, "utf8").split("\\n").filter(Boolean).length : 0;
let turns = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (request.method === "thread/start") send({ id: request.id, result: { thread: { id: "queue-thread" } } });
  if (request.method === "turn/steer") send({ id: request.id, result: { turnId: "turn-" + turns } });
  if (request.method === "turn/interrupt") {
    send({ id: request.id, result: {} });
    send({ method: "turn/completed", params: { threadId: "queue-thread", turn: { id: request.params.turnId, status: "interrupted" } } });
  }
  if (request.method === "turn/start") {
    const number = ++turns;
    send({ id: request.id, result: { turn: { id: "turn-" + number } } });
    send({ method: "turn/started", params: { threadId: "queue-thread", turnId: "turn-" + number } });
    if (process.env.CHAT_CHILD_THREAD) send({ method: "turn/completed", params: { threadId: process.env.CHAT_CHILD_THREAD, turn: { id: "child-turn", status: "completed" } } });
    const timer = setInterval(() => {
      if (released() < number) return;
      clearInterval(timer);
      send({ method: "turn/completed", params: { threadId: "queue-thread", turn: { id: "turn-" + number, status: "completed" } } });
    }, 10);
  }
});
`;

function sandbox(agent: "claude" | "codex") {
  const root = mkdtempSync(join(tmpdir(), "megabrain-chat-queue-"));
  directories.push(root);
  const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
  const capture = join(root, "capture.jsonl"), release = join(root, "release");
  const script = join(bin, agent);
  writeFileSync(script, `#!${process.execPath}\n${agent === "claude" ? gatedClaude : gatedCodex}\n`);
  chmodSync(script, 0o700);
  const image = join(root, "image.png");
  writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nZsAAAAASUVORK5CYII=", "base64"));
  const environment = { HOME: root, MEGABRAIN_STATE_DIR: state, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: capture, CHAT_RELEASE: release };
  return { root, state, cwd, capture, release, image, environment, releaseTurn: () => appendFileSync(release, "x\n") };
}
type Sandbox = ReturnType<typeof sandbox>;

async function daemonFor(env: Sandbox) {
  const daemon = new ChatDaemon(env.state, env.environment);
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  return daemon;
}

const text = (value: string): Part[] => [{ type: "text", text: value }];
const textOf = (parts: Part[]) => parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("");

async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    last = await read();
    if (check(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label} (last: ${JSON.stringify(last)})`);
}

/** What the fake Claude received, one turn per line, as the text of each turn. */
function claudeTurns(env: Sandbox): string[] {
  if (!existsSync(env.capture)) return [];
  return readFileSync(env.capture, "utf8").trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text).join(""));
}
function codexRequests(env: Sandbox): Array<{ method: string; params: { input?: Array<{ type: string; text?: string; path?: string }> } }> {
  if (!existsSync(env.capture)) return [];
  return readFileSync(env.capture, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function chatState(daemon: ChatDaemon, id: string): Promise<string> {
  const chats = await daemon.handle({ operation: "list" }) as Chat[];
  return chats.find((chat) => chat.id === id)?.state ?? "missing";
}
const queueOf = async (daemon: ChatDaemon, id: string) => await daemon.handle({ operation: "queue", action: "list", id }) as Item[];

async function workingClaude(env: Sandbox) {
  const daemon = await daemonFor(env);
  const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd }) as Chat;
  await until(() => chatState(daemon, chat.id), (state) => state === "idle", "claude idle");
  await daemon.handle({ operation: "send", id: chat.id, parts: text("first") });
  await until(() => claudeTurns(env), (turns) => turns.length === 1, "first turn reached claude");
  expect(await chatState(daemon, chat.id)).toBe("working");
  return { daemon, id: chat.id };
}

function follow(state: string, id: string) {
  const lines: ChatLine[] = [];
  const socket = createConnection(join(state, "chatd", "s"));
  let buffer = "";
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write(JSON.stringify({ operation: "events", id, since: 0, follow: true }) + "\n"));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) { lines.push(JSON.parse(buffer.slice(0, end)) as ChatLine); buffer = buffer.slice(end + 1); }
  });
  return { lines, close: () => socket.destroy() };
}

describe("chat queue in the daemon", () => {
  test("a send during a turn waits in the queue with its parts, and the queue drains one message per turn in order", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    const withImage: Part[] = [{ type: "text", text: "second" }, { type: "image", path: env.image }, { type: "text", text: "tail" }];
    const sent = await daemon.handle({ operation: "send", id, parts: withImage }) as { queued: Item | null };
    expect(sent.queued).toMatchObject({ parts: withImage });
    await daemon.handle({ operation: "send", id, parts: text("third") });
    const queued = await queueOf(daemon, id);
    expect(queued.map((item) => textOf(item.parts))).toEqual(["secondtail", "third"]);
    expect(queued[0]?.parts).toEqual(withImage);
    // Nothing queued reached the agent, and the chat shows no user message for it yet.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(claudeTurns(env)).toEqual(["first"]);
    const before = await daemon.handle({ operation: "events", id, since: 0 }) as ChatLine[];
    expect(before.filter((line) => line.event?.kind === "user").map((line) => line.event?.text)).toEqual(["first"]);

    env.releaseTurn();
    await until(() => claudeTurns(env), (turns) => turns.length === 2, "second turn");
    expect(claudeTurns(env)).toEqual(["first", "secondtail"]);
    expect((await queueOf(daemon, id)).map((item) => textOf(item.parts))).toEqual(["third"]);
    const middle = await daemon.handle({ operation: "events", id, since: 0 }) as ChatLine[];
    const secondUser = middle.find((line) => line.event?.kind === "user" && line.event.text === "secondtail");
    expect(secondUser?.event?.images).toEqual([{ path: env.image }]);

    env.releaseTurn();
    await until(() => claudeTurns(env), (turns) => turns.length === 3, "third turn");
    expect(claudeTurns(env)).toEqual(["first", "secondtail", "third"]);
    expect(await queueOf(daemon, id)).toEqual([]);
    env.releaseTurn();
    await until(() => chatState(daemon, id), (state) => state === "idle", "idle after the queue drained");
    expect(claudeTurns(env)).toHaveLength(3);
  });

  test("an idle chat sends at once and queues nothing", async () => {
    const env = sandbox("claude");
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd }) as Chat;
    await until(() => chatState(daemon, chat.id), (state) => state === "idle", "claude idle");
    const sent = await daemon.handle({ operation: "send", id: chat.id, parts: text("now") }) as { queued: Item | null };
    expect(sent.queued).toBeNull();
    await until(() => claudeTurns(env), (turns) => turns.length === 1, "turn reached claude");
    expect(await queueOf(daemon, chat.id)).toEqual([]);
  });

  test("edit moves the message to the end, move puts it at an index, remove and clear drop messages", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    for (const value of ["a", "b", "c"]) await daemon.handle({ operation: "queue", action: "add", id, parts: text(value) });
    const names = async () => (await queueOf(daemon, id)).map((item) => textOf(item.parts));
    expect(await names()).toEqual(["a", "b", "c"]);
    const [a, b, c] = await queueOf(daemon, id);
    const edited = await daemon.handle({ operation: "queue", action: "edit", id, itemId: a?.id, parts: [{ type: "text", text: "a2" }, { type: "image", path: env.image }] }) as Item[];
    expect(edited.map((item) => textOf(item.parts))).toEqual(["b", "c", "a2"]);
    expect(edited.at(-1)).toMatchObject({ id: a?.id, parts: [{ type: "text", text: "a2" }, { type: "image", path: env.image }] });
    await daemon.handle({ operation: "queue", action: "move", id, itemId: c?.id, to: 0 });
    expect(await names()).toEqual(["c", "b", "a2"]);
    await daemon.handle({ operation: "queue", action: "move", id, itemId: c?.id, to: 99 });
    expect(await names()).toEqual(["b", "a2", "c"]);
    await daemon.handle({ operation: "queue", action: "remove", id, itemId: b?.id });
    expect(await names()).toEqual(["a2", "c"]);
    await expect(daemon.handle({ operation: "queue", action: "remove", id, itemId: b?.id })).rejects.toThrow(/not in the queue/);
    await daemon.handle({ operation: "queue", action: "clear", id });
    expect(await names()).toEqual([]);
  });

  test("the queue survives a chatd restart and drains after the chat resumes", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    await daemon.handle({ operation: "send", id, parts: text("kept") });
    expect(JSON.parse(readFileSync(join(env.state, "chats", id, "queue.json"), "utf8"))).toMatchObject([{ parts: text("kept") }]);
    await daemon.close();
    daemons.splice(daemons.indexOf(daemon), 1);

    const next = await daemonFor(env);
    expect(await chatState(next, id)).toBe("suspended");
    expect((await queueOf(next, id)).map((item) => textOf(item.parts))).toEqual(["kept"]);
    env.releaseTurn();
    await next.handle({ operation: "send", id, parts: text("resume") });
    await until(() => claudeTurns(env), (turns) => turns.includes("resume"), "resumed turn");
    env.releaseTurn();
    await until(() => claudeTurns(env), (turns) => turns.at(-1) === "kept", "the kept message after the resumed turn");
    expect(await queueOf(next, id)).toEqual([]);
  });

  test("followers get the queue on subscribe and after every change", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    await daemon.handle({ operation: "send", id, parts: text("one") });
    const watcher = follow(env.state, id);
    try {
      await until(() => watcher.lines, (lines) => lines.some((line) => line.queue?.length === 1), "queue on subscribe");
      await daemon.handle({ operation: "send", id, parts: text("two") });
      await until(() => watcher.lines, (lines) => lines.some((line) => line.queue?.length === 2), "queue after add");
      await daemon.handle({ operation: "queue", action: "clear", id });
      await until(() => watcher.lines, (lines) => lines.at(-1)?.queue?.length === 0, "queue after clear");
    } finally { watcher.close(); }
  });

  test("an interrupt holds the queue; send-now interrupts the turn and sends that message next", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    await daemon.handle({ operation: "send", id, parts: text("waiting") });
    await daemon.handle({ operation: "send", id, parts: text("urgent") });
    await daemon.handle({ operation: "interrupt", id });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(claudeTurns(env)).toEqual(["first"]);
    expect((await queueOf(daemon, id)).map((item) => textOf(item.parts))).toEqual(["waiting", "urgent"]);

    const urgent = (await queueOf(daemon, id))[1];
    await daemon.handle({ operation: "queue", action: "send-now", id, itemId: urgent?.id });
    await until(() => claudeTurns(env), (turns) => turns.length === 2, "urgent turn");
    expect(claudeTurns(env)).toEqual(["first", "urgent"]);
    expect((await queueOf(daemon, id)).map((item) => textOf(item.parts))).toEqual(["waiting"]);
    // A message the person sent explicitly lets the queue go on after its turn.
    env.releaseTurn(); env.releaseTurn();
    await until(() => claudeTurns(env), (turns) => turns.at(-1) === "waiting", "queue resumes after send-now");
  });

  test("send-now during a running turn interrupts it first", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    await daemon.handle({ operation: "send", id, parts: text("now please") });
    const [item] = await queueOf(daemon, id);
    await daemon.handle({ operation: "queue", action: "send-now", id, itemId: item?.id });
    await until(() => claudeTurns(env), (turns) => turns.length === 2, "sent now");
    const lines = await daemon.handle({ operation: "events", id, since: 0 }) as ChatLine[];
    expect(lines.some((line) => line.event?.kind === "system" && line.event.text === "Interrupted")).toBe(true);
    expect(await queueOf(daemon, id)).toEqual([]);
  });

  test("Codex queues a send during a turn instead of steering, and drains it as the next turn", async () => {
    const env = sandbox("codex");
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "codex", cwd: env.cwd }) as Chat;
    await until(() => chatState(daemon, chat.id), (state) => state === "idle", "codex idle");
    await daemon.handle({ operation: "send", id: chat.id, parts: text("first") });
    await until(() => chatState(daemon, chat.id), (state) => state === "working", "codex working");
    const sent = await daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "later" }, { type: "image", path: env.image }] }) as { queued: Item | null };
    expect(sent.queued).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(codexRequests(env).filter((request) => request.method === "turn/steer")).toEqual([]);
    expect(codexRequests(env).filter((request) => request.method === "turn/start")).toHaveLength(1);
    env.releaseTurn();
    await until(() => codexRequests(env).filter((request) => request.method === "turn/start"), (turns) => turns.length === 2, "queued turn started");
    expect(codexRequests(env).filter((request) => request.method === "turn/start")[1]?.params.input).toEqual([{ type: "text", text: "later" }, { type: "localImage", path: env.image }]);
  });

  test("a Codex subagent thread completing during the main turn does not drain the queue", async () => {
    const env = sandbox("codex");
    env.environment.CHAT_CHILD_THREAD = "child-thread";
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "codex", cwd: env.cwd }) as Chat;
    await until(() => chatState(daemon, chat.id), (state) => state === "idle", "codex idle");
    await daemon.handle({ operation: "send", id: chat.id, parts: text("first") });
    await until(() => chatState(daemon, chat.id), (state) => state === "working", "codex working");
    await daemon.handle({ operation: "send", id: chat.id, parts: text("later") });
    // The fake reports the child thread's turn/completed right after the main turn started.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await chatState(daemon, chat.id)).toBe("working");
    expect(codexRequests(env).filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect((await queueOf(daemon, chat.id)).map((item) => textOf(item.parts))).toEqual(["later"]);
    env.releaseTurn();
    await until(() => codexRequests(env).filter((request) => request.method === "turn/start"), (turns) => turns.length === 2, "queued turn starts after the main turn");
  });

  test("steer puts a queued message into the running Codex turn and takes it off the queue", async () => {
    const env = sandbox("codex");
    const daemon = await daemonFor(env);
    const chat = await daemon.handle({ operation: "start", agent: "codex", cwd: env.cwd }) as Chat;
    await until(() => chatState(daemon, chat.id), (state) => state === "idle", "codex idle");
    await daemon.handle({ operation: "send", id: chat.id, parts: text("first") });
    await until(() => chatState(daemon, chat.id), (state) => state === "working", "codex working");
    await daemon.handle({ operation: "send", id: chat.id, parts: text("steer me") });
    const [item] = await queueOf(daemon, chat.id);
    await daemon.handle({ operation: "queue", action: "steer", id: chat.id, itemId: item?.id });
    await until(() => codexRequests(env).filter((request) => request.method === "turn/steer"), (steers) => steers.length === 1, "steer request");
    expect(codexRequests(env).find((request) => request.method === "turn/steer")?.params.input).toEqual([{ type: "text", text: "steer me" }]);
    expect(await queueOf(daemon, chat.id)).toEqual([]);
  });

  test("steer is refused for Claude and when no turn runs", async () => {
    const env = sandbox("claude");
    const { daemon, id } = await workingClaude(env);
    await daemon.handle({ operation: "send", id, parts: text("x") });
    const [item] = await queueOf(daemon, id);
    await expect(daemon.handle({ operation: "queue", action: "steer", id, itemId: item?.id })).rejects.toThrow(/steer/i);
    expect(await queueOf(daemon, id)).toHaveLength(1);
  });
});

describe("chat queue CLI verbs", () => {
  function call(args: readonly string[], env: Sandbox) { return route(args, { environment: env.environment, processAdapter }); }
  const json = <T>(result: Awaited<ReturnType<typeof call>>): T => {
    expect(result.kind).toBe("ok");
    return JSON.parse(result.kind === "ok" ? result.value : "null") as T;
  };

  test("list, add, edit, move, remove and clear print the queue as JSON, and send --json says whether it queued", async () => {
    const env = sandbox("claude");
    const { id } = await workingClaude(env);
    expect(json<{ queued: Item | null }>(await call(["chat", "send", id, "--parts", JSON.stringify(text("via send")), "--json"], env)).queued).toMatchObject({ parts: text("via send") });
    const added = json<Item[]>(await call(["chat", "queue", "add", id, "--parts", JSON.stringify(text("via add")), "--json"], env));
    expect(added.map((item) => textOf(item.parts))).toEqual(["via send", "via add"]);
    expect(json<Item[]>(await call(["chat", "queue", "list", id, "--json"], env))).toEqual(added);
    const [first, second] = added;
    expect(json<Item[]>(await call(["chat", "queue", "edit", id, first?.id ?? "", "--parts", JSON.stringify(text("edited")), "--json"], env)).map((item) => textOf(item.parts))).toEqual(["via add", "edited"]);
    expect(json<Item[]>(await call(["chat", "queue", "move", id, first?.id ?? "", "--to", "0", "--json"], env)).map((item) => textOf(item.parts))).toEqual(["edited", "via add"]);
    expect(json<Item[]>(await call(["chat", "queue", "remove", id, second?.id ?? "", "--json"], env)).map((item) => textOf(item.parts))).toEqual(["edited"]);
    expect(json<Item[]>(await call(["chat", "queue", "clear", id, "--json"], env))).toEqual([]);
  });

  test("refuses queue verbs without --json, with a bad index, or with malformed parts", async () => {
    const env = sandbox("claude");
    const { id } = await workingClaude(env);
    expect((await call(["chat", "queue", "list", id], env)).kind).toBe("failed");
    expect((await call(["chat", "queue", "unknown", id, "--json"], env)).kind).toBe("failed");
    expect((await call(["chat", "queue", "add", id, "--parts", "[]", "--json"], env)).kind).toBe("failed");
    const [item] = json<Item[]>(await call(["chat", "queue", "add", id, "--parts", JSON.stringify(text("x")), "--json"], env));
    expect((await call(["chat", "queue", "move", id, item?.id ?? "", "--to", "-1", "--json"], env)).kind).toBe("failed");
    expect((await call(["chat", "queue", "move", id, item?.id ?? "", "--json"], env)).kind).toBe("failed");
  });
});
