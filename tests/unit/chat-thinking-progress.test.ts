import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { chatProtocolAdapters } from "../../src/chat/protocol.js";
import type { Chat, ChatEvent, ChatLine } from "../../src/chat/store.js";

// Fixtures, captured on this machine on 2026-10-16 and redacted (ids, signatures, usage details):
// - chat-claude-thinking-updates-stream.jsonl: claude -p 2.1.302, claude-opus-5-5, --include-partial-messages
//   as megabrain ran it before this change. Its thinking_delta chunks carry no text, only estimated_tokens,
//   with a system/thinking_tokens event beside each; message_delta carries the exact output tokens.
// - chat-claude-summarized-thinking-stream.jsonl: the same run with --thinking-display summarized, where the
//   thinking_delta chunks carry the summarized thinking text (cut to three of its chunks here).
// - chat-codex-reasoning-summary.jsonl: codex app-server 0.162.1, gpt-6-luna, turn/start with summary auto:
//   reasoning summary parts and their text deltas, then token usage once the response ended.
// Not captures: the system/api_retry row follows the shape the claude 2.1.302 binary builds
// (attempt, max_retries, retry_delay_ms, error_status, error), and the Codex error row follows the
// app-server v2 ErrorNotification schema (error.message, willRetry).

const FIXTURES = join(import.meta.dir, "../fixtures");
const recorded = (name: string) => readFileSync(join(FIXTURES, name), "utf8").trim().split("\n");
const UPDATES = recorded("chat-claude-thinking-updates-stream.jsonl");
const SUMMARIZED = recorded("chat-claude-summarized-thinking-stream.jsonl");
const CODEX = recorded("chat-codex-reasoning-summary.jsonl").map((row) => JSON.parse(row) as Record<string, unknown>);

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

async function harness(agent: "claude" | "codex", script: string) {
  const root = mkdtempSync(join(tmpdir(), "megabrain-thinking-"));
  directories.push(root);
  const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
  writeFileSync(join(bin, agent), `#!${process.execPath}\n${script}`);
  chmodSync(join(bin, agent), 0o700);
  const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
  await daemon.start();
  await daemon.listen();
  return { root, state, cwd, daemon };
}

function claudeReplay(rows: string[]): string {
  return `const rows = ${JSON.stringify(rows)};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async () => { for (const row of rows) { process.stdout.write(row + "\\n"); await new Promise((r) => setTimeout(r, 2)); } });
`;
}

/** A Codex app-server that answers one turn with the notifications given, and records every request it gets. */
function codexReplay(notifications: unknown[], requests: string): string {
  return `const notifications = ${JSON.stringify(notifications)};
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  appendFileSync(${JSON.stringify(requests)}, line + "\\n");
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "redacted-thread" } } }) + "\\n");
  if (request.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "redacted-turn" } } }) + "\\n");
    for (const note of notifications) { process.stdout.write(JSON.stringify(note) + "\\n"); await new Promise((r) => setTimeout(r, 2)); }
  }
});
`;
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
  return { events: () => lines.flatMap((line) => line.event ? [line.event] : []), close: () => socket.destroy() };
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 250; attempt += 1) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out: ${label}`);
}

/** Runs one turn to its end and returns what the chat stored and what a follower saw live. */
async function turn(agent: "claude" | "codex", script: string, h?: Awaited<ReturnType<typeof harness>>) {
  const running = h ?? await harness(agent, script);
  const chat = await running.daemon.handle({ operation: "start", agent, cwd: running.cwd }) as Chat;
  const watcher = follow(running.state, chat.id);
  try {
    await until(() => watcher.events().some((e) => e.kind === "state"), "follow started");
    if (agent === "codex") await until(() => watcher.events().filter((e) => e.kind === "state").at(-1)?.text === "idle", "codex thread ready");
    await running.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
    await until(() => watcher.events().some((e) => e.kind === "assistant"), "reply");
    await until(() => watcher.events().filter((e) => e.kind === "state").at(-1)?.text === "idle", "idle");
    const stored = (await running.daemon.store.events(chat.id)).flatMap((line) => line.event ? [line.event] : []);
    return { stored, live: watcher.events() };
  } finally { watcher.close(); await running.daemon.close(); }
}

const progress = (events: ChatEvent[]) => events.filter((e) => e.kind === "progress").map((e) => e.progress ?? {});
const tokens = (events: ChatEvent[]) => progress(events).flatMap((value) => value.tokens === undefined ? [] : [value.tokens]);
const thinkingDeltas = (events: ChatEvent[]) => events.filter((e) => e.kind === "delta" && e.stream === "thinking").map((e) => e.text);
const nonDecreasing = (values: number[]) => values.every((value, index) => index === 0 || value >= (values[index - 1] ?? 0));

describe("the agents are asked for readable thinking", () => {
  test("Claude starts with summarized thinking display", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-thinking-args-"));
    directories.push(root);
    mkdirSync(join(root, "chats", "c1"), { recursive: true });
    const chat = { id: "c1", agent: "claude", model: null, effort: null, cwd: root, agentSessionId: null, approvals: false } as unknown as Chat;
    const { args } = await chatProtocolAdapters.claude.prepare(chat, root);
    expect(args.slice(args.indexOf("--thinking-display"), args.indexOf("--thinking-display") + 2)).toEqual(["--thinking-display", "summarized"]);
  });

  test("Codex asks each turn for a reasoning summary", async () => {
    const h = await harness("codex", "");
    const requests = join(h.root, "requests.jsonl");
    writeFileSync(join(h.root, "bin", "codex"), `#!${process.execPath}\n${codexReplay(CODEX, requests)}`);
    await turn("codex", "", h);
    const starts = readFileSync(requests, "utf8").trim().split("\n").map((row) => JSON.parse(row) as { method?: string; params?: Record<string, unknown> }).filter((request) => request.method === "turn/start");
    expect(starts.map((request) => request.params?.summary)).toEqual(["auto"]);
  });
});

describe("Claude thinking progress", () => {
  test("thinking without text sends no empty chunk, only a token count that ends on the exact usage", async () => {
    const { stored, live } = await turn("claude", claudeReplay(UPDATES));
    expect(thinkingDeltas(live)).toEqual([]);
    expect(stored.filter((e) => e.kind === "thinking")).toEqual([]);
    const counts = tokens(live);
    // The running estimate from system/thinking_tokens, then the exact output tokens of message_delta.
    expect(counts.slice(0, 3)).toEqual([50, 200, 400]);
    expect(counts.at(-1)).toBe(425);
    expect(nonDecreasing(counts)).toBe(true);
  });

  test("summarized thinking streams its text live and keeps it in the stored thought", async () => {
    const { stored, live } = await turn("claude", claudeReplay(SUMMARIZED));
    expect(thinkingDeltas(live)).toEqual(["There", " are", " 62"]);
    expect(stored.filter((e) => e.kind === "thinking").map((e) => e.text)).toEqual(["There are 62 primes below 300."]);
    expect(tokens(live).at(-1)).toBe(375);
    expect(nonDecreasing(tokens(live))).toBe(true);
  });

  test("progress is never stored", async () => {
    const { stored } = await turn("claude", claudeReplay(UPDATES));
    expect(stored.filter((e) => e.kind === "progress")).toEqual([]);
  });

  test("the request going out is reported", async () => {
    const { live } = await turn("claude", claudeReplay(UPDATES));
    expect(progress(live).some((value) => value.status === "requesting")).toBe(true);
  });

  test("a retry the stream reports reaches followers with its attempt, wait and reason", async () => {
    const retry = JSON.stringify({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: "overloaded", session_id: "stream-session" });
    const rows = [UPDATES[0] ?? "", retry, ...UPDATES.slice(1)];
    const { live } = await turn("claude", claudeReplay(rows));
    expect(progress(live).flatMap((value) => value.retry === undefined ? [] : [value.retry])).toEqual([{ attempt: 2, maxAttempts: 10, delayMs: 4000, reason: "overloaded" }]);
  });

  test("a later turn counts its tokens from zero", async () => {
    const h = await harness("claude", claudeReplay(UPDATES));
    const chat = await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd }) as Chat;
    const watcher = follow(h.state, chat.id);
    try {
      await until(() => watcher.events().some((e) => e.kind === "state"), "follow started");
      for (const round of [1, 2]) {
        await h.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: `go ${round}` }] });
        await until(() => watcher.events().filter((e) => e.kind === "assistant").length === round, `reply ${round}`);
        await until(() => watcher.events().filter((e) => e.kind === "state").at(-1)?.text === "idle", `idle ${round}`);
      }
      const second = watcher.events().slice(watcher.events().findLastIndex((e) => e.kind === "user"));
      expect(tokens(second)[0]).toBe(50);
      expect(tokens(second).at(-1)).toBe(425);
    } finally { watcher.close(); await h.daemon.close(); }
  });
});

describe("Codex thinking progress", () => {
  test("reasoning summary parts stream as thinking, separated, and the stored thought keeps them", async () => {
    const { stored, live } = await turn("codex", codexReplay(CODEX, "/dev/null"));
    expect(thinkingDeltas(live)).toEqual(["**Calculating prime totals**", "\n\n", "**Checking prime count**"]);
    expect(stored.filter((e) => e.kind === "thinking").map((e) => e.text)).toEqual(["**Calculating prime totals**\n\n**Checking prime count**"]);
  });

  test("the turn's output tokens come from token usage, counted from the turn's start on a resumed thread", async () => {
    const resumed = CODEX.map((note) => {
      if (note.method !== "thread/tokenUsage/updated") return note;
      const params = note.params as { tokenUsage: { total: Record<string, number>; last: Record<string, number> } };
      return { ...note, params: { ...params, tokenUsage: { ...params.tokenUsage, total: { ...params.tokenUsage.total, outputTokens: 10415 } } } };
    });
    const second = { method: "thread/tokenUsage/updated", params: { threadId: "redacted-thread", turnId: "redacted-turn", tokenUsage: { total: { inputTokens: 14000, outputTokens: 10615, reasoningOutputTokens: 590 }, last: { inputTokens: 14000, outputTokens: 200, reasoningOutputTokens: 185 }, modelContextWindow: 258400 } } };
    const notes = [...resumed.slice(0, -1), second, ...resumed.slice(-1)];
    const { live } = await turn("codex", codexReplay(notes, "/dev/null"));
    expect(tokens(live)).toEqual([415, 615]);
  });

  test("an error the agent will retry is a retry notice with its message", async () => {
    const error = { method: "error", params: { threadId: "redacted-thread", turnId: "redacted-turn", willRetry: true, error: { message: "Reconnecting... 1/5" } } };
    const { live, stored } = await turn("codex", codexReplay([CODEX[0], error, ...CODEX.slice(1)], "/dev/null"));
    expect(progress(live).flatMap((value) => value.retry === undefined ? [] : [value.retry])).toEqual([{ reason: "Reconnecting... 1/5" }]);
    expect(stored.filter((e) => e.kind === "thinking" && e.text === "")).toEqual([]);
  });
});
