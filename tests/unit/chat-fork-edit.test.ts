import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const roots: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ID = "a6dd9aae-6bb2-4c1d-8d87-709ef6f6e447";
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-chat-fork-edit-"));
  roots.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const capture = join(root, "calls.jsonl");
  mkdirSync(state, { recursive: true });
  mkdirSync(cwd);
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
  let result = {};
  if (request.method === "thread/resume") result = { thread: { id: request.params.threadId } };
  if (request.method === "thread/fork") result = { thread: { id: "forked-thread" } };
  if (request.method === "turn/start") result = { turn: { id: "replacement-turn" } };
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
  if (request.method === "turn/start") {
    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: "source-thread", turnId: "replacement-turn" } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "source-thread", turn: { id: "replacement-turn", status: "completed" } } }) + "\\n");
  }
});
`);
  chmodSync(join(bin, "codex"), 0o700);
  return { root, state, cwd, bin, capture };
}

async function setup(overrides: Partial<Chat> = {}) {
  const env = sandbox();
  const store = new ChatStore(env.state);
  const chat: Chat = {
    id: ID, agent: "codex", model: "gpt-5.6", cwd: env.cwd, title: "Three turns", state: "idle", mode: "chat",
    agentSessionId: "source-thread", createdAt: "2026-10-17T10:00:00.000Z", lastActivityAt: "2026-10-17T10:03:00.000Z", ...overrides,
  };
  await store.put(chat);
  const daemon = new ChatDaemon(env.state, { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: env.capture });
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  const turns = ["first", "second", "third"];
  for (const [index, text] of turns.entries()) {
    await store.append(ID, { id: `user-${index}`, at: `2026-10-17T10:0${index}:00.000Z`, kind: "user", text, turnId: `turn-${index}` });
    await store.append(ID, { id: `answer-${index}`, at: `2026-10-17T10:0${index}:30.000Z`, kind: "assistant", text: `answer:${text}`, turnId: `turn-${index}` });
  }
  await daemon.runAgent(await daemon.requireChat(ID));
  for (let attempt = 0; attempt < 100 && !daemon.children.has(ID); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!daemon.children.has(ID)) throw new Error("fake Codex did not start");
  return { env, store, daemon };
}

describe("fork and edit chat turns", () => {
  test("forking at the second turn copies two turns and leaves the source intact", async () => {
    const { env, store, daemon } = await setup();
    const before = await store.events(ID);
    const fork = await daemon.handle({ operation: "fork", id: ID, eventId: "answer-1" }) as Chat;
    expect(fork).toMatchObject({ agent: "codex", model: "gpt-5.6", title: "Three turns (branch)" });
    expect((await store.events(fork.id)).flatMap((line) => line.event?.kind === "user" ? [line.event.text] : [])).toEqual(["first", "second"]);
    expect(await store.events(ID)).toEqual(before);
    const calls = readFileSync(env.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(calls.find((call) => call.method === "thread/fork")?.params).toMatchObject({ threadId: "source-thread", lastTurnId: "turn-1" });
  });

  test("edit-last removes the last turn and records the replacement", async () => {
    const { env, store, daemon } = await setup();
    await daemon.handle({ operation: "edit-last", id: ID, parts: [{ type: "text", text: "corrected third" }] });
    const lines = await store.events(ID);
    const users = lines.flatMap((line) => line.event?.kind === "user" ? [line.event.text] : []);
    expect(users).toEqual(["first", "second", "corrected third"]);
    const events = lines.flatMap((line) => line.event ? [line.event.text] : []);
    expect(events).not.toContain("third");
    expect(events).not.toContain("answer:third");
    const rewindIndex = lines.findIndex((line) => line.event?.kind === "rewind");
    const replacementIndex = lines.findIndex((line) => line.event?.kind === "user" && line.event.text === "corrected third");
    expect(lines[rewindIndex]?.event).toMatchObject({ kind: "rewind", fromEventId: "user-2" });
    expect(rewindIndex).toBeGreaterThan(lines.findIndex((line) => line.event?.kind === "assistant" && line.event.text === "answer:second"));
    expect(rewindIndex).toBeLessThan(replacementIndex);
    const calls = readFileSync(env.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(calls.find((call) => call.method === "thread/revert")?.params).toMatchObject({ threadId: "source-thread", beforeTurnId: "turn-2" });
    expect(calls.some((call) => call.method === "turn/start" && JSON.stringify(call.params).includes("corrected third"))).toBe(true);
  });

  test("fork and edit refuse a chat with a running turn", async () => {
    const { daemon } = await setup();
    const chat = await daemon.requireChat(ID);
    chat.state = "working";
    await daemon.save(chat);
    await expect(daemon.handle({ operation: "fork", id: ID, eventId: "user-1" })).rejects.toMatchObject({ code: "chat-busy" });
    await expect(daemon.handle({ operation: "edit-last", id: ID, parts: [{ type: "text", text: "again" }] })).rejects.toMatchObject({ code: "chat-busy" });
  });

  test("edit-last refuses a chat without a person message", async () => {
    const empty = await setupEmpty();
    await expect(empty.daemon.handle({ operation: "edit-last", id: ID, parts: [{ type: "text", text: "again" }] })).rejects.toMatchObject({ code: "nothing-to-edit" });
  });
});

async function setupEmpty() {
  const env = sandbox();
  const daemon = new ChatDaemon(env.state, { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: env.capture });
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  const chat: Chat = { id: ID, agent: "codex", model: null, cwd: env.cwd, title: null, state: "idle", mode: "chat", agentSessionId: "source-thread", createdAt: new Date().toISOString(), lastActivityAt: null };
  await daemon.store.put(chat);
  return { daemon };
}
