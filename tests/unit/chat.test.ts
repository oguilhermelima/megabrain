import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-chat-test-"));
  directories.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const capture = join(root, "agent-capture.jsonl");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(bin);
  writeFileSync(join(root, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nZsAAAAASUVORK5CYII=", "base64"));
  return { root, state, cwd, bin, capture };
}

function fakeAgent(bin: string, name: "claude" | "codex", body: string) {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`);
  chmodSync(path, 0o700);
}

const processAdapter: ProcessAdapter = {
  async run(command) { return failed(`${command} unavailable`); },
  async startDetached(command) { return failed(`${command} unexpectedly detached`); },
  invocationCount() { return 0; },
};

function call(args: readonly string[], env: ReturnType<typeof sandbox>) {
  return route(args, {
    environment: { HOME: env.root, MEGABRAIN_STATE_DIR: env.state, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: env.capture, CHAT_USAGE_FIXTURE: join(process.cwd(), "tests/fixtures/chat-codex-usage.jsonl") },
    processAdapter,
  });
}

async function waitForChat(id: string, state: string, env: ReturnType<typeof sandbox>) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await call(["chat", "list", "--json"], env);
    if (result.kind === "ok" && (JSON.parse(result.value) as Array<{ id: string; state: string }>).some((chat) => chat.id === id && chat.state === state)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`chat ${id} did not reach ${state}`);
}

async function waitForCapture(env: ReturnType<typeof sandbox>, predicate: (content: string) => boolean, description: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const content = existsSync(env.capture) ? readFileSync(env.capture, "utf8") : "";
    if (predicate(content)) return content;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`agent did not ${description}`);
}

// The daemon marks a chat working before it writes the turn request, so the state alone does not
// mean the agent has received the input; wait for the request itself to land in the capture file.
async function waitForRequest(method: string, env: ReturnType<typeof sandbox>) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const lines = existsSync(env.capture) ? readFileSync(env.capture, "utf8").split("\n") : [];
    for (const line of lines) {
      try { const request = JSON.parse(line) as { method?: string }; if (request.method === method) return; } catch { /* A line still being written. */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`agent never received ${method}`);
}

async function socketDaemon(env: ReturnType<typeof sandbox>) {
  const daemon = new ChatDaemon(env.state, { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: env.capture, CHAT_USAGE_FIXTURE: join(process.cwd(), "tests/fixtures/chat-codex-usage.jsonl") });
  await daemon.start();
  await daemon.listen();
  return daemon;
}

describe("native chat commands with protocol fakes", () => {
  test("starts, sends in order, persists events, and reloads an interrupted Claude chat", async () => {
    const env = sandbox();
    const claudeUsage = readFileSync(join(process.cwd(), "tests/fixtures/chat-claude-usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { parent_tool_use_id?: string; usage: Record<string, number> });
    fakeAgent(env.bin, "claude", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const usageRows = ${JSON.stringify(claudeUsage)};
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-claude-session" }) + "\\n");
let n = 0;
process.on("SIGINT", () => process.stdout.write(JSON.stringify({ type: "result", session_id: "fake-claude-session", is_error: true }) + "\\n"));
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type === "user") {
    const text = input.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    for (const row of usageRows) {
      process.stdout.write(JSON.stringify({ type: "assistant", ...(row.parent_tool_use_id ? { parent_tool_use_id: row.parent_tool_use_id } : {}), message: { id: "assistant-" + (++n), content: [{ type: "text", text: "reply:" + text }], usage: row.usage, stop_reason: "end_turn" } }) + "\\n");
    }
    process.stdout.write(JSON.stringify({ type: "result", session_id: "fake-claude-session", is_error: false, modelUsage: { "claude-haiku-5-5": { contextWindow: 1000000 } } }) + "\\n");
  }
});
`);
    const started = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--parts", JSON.stringify([{ type: "text", text: "first" }]), "--json"], env);
    expect(started.kind).toBe("ok");
    if (started.kind !== "ok") return;
    const chat = JSON.parse(started.value) as { id: string; state: string };
    expect(chat.state).toMatch(/starting|idle/);
    expect((await call(["chat", "send", chat.id, "--parts", JSON.stringify([{ type: "text", text: "second" }])], env)).kind).toBe("ok");
    await waitForChat(chat.id, "idle", env);
    const listed = await call(["chat", "list", "--json"], env);
    expect(listed.kind).toBe("ok");
    if (listed.kind === "ok") {
      const saved = (JSON.parse(listed.value) as Array<{ id: string; contextTokens: number; contextWindow: number }>).find((entry) => entry.id === chat.id);
      expect(saved).toMatchObject({ contextTokens: 250074, contextWindow: 1000000 });
      expect(saved?.contextTokens).toBeLessThanOrEqual(saved?.contextWindow ?? 0);
    }

    const events = await call(["chat", "events", chat.id, "--json"], env);
    expect(events.kind).toBe("ok");
    if (events.kind === "ok") {
      const lines = events.value.trim().split("\n").map((line) => JSON.parse(line) as { cursor: string; event?: { text: string } });
      expect(lines[0]?.cursor).toBe("0");
      expect(lines.map((line) => Number(line.cursor))).toEqual([...lines].map((line) => Number(line.cursor)).sort((a, b) => a - b));
      expect(lines.some((line) => line.event?.text.includes("reply:first"))).toBe(true);
      expect(lines.some((line) => line.event?.text.includes("reply:second"))).toBe(true);
    }

    expect((await call(["chat", "interrupt", chat.id], env)).kind).toBe("ok");
    const reloaded = await call(["chat", "list", "--json"], env);
    expect(reloaded.kind).toBe("ok");
    if (reloaded.kind === "ok") expect(JSON.parse(reloaded.value)).toContainEqual(expect.objectContaining({ id: chat.id, state: "idle" }));
    const interrupted = await call(["chat", "events", chat.id, "--json"], env);
    expect(interrupted.kind).toBe("ok");
    if (interrupted.kind === "ok") {
      const lines = interrupted.value.trim().split("\n").map((line) => JSON.parse(line) as { event?: { kind: string; text: string } });
      expect(lines.filter((line) => line.event?.kind === "system" && line.event.text === "Interrupted")).toHaveLength(1);
    }
  });

  test("keeps image parts in order and hands over to the terminal during a turn", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "codex", `
const readline = require("node:readline");
const { appendFileSync, readFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
const usage = JSON.parse(readFileSync(process.env.CHAT_USAGE_FIXTURE, "utf8"));
let thread = "fake-codex-thread";
rl.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: thread } } }) + "\\n");
  if (request.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "fake-turn" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId: thread, turnId: "fake-turn" } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: usage.method, params: { ...usage.params, threadId: thread, turnId: "fake-turn" } }) + "\\n");
    const totalOnlyUsage = { ...usage.params.tokenUsage };
    delete totalOnlyUsage.last;
    process.stdout.write(JSON.stringify({ method: usage.method, params: { ...usage.params, tokenUsage: totalOnlyUsage, threadId: thread, turnId: "fake-turn" } }) + "\\n");
  }
  if (request.method === "turn/steer") process.stdout.write(JSON.stringify({ id: request.id, result: { turnId: "fake-turn" } }) + "\\n");
});
`);
    const started = await call(["chat", "start", "--agent", "codex", "--cwd", env.cwd, "--parts", JSON.stringify([
      { type: "text", text: "before" }, { type: "image", path: join(env.root, "image.png") }, { type: "text", text: "after" },
    ]), "--json"], env);
    expect(started.kind).toBe("ok");
    if (started.kind !== "ok") return;
    const chat = JSON.parse(started.value) as { id: string };
    await waitForChat(chat.id, "working", env);
    await waitForRequest("turn/start", env);
    const recorded = readFileSync(env.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { input?: unknown[] } });
    const turn = recorded.find((request) => request.method === "turn/start");
    expect(turn?.params.input).toEqual([
      { type: "text", text: "before" },
      { type: "localImage", path: join(env.root, "image.png") },
      { type: "text", text: "after" },
    ]);
    const listed = await call(["chat", "list", "--json"], env);
    expect(listed.kind).toBe("ok");
    if (listed.kind === "ok") {
      const saved = (JSON.parse(listed.value) as Array<{ id: string; contextTokens: number; contextWindow: number }>).find((entry) => entry.id === chat.id);
      expect(saved).toMatchObject({ contextTokens: 61476, contextWindow: 258400 });
      expect(saved?.contextTokens).toBeLessThanOrEqual(saved?.contextWindow ?? 0);
    }
    const moved = await call(["chat", "mode", chat.id, "terminal", "--json"], env);
    expect(moved.kind).toBe("ok");
    if (moved.kind === "ok") expect(JSON.parse(moved.value)).toMatchObject({ chat: { mode: "terminal", state: "idle" } });
  });

  test("changes Codex model and effort for the next turn", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "codex", `
const readline = require("node:readline");
const { appendFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "model-test-thread" } } }) + "\\n");
  if (request.method === "turn/start") process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "model-test-turn" } } }) + "\\n");
});
`);
    const started = await call(["chat", "start", "--agent", "codex", "--cwd", env.cwd, "--json"], env);
    expect(started.kind).toBe("ok");
    if (started.kind !== "ok") return;
    const chat = JSON.parse(started.value) as { id: string };
    await waitForChat(chat.id, "idle", env);
    const changed = await call(["chat", "model", chat.id, "gpt-5.6-luna", "--effort", "low", "--json"], env);
    expect(changed.kind).toBe("ok");
    expect((await call(["chat", "send", chat.id, "--parts", JSON.stringify([{ type: "text", text: "next turn" }])], env)).kind).toBe("ok");
    const requests = readFileSync(env.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(requests.find((request) => request.method === "turn/start")?.params).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    const stored = await call(["chat", "events", chat.id, "--json"], env);
    expect(stored.kind === "ok" && stored.value.includes("Model set to")).toBe(false);
    const listed = await call(["chat", "list", "--json"], env);
    expect(listed.kind === "ok" && JSON.parse(listed.value)).toContainEqual(expect.objectContaining({ id: chat.id, model: "gpt-5.6-luna", effort: "low" }));
  });

  test("starts a chat with its effort in one call: Codex's first turn and Claude's argv carry it", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "codex", `
const readline = require("node:readline");
const { appendFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "effort-thread" } } }) + "\\n");
  if (request.method === "turn/start") process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "effort-turn" } } }) + "\\n");
});
`);
    fakeAgent(env.bin, "claude", `
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
process.stdin.resume();
`);
    const codex = await call(["chat", "start", "--agent", "codex", "--cwd", env.cwd, "--model", "gpt-6-luna", "--effort", "high", "--parts", JSON.stringify([{ type: "text", text: "first" }]), "--json"], env);
    expect(codex.kind).toBe("ok");
    if (codex.kind !== "ok") return;
    expect(JSON.parse(codex.value)).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    const claude = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--effort", "low", "--json"], env);
    expect(claude.kind).toBe("ok");
    if (claude.kind !== "ok") return;
    const claudeId = (JSON.parse(claude.value) as Chat).id;
    await waitForChat(claudeId, "idle", env);
    let captured: Array<{ method?: string; params?: Record<string, unknown>; argv?: string[] }> = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      captured = existsSync(env.capture) ? readFileSync(env.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as (typeof captured)[number]) : [];
      if (captured.some((entry) => entry.method === "turn/start") && captured.some((entry) => entry.argv !== undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(captured.find((entry) => entry.method === "turn/start")?.params).toMatchObject({ model: "gpt-6-luna", effort: "high" });
    expect(captured.find((entry) => entry.argv !== undefined)?.argv).toEqual(expect.arrayContaining(["--effort", "low"]));
    await call(["chat", "stop", claudeId], env);
  });

  test("refuses an empty --effort on chat start", async () => {
    const env = sandbox();
    const result = await call(["chat", "start", "--agent", "codex", "--cwd", env.cwd, "--effort", "", "--json"], env);
    expect(result.kind).toBe("failed");
  });

  test("starts a Claude chat that stays silent until its first input line", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let announced = false;
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  if (!announced) { announced = true; process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "silent-session" }) + "\\n"); }
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "silent-1", content: [{ type: "text", text: "hello" }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: "silent-session", is_error: false }) + "\\n");
});
`);
    const daemon = await socketDaemon(env);
    let id = "";
    try {
      const started = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--parts", JSON.stringify([{ type: "text", text: "hi" }]), "--json"], env);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      id = (JSON.parse(started.value) as Chat).id;
      await waitForChat(id, "idle", env);
      const listed = await call(["chat", "list", "--json"], env);
      if (listed.kind === "ok") expect(JSON.parse(listed.value)).toContainEqual(expect.objectContaining({ id, agentSessionId: "silent-session" }));
      const events = await call(["chat", "events", id, "--json"], env);
      expect(events.kind === "ok" && events.value.includes("hello")).toBe(true);
    } finally {
      if (id) await call(["chat", "stop", id], env);
      await daemon.close();
    }
  });

  test("fails a Claude chat that never answers its first input", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", `
process.stdin.resume();
setInterval(() => {}, 1000);
`);
    const daemon = new ChatDaemon(env.state, { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, CHAT_CAPTURE: env.capture, MEGABRAIN_CHAT_START_TIMEOUT_MS: "150" });
    await daemon.start();
    await daemon.listen();
    let id = "";
    try {
      const started = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--parts", JSON.stringify([{ type: "text", text: "hi" }]), "--json"], env);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      id = (JSON.parse(started.value) as Chat).id;
      await waitForChat(id, "error", env);
      const listed = await call(["chat", "list", "--json"], env);
      if (listed.kind === "ok") expect(JSON.parse(listed.value)).toContainEqual(expect.objectContaining({ id, state: "error", error: expect.stringContaining("did not answer") }));
    } finally {
      if (id) await call(["chat", "stop", id], env);
      await daemon.close();
    }
  });

  test("queues Claude input during work and preserves Claude image order (Codex: chat-queue.test.ts)", async () => {
    const claude = sandbox();
    fakeAgent(claude.bin, "claude", `
const readline = require("node:readline");
const { appendFileSync } = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
let turns = 0;
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "queue-session" }) + "\\n");
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(input.message.content) + "\\n");
  const number = ++turns;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "queued-" + number, content: [{ type: "text", text: "reply-" + number }] } }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", session_id: "queue-session", is_error: false }) + "\\n"), number === 1 ? 150 : 10);
});
`);
    const claudeDaemon = await socketDaemon(claude);
    let claudeId = "";
    try {
      const started = await call(["chat", "start", "--agent", "claude", "--cwd", claude.cwd, "--json"], claude);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      claudeId = (JSON.parse(started.value) as Chat).id;
      await waitForChat(claudeId, "idle", claude);
      const imageParts = [
        { type: "text", text: "before" },
        { type: "image", path: join(claude.root, "image.png") },
        { type: "text", text: "after" },
      ];
      expect((await call(["chat", "send", claudeId, "--parts", JSON.stringify([{ type: "text", text: "first" }])], claude)).kind).toBe("ok");
      await waitForChat(claudeId, "working", claude);
      expect((await call(["chat", "send", claudeId, "--parts", JSON.stringify(imageParts)], claude)).kind).toBe("ok");
      await waitForChat(claudeId, "idle", claude);
      const inputs = readFileSync(claude.capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Array<Record<string, unknown>>);
      expect(inputs[1]).toEqual([
        { type: "text", text: "before" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(readFileSync(join(claude.root, "image.png"))).toString("base64") } },
        { type: "text", text: "after" },
      ]);
    } finally {
      if (claudeId) await call(["chat", "stop", claudeId], claude);
      await claudeDaemon.close();
    }
  });

  test("answers Codex command approval and emits it as an approval event", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "codex", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "approval-thread" } } }) + "\\n");
  if (request.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "approval-turn" } } }) + "\\n");
    process.stdout.write(JSON.stringify({ method: "item/commandExecution/requestApproval", id: 0, params: { threadId: "approval-thread", turnId: "approval-turn", itemId: "approval-item", command: "touch allowed.txt", cwd: process.cwd(), reason: "test", availableDecisions: ["accept", "decline"] } }) + "\\n");
  }
  if (request.id === 0 && request.result) require("node:fs").appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(request) + "\\n");
});
`);
    const daemon = await socketDaemon(env);
    try {
      const started = await call(["chat", "start", "--agent", "codex", "--cwd", env.cwd, "--approvals", "--parts", JSON.stringify([{ type: "text", text: "run the command" }]), "--json"], env);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      const chat = JSON.parse(started.value) as Chat;
      await waitForChat(chat.id, "waiting-approval", env);
      const result = await call(["chat", "events", chat.id, "--json"], env);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const lines = result.value.trim().split("\n").map((line) => JSON.parse(line) as { approval?: { id: string; tool: string } });
      const approval = lines.find((line) => line.approval)?.approval;
      expect(approval).toMatchObject({ tool: "command execution" });
      if (!approval) return;
      expect((await call(["chat", "approve", chat.id, approval.id, "--decision", "allow"], env)).kind).toBe("ok");
      const capture = await waitForCapture(env, (content) => content.includes('"decision":"accept"'), "accept the command approval");
      expect(capture).toContain('"decision":"accept"');
    } finally { await daemon.close(); }
  });

  test("round trips a Claude permission prompt through the stdio MCP server", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "mcp-session" }) + "\\n");
rl.on("line", () => {});
`);
    const daemon = await socketDaemon(env);
    let chatId = "";
    let mcp: ReturnType<typeof spawn> | undefined;
    try {
      const started = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--approvals", "--json"], env);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      chatId = (JSON.parse(started.value) as Chat).id;
      await waitForChat(chatId, "idle", env);
      mcp = spawn(process.execPath, [join(process.cwd(), "src/cli/index.ts"), "chat", "mcp-permission", chatId], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: env.root, MEGABRAIN_STATE_DIR: env.state },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const response = new Promise<string>((resolve, reject) => {
        let output = "";
        mcp?.stdout?.setEncoding("utf8");
        mcp?.stdout?.on("data", (chunk: string) => {
          output += chunk;
          const end = output.indexOf("\n");
          if (end !== -1) resolve(output.slice(0, end));
        });
        mcp?.once("error", reject);
      });
      mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "permissionPrompt", arguments: { tool_name: "Bash", input: { command: "touch allowed.txt" }, tool_use_id: "toolu-fake" } } }) + "\n");
      await waitForChat(chatId, "waiting-approval", env);
      const events = await call(["chat", "events", chatId, "--json"], env);
      expect(events.kind).toBe("ok");
      if (events.kind !== "ok") return;
      const lines = events.value.trim().split("\n").map((line) => JSON.parse(line) as { approval?: { id: string } });
      const approval = lines.find((line) => line.approval)?.approval;
      expect(approval?.id).toBeDefined();
      if (!approval) return;
      expect((await call(["chat", "approve", chatId, approval.id, "--decision", "allow"], env)).kind).toBe("ok");
      const result = JSON.parse(await response) as { id: number; result: { content: Array<{ type: string; text: string }> } };
      expect(result).toEqual({ jsonrpc: "2.0", id: 17, result: { content: [{ type: "text", text: JSON.stringify({ behavior: "allow" }) }] } });
    } finally {
      mcp?.stdin.end();
      if (chatId) await call(["chat", "stop", chatId], env);
      await daemon.close();
    }
  });

  test("streams new events, resumes the same session, and returns the terminal argv", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", `
const readline = require("node:readline");
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.CHAT_CAPTURE, JSON.stringify(process.argv.slice(2)) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "mode-session" }) + "\\n");
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type === "user") process.stdout.write(JSON.stringify({ type: "result", session_id: "mode-session", is_error: false }) + "\\n");
});
`);
    const daemon = await socketDaemon(env);
    let chatId = "";
    try {
      const started = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--parts", JSON.stringify([{ type: "text", text: "first" }]), "--json"], env);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      chatId = (JSON.parse(started.value) as Chat).id;
      await waitForChat(chatId, "idle", env);
      const history = await call(["chat", "events", chatId, "--json"], env);
      expect(history.kind).toBe("ok");
      if (history.kind !== "ok") return;
      const cursor = history.value.trim().split("\n").map((line) => JSON.parse(line) as { cursor: string }).at(-1)?.cursor ?? "0";
      const live = createConnection(join(env.state, "chatd", "s"));
      const liveLine = new Promise<string>((resolve, reject) => {
        let buffer = "";
        live.setEncoding("utf8");
        live.once("connect", () => live.write(JSON.stringify({ operation: "events", id: chatId, since: cursor, follow: true }) + "\n"));
        live.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n").filter(Boolean);
          if (lines.some((line) => { try { return (JSON.parse(line) as { event?: { text?: string } }).event?.text === "from follow"; } catch { return false; } })) resolve(lines.at(-1) ?? "");
        });
        live.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect((await call(["chat", "send", chatId, "--parts", JSON.stringify([{ type: "text", text: "from follow" }])], env)).kind).toBe("ok");
      const streamed = await Promise.race([liveLine, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("follow timed out")), 2000))]);
      expect(JSON.parse(streamed)).toMatchObject({ event: { text: "from follow" } });
      live.destroy();
      await waitForChat(chatId, "idle", env);
      const terminalArgv = await call(["chat", "terminal-command", chatId, "--json"], env);
      expect(terminalArgv.kind).toBe("ok");
      if (terminalArgv.kind === "ok") expect(JSON.parse(terminalArgv.value)).toEqual(["claude", "--resume", "mode-session", "--dangerously-skip-permissions"]);
      const terminal = await call(["chat", "mode", chatId, "terminal", "--json"], env);
      expect(terminal.kind).toBe("ok");
      if (terminal.kind === "ok") expect(JSON.parse(terminal.value)).toMatchObject({ chat: { mode: "terminal" }, terminal: null });
      const resumed = await call(["chat", "mode", chatId, "chat", "--json"], env);
      expect(resumed.kind).toBe("ok");
      let captured = readFileSync(env.capture, "utf8");
      for (let attempt = 0; attempt < 250 && !captured.includes("--resume"); attempt += 1) { await new Promise((resolve) => setTimeout(resolve, 20)); captured = readFileSync(env.capture, "utf8"); }
      expect(captured).toContain("--resume");
      await waitForChat(chatId, "idle", env);
    } finally {
      if (chatId) await call(["chat", "stop", chatId], env);
      await daemon.close();
    }
  });

  test("does not lose a chat event written between follow history and subscription", async () => {
    const env = sandbox();
    fakeAgent(env.bin, "claude", `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "follow-race-session" }) + "\\n");
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type === "user") {
    process.stdout.write(JSON.stringify({ type: "assistant", message: { id: "follow-race", content: [{ type: "text", text: "follow-race-reply" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", session_id: "follow-race-session", is_error: false }) + "\\n");
  }
});
`);
    const daemon = await socketDaemon(env);
    let chatId = "";
    let live: PassThrough | undefined;
    try {
      const started = await daemon.handle({ operation: "start", agent: "claude", cwd: env.cwd } as never) as Chat;
      chatId = started.id;
      for (let attempt = 0; attempt < 100 && (await daemon.store.get(chatId))?.state !== "idle"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

      const originalEvents = daemon.store.events.bind(daemon.store);
      let historyRead!: () => void;
      const historyWasRead = new Promise<void>((resolve) => { historyRead = resolve; });
      let releaseHistory!: () => void;
      const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
      let firstHistoryRead = true;
      daemon.store.events = async (id, since) => {
        const rows = await originalEvents(id, since);
        if (firstHistoryRead) {
          firstHistoryRead = false;
          historyRead();
          await historyGate;
        }
        return rows;
      };

      live = new PassThrough();
      const matchingEvent = new Promise<string>((resolve, reject) => {
        let buffer = "";
        live?.setEncoding("utf8");
        live?.on("data", (chunk: string) => {
          buffer += chunk;
          for (const line of buffer.split("\n").filter(Boolean)) {
            try {
              const parsed = JSON.parse(line) as { event?: { text?: string } };
              if (parsed.event?.text === "follow-race-reply") resolve(line);
            } catch { /* wait for the matching event */ }
          }
        });
      });
      void daemon.handle({ operation: "events", id: chatId, since: 2, follow: true } as never, live as never).catch(() => {});
      await Promise.race([historyWasRead, new Promise<void>((_, reject) => setTimeout(() => reject(new Error("event history was not read")), 1000))]);
      await daemon.handle({ operation: "send", id: chatId, parts: [{ type: "text", text: "race" }] } as never);
      let replyPersisted = false;
      for (let attempt = 0; attempt < 100 && !replyPersisted; attempt += 1) {
        replyPersisted = (await originalEvents(chatId, 2)).some((line) => line.event?.text === "follow-race-reply");
        if (!replyPersisted) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(replyPersisted).toBe(true);
      releaseHistory();
      const line = await Promise.race([matchingEvent, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("follow lost the event written during its initial history read")), 250))]);
      expect(JSON.parse(line)).toMatchObject({ event: { text: "follow-race-reply" } });
    } finally {
      live?.destroy();
      if (chatId) await daemon.handle({ operation: "stop", id: chatId } as never);
      await daemon.close();
    }
  });

  test("removes a running chat: stops its agent and deletes its record and events", async () => {
    const env = sandbox();
    const pidFile = join(env.root, "agent.pid");
    fakeAgent(env.bin, "claude", `
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "removed-session" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", session_id: "removed-session", is_error: false }) + "\\n");
});
`);
    const daemon = await socketDaemon(env);
    try {
      const started = await call(["chat", "start", "--agent", "claude", "--cwd", env.cwd, "--parts", JSON.stringify([{ type: "text", text: "hi" }]), "--json"], env);
      expect(started.kind).toBe("ok");
      if (started.kind !== "ok") return;
      const id = (JSON.parse(started.value) as Chat).id;
      await waitForChat(id, "idle", env);
      const pid = Number(readFileSync(pidFile, "utf8"));
      const removed = await call(["chat", "remove", id, "--json"], env);
      expect(removed).toMatchObject({ kind: "ok" });
      if (removed.kind === "ok") expect(JSON.parse(removed.value)).toEqual({ removed: id });
      const listed = await call(["chat", "list", "--json"], env);
      expect(listed.kind === "ok" && (JSON.parse(listed.value) as Chat[]).some((chat) => chat.id === id)).toBe(false);
      expect(existsSync(join(env.state, "chats", id))).toBe(false);
      let alive = true;
      for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
        try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 20)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally { await daemon.close(); }
  });

  test("removes a stopped chat without --json and refuses an unknown or malformed id", async () => {
    const env = sandbox();
    const store = new ChatStore(env.state);
    const chat: Chat = {
      id: "0b6f6a43-5d2a-4f43-9f55-6a3f4d1a2b3c", agent: "codex", model: null, cwd: env.cwd,
      title: "old", state: "stopped", mode: "chat", agentSessionId: "thread-1",
      createdAt: new Date().toISOString(), lastActivityAt: null,
    };
    await store.put(chat);
    const daemon = await socketDaemon(env);
    try {
      expect(await call(["chat", "remove", chat.id], env)).toEqual({ kind: "ok", value: "" });
      expect(await store.get(chat.id)).toBeNull();
      expect((await call(["chat", "remove", chat.id], env)).kind).toBe("failed");
      expect((await call(["chat", "remove", "../outside"], env)).kind).toBe("failed");
      expect((await call(["chat", "remove"], env)).kind).toBe("failed");
    } finally { await daemon.close(); }
  });

  test("suspends persisted working chats after chatd restarts", async () => {
    const env = sandbox();
    const store = new ChatStore(env.state);
    const chat: Chat = {
      id: "d9d1d0e1-2a24-4b75-b39e-ff08fc92f7ec", agent: "claude", model: null, cwd: env.cwd,
      title: "persisted", state: "working", mode: "chat", agentSessionId: "persisted-session",
      createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
    };
    await store.put(chat);
    const daemon = new ChatDaemon(env.state, { HOME: env.root });
    await daemon.start();
    try { expect(await store.get(chat.id)).toMatchObject({ state: "suspended", agentSessionId: "persisted-session" }); }
    finally { await daemon.close(); }
  });

  test("rejects invalid IDs and malformed message parts before starting an agent", async () => {
    const env = sandbox();
    expect((await call(["chat", "send", "../outside", "--parts", "[]"], env)).kind).toBe("failed");
    expect((await call(["chat", "start", "--agent", "unexpected", "--cwd", env.cwd, "--json"], env)).kind).toBe("failed");
    expect((await call(["chat", "send", "missing", "--parts", JSON.stringify([{ type: "image", path: "/etc/passwd" }])], env)).kind).toBe("failed");
  });
});
