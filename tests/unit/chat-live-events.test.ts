import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { ChatDaemon } from "../../src/chat/daemon.js";
import type { Chat, ChatEvent, ChatLine } from "../../src/chat/store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const recorded = (name: string) => readFileSync(join(process.cwd(), "tests/fixtures", name), "utf8").trim().split("\n");
const stream = recorded("chat-claude-stream.jsonl");

async function harness(rows = stream) {
  const root = mkdtempSync(join(tmpdir(), "megabrain-live-"));
  directories.push(root);
  const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
  // Replays the recorded stream on the first user line; the init row is printed up front like Claude does.
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const rows = ${JSON.stringify(rows)};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async () => { for (const row of rows) { process.stdout.write(row + "\\n"); await new Promise((r) => setTimeout(r, 5)); } });
`);
  chmodSync(join(bin, "claude"), 0o700);
  const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
  await daemon.start();
  await daemon.listen();
  return { state, cwd, daemon };
}

function follow(state: string, id: string, since = 0) {
  const lines: ChatLine[] = [];
  const socket = createConnection(join(state, "chatd", "s"));
  let buffer = "";
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write(JSON.stringify({ operation: "events", id, since, follow: true }) + "\n"));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) !== -1) { lines.push(JSON.parse(buffer.slice(0, end)) as ChatLine); buffer = buffer.slice(end + 1); }
  });
  return { lines, events: () => lines.flatMap((line) => line.event ? [line.event] : []), close: () => socket.destroy() };
}

async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (check()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out: ${label}`);
}

async function run(rows = stream) {
  const h = await harness(rows);
  const chat = await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd }) as Chat;
  const watcher = follow(h.state, chat.id);
  await until(() => watcher.events().some((e) => e.kind === "state"), "state event on follow start");
  await h.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
  await until(() => watcher.events().some((e) => e.kind === "assistant"), "final assistant");
  await until(() => watcher.events().filter((e) => e.kind === "state").at(-1)?.text === "idle", "idle state");
  return { h, chat, watcher };
}

async function runUntilAssistant(rows: string[]) {
  const h = await harness(rows);
  const chat = await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd }) as Chat;
  const watcher = follow(h.state, chat.id);
  await until(() => watcher.events().some((e) => e.kind === "state"), "state event on follow start");
  await h.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
  await until(() => watcher.events().some((e) => e.kind === "assistant"), "final assistant");
  return { h, chat, watcher };
}

describe("live chat events", () => {
  test("sends deltas grouped by message id and never stores them", async () => {
    const { h, chat, watcher } = await run();
    try {
      const deltas = watcher.events().filter((e) => e.kind === "delta");
      expect(deltas.filter((e) => e.stream === "thinking").map((e) => [e.messageId, e.text])).toEqual([["msg_01", "Let me "], ["msg_01", "check."]]);
      expect(deltas.filter((e) => e.stream === "assistant").map((e) => [e.messageId, e.text])).toEqual([["msg_02", "One "], ["msg_02", "file."]]);
      expect(watcher.events().find((e) => e.kind === "assistant")).toMatchObject({ messageId: "msg_02", text: "One file." });
      expect(watcher.events().find((e) => e.kind === "thinking")).toMatchObject({ messageId: "msg_01", text: "Let me check." });
      const stored = await h.daemon.store.events(chat.id);
      expect(stored.some((line) => line.event?.kind === "delta")).toBe(false);
    } finally { watcher.close(); await h.daemon.close(); }
  });

  test("publishes state on every change and once at the start of a follow", async () => {
    const { h, chat, watcher } = await run();
    try {
      const states = watcher.events().filter((e) => e.kind === "state").map((e) => e.text);
      expect(states[0]).toBe("starting");
      expect(states).toContain("working");
      expect(states.at(-1)).toBe("idle");
      const working = watcher.events().find((e) => e.kind === "state" && e.text === "working");
      expect(Number.isNaN(Date.parse(working?.turnStartedAt ?? ""))).toBe(false);
      const stored = (await h.daemon.store.events(chat.id)).flatMap((line) => line.event ? [line.event] : []);
      expect(stored.filter((e) => e.kind === "state").map((e) => e.text)).toEqual(expect.arrayContaining(["working", "idle"]));
      const late = follow(h.state, chat.id, Number(stored.length + 100));
      await until(() => late.events().length > 0, "state on late follow");
      expect(late.events()).toEqual([expect.objectContaining({ kind: "state", text: "idle" })]);
      late.close();
    } finally { watcher.close(); await h.daemon.close(); }
  });

  test("emits the tool call when the tool starts and the result sets status", async () => {
    const { h, watcher } = await run();
    try {
      const events: ChatEvent[] = watcher.events();
      const call = events.findIndex((e) => e.kind === "tool-call");
      const result = events.findIndex((e) => e.kind === "tool-result");
      expect(call).toBeGreaterThan(-1);
      expect(events.filter((e) => e.kind === "tool-call")).toHaveLength(1);
      expect(events[call]?.tool).toEqual({ name: "Bash", input: "" });
      expect(events[call]?.tool?.status).toBeUndefined();
      expect(result).toBeGreaterThan(call);
      expect(events[result]).toMatchObject({ text: "a.txt", tool: { name: "Bash", status: "ok" } });
    } finally { watcher.close(); await h.daemon.close(); }
  });

  // Claude 5 streams thinking chunks but its complete message keeps only the block's signature.
  test("a thinking block with only a signature stores no thinking, and its tool call names no message", async () => {
    const { h, chat, watcher } = await runUntilAssistant(recorded("chat-claude-empty-thinking-stream.jsonl"));
    try {
      const events = watcher.events();
      expect(events.filter((e) => e.kind === "delta" && e.stream === "thinking").map((e) => [e.messageId, e.text])).toEqual([["msg_01", "Checking the folder."]]);
      expect(events.some((e) => e.kind === "thinking")).toBe(false);
      expect(events.find((e) => e.kind === "tool-call")?.messageId).toBeUndefined();
      expect(events.find((e) => e.kind === "assistant")).toMatchObject({ messageId: "msg_02", text: "One file." });
      const stored = await h.daemon.store.events(chat.id);
      expect(stored.some((line) => line.event?.kind === "thinking")).toBe(false);
    } finally { watcher.close(); await h.daemon.close(); }
  });
});
