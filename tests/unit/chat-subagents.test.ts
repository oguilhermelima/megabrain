import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { parseClaudeLog, readSessionTurns, type LoggedTurn } from "../../src/chat/session-log.js";
import type { Chat, ChatEvent, ChatLine } from "../../src/chat/store.js";

// Fixtures, all captured on this machine and redacted:
// - chat-claude-subagents-stream.jsonl: claude -p stream-json (2.1.301) running two Agent calls in parallel.
// - chat-session/claude-subagents: a Claude session log with two background Agent calls and their
//   subagents/agent-<id>.jsonl logs (one ends on a final message, one is cut short after a refused tool).
// - chat-session/codex-subagents: a Codex rollout with a CollabAgentToolCall spawn and wait, and the
//   spawned thread's own rollout, which starts with the parent's forked history.
// The live Codex sequence below is not a capture: it follows the app-server v2 schema (codex 0.162.1,
// generate-ts) for collabAgentToolCall items and notifications carrying the spawned thread's id.

const FIXTURES = join(import.meta.dir, "../fixtures");
const STREAM = readFileSync(join(FIXTURES, "chat-claude-subagents-stream.jsonl"), "utf8").trim().split("\n");
const ALPHA = "toolu_01S2y5pJ7rhBh91bMEbMVwrt";
const MISSING = "toolu_01R7Yimw5kovmckmKN8zkR8t";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function scratch(prefix: string): string { const root = mkdtempSync(join(tmpdir(), prefix)); directories.push(root); return root; }

const parsed = (row: string) => JSON.parse(row) as Record<string, unknown>;
const isHandBack = (row: Record<string, unknown>) => {
  const content = (row.message as { content?: unknown } | undefined)?.content;
  return row.type === "user" && row.parent_tool_use_id === null && Array.isArray(content) && content.some((block) => [ALPHA, MISSING].includes((block as { tool_use_id?: string }).tool_use_id ?? ""));
};

/** The capture as a background run: each Agent result says launched right after its task starts, and the notification carries the end. */
function backgroundStream(): string[] {
  const rows = STREAM.map(parsed).filter((row) => !isHandBack(row));
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    out.push(row);
    if (row.type === "system" && row.subtype === "task_started") {
      const id = String(row.tool_use_id);
      out.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text: "Async agent launched successfully." }] }] }, tool_use_result: { isAsync: true, status: "async_launched", agentId: String(row.task_id), description: String(row.description) } });
    }
  }
  return out.map((row) => JSON.stringify(row));
}

/** The capture cut where the turn stops: no hand-back and no notification reach the chat. */
function interruptedStream(): string[] {
  return STREAM.map(parsed).filter((row) => !isHandBack(row) && !(row.type === "system" && (row.subtype === "task_notification" || row.subtype === "task_updated"))).map((row) => JSON.stringify(row));
}

async function harness(agent: "claude" | "codex", script: string) {
  const root = scratch("megabrain-subagents-");
  const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
  writeFileSync(join(bin, agent), `#!${process.execPath}\n${script}`);
  chmodSync(join(bin, agent), 0o700);
  const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
  await daemon.start();
  await daemon.listen();
  return { state, cwd, daemon };
}

function claudeReplay(rows: string[]): string {
  return `const rows = ${JSON.stringify(rows)};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async () => { for (const row of rows) { process.stdout.write(row + "\\n"); await new Promise((r) => setTimeout(r, 2)); } });
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

async function untilTurnIsIdleAfterWorking(events: () => ChatEvent[]) {
  await until(() => {
    const states = events().filter((event) => event.kind === "state").map((event) => event.text);
    const working = states.lastIndexOf("working");
    return working !== -1 && states.slice(working + 1).includes("idle");
  }, "turn returned to idle");
}

/** Runs one turn and returns everything the chat stored, deltas excluded, plus what followers saw live. */
async function turn(agent: "claude" | "codex", script: string, done: (events: ChatEvent[]) => boolean) {
  const h = await harness(agent, script);
  const chat = await h.daemon.handle({ operation: "start", agent, cwd: h.cwd }) as Chat;
  const watcher = follow(h.state, chat.id);
  try {
    await until(() => watcher.events().some((e) => e.kind === "state"), "follow started");
    // Codex is ready once its thread exists; a send before that races the thread/start answer back to idle.
    if (agent === "codex") await until(() => watcher.events().filter((e) => e.kind === "state").at(-1)?.text === "idle", "codex thread ready");
    await h.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
    await until(() => done(watcher.events()), "turn finished");
    await untilTurnIsIdleAfterWorking(watcher.events);
    await until(() => ends(watcher.events()).length === starts(watcher.events()).length, "subagents ended");
    const stored = (await h.daemon.store.events(chat.id)).flatMap((line) => line.event ? [line.event] : []);
    return { stored, live: watcher.events() };
  } finally { watcher.close(); await h.daemon.close(); }
}

const starts = (events: Pick<ChatEvent, "kind" | "subagent">[]) => events.filter((e) => e.kind === "tool-call" && e.subagent !== undefined);
const ends = (events: Pick<ChatEvent, "kind" | "subagent">[]) => events.filter((e) => e.kind === "tool-result" && e.subagent !== undefined);
const nested = <T extends Pick<ChatEvent, "parentId">>(events: T[], id: string) => events.filter((e) => e.parentId === id);

describe("Claude subagents in a live chat", () => {
  test("parallel Agent calls start one subagent each with its type and description", async () => {
    const { stored } = await turn("claude", claudeReplay(STREAM), (events) => events.some((e) => e.kind === "assistant" && e.text === "DONE"));
    expect(starts(stored).map((e) => e.subagent)).toEqual([
      { id: ALPHA, type: "general-purpose", description: "Run echo alpha" },
      { id: MISSING, type: "general-purpose", description: "Run ls on missing dir" },
    ]);
    expect(starts(stored).every((e) => e.tool?.name === "Agent" && (e.tool.input ?? "").includes("subagent_type"))).toBe(true);
    // The Agent call is the subagent's start; it never shows a second time as a plain tool call.
    expect(stored.filter((e) => e.kind === "tool-call" && e.tool?.name === "Agent" && e.subagent === undefined)).toEqual([]);
  });

  test("the subagents' own steps carry their parent and never join the main transcript", async () => {
    const { stored } = await turn("claude", claudeReplay(STREAM), (events) => events.some((e) => e.kind === "assistant" && e.text === "DONE"));
    expect(nested(stored, ALPHA).map((e) => [e.kind, e.tool?.name, e.tool?.status])).toEqual([["tool-call", "Bash", undefined], ["tool-result", "Bash", "ok"]]);
    expect(nested(stored, ALPHA)[0]?.tool?.input).toContain("echo alpha");
    expect(nested(stored, ALPHA)[1]?.text).toBe("alpha");
    expect(nested(stored, MISSING).map((e) => [e.kind, e.tool?.status])).toEqual([["tool-call", undefined], ["tool-result", "error"]]);
    // Nothing a subagent did reaches the main flow: no Bash outside a parent, no subagent prompt as a user message.
    expect(stored.filter((e) => e.parentId === undefined && e.tool?.name === "Bash")).toEqual([]);
    expect(stored.filter((e) => e.kind === "user").map((e) => e.text)).toEqual(["go"]);
    expect(stored.find((e) => e.kind === "assistant" && e.text === "DONE")?.parentId).toBeUndefined();
  });

  test("each subagent ends once, with its final report as the result", async () => {
    const { stored } = await turn("claude", claudeReplay(STREAM), (events) => events.some((e) => e.kind === "assistant" && e.text === "DONE"));
    expect(ends(stored).map((e) => [e.subagent?.id, e.subagent?.status, e.tool?.name])).toEqual([[ALPHA, "completed", "Agent"], [MISSING, "completed", "Agent"]]);
    expect(ends(stored)[0]?.text).toBe("alpha");
    expect(ends(stored)[1]?.text).toContain("No such file or directory");
    expect(stored.filter((e) => e.kind === "tool-result" && e.subagent === undefined && e.tool?.name === "Agent")).toEqual([]);
  });

  test("a background subagent ends on its task notification, not on its launch receipt", async () => {
    const { stored } = await turn("claude", claudeReplay(backgroundStream()), (events) => events.some((e) => e.kind === "assistant" && e.text === "DONE"));
    expect(starts(stored)).toHaveLength(2);
    expect(ends(stored).map((e) => [e.subagent?.id, e.subagent?.status, e.text])).toEqual([[ALPHA, "completed", "alpha"], [MISSING, "completed", expect.stringContaining("No such file or directory")]]);
    expect(stored.some((e) => e.text.startsWith("Async agent launched"))).toBe(false);
    const tasks = stored.flatMap((event) => event.backgroundTask ? [event.backgroundTask] : []);
    expect(tasks.filter((task) => task.id === ALPHA).map((task) => task.state)).toEqual(["running", "completed"]);
    expect(tasks.filter((task) => task.id === MISSING).map((task) => task.state)).toEqual(["running", "completed"]);
  });

  test("a Claude stream interrupt after partial text records one named cut", async () => {
    const h = await harness("claude", claudeReplay([
      JSON.stringify({ type: "system", subtype: "init", session_id: "partial-session" }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "unfinished" } } }),
    ]));
    const chat = await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd }) as Chat;
    const watcher = follow(h.state, chat.id);
    try {
      await until(() => watcher.events().some((event) => event.kind === "state"), "follow started");
      await h.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
      await until(() => watcher.events().some((event) => event.kind === "delta" && event.text === "unfinished"), "partial text");
      await h.daemon.handle({ operation: "interrupt", id: chat.id });
      await until(() => watcher.events().some((event) => event.kind === "turn-cut"), "cut event");
      const cuts = (await h.daemon.store.events(chat.id)).flatMap((line) => line.event?.kind === "turn-cut" ? [line.event] : []);
      expect(cuts).toHaveLength(1);
      expect(cuts[0]).toMatchObject({ reason: "interrupted", partial: true });
    } finally { watcher.close(); await h.daemon.close(); }
  });

  test("a provider-finished turn has no cut event", async () => {
    const { stored } = await turn("claude", claudeReplay([
      JSON.stringify({ type: "assistant", message: { id: "finished", content: [{ type: "text", text: "complete" }] } }),
      JSON.stringify({ type: "result", session_id: "finished-session", is_error: false }),
    ]), (events) => events.some((event) => event.kind === "assistant" && event.text === "complete"));
    expect(stored.filter((event) => event.kind === "turn-cut")).toEqual([]);
  });

  test("a Claude process exit during partial output names the cut", async () => {
    const script = `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).once("line", () => {
  process.stdout.write(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "unfinished" } } }) + "\\n");
  setTimeout(() => process.exit(1), 20);
});`;
    const h = await harness("claude", script);
    const chat = await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd }) as Chat;
    const watcher = follow(h.state, chat.id);
    try {
      await until(() => watcher.events().some((event) => event.kind === "state"), "follow started");
      await h.daemon.handle({ operation: "send", id: chat.id, parts: [{ type: "text", text: "go" }] });
      await until(() => watcher.events().some((event) => event.kind === "turn-cut"), "process exit cut");
      const cuts = (await h.daemon.store.events(chat.id)).flatMap((line) => line.event?.kind === "turn-cut" ? [line.event] : []);
      expect(cuts).toHaveLength(1);
      expect(cuts[0]).toMatchObject({ reason: "process-exited", partial: true });
    } finally { watcher.close(); await h.daemon.close(); }
  });

  test("a foreground subagent still open when the turn ends is stopped", async () => {
    const { stored } = await turn("claude", claudeReplay(interruptedStream()), (events) => events.some((e) => e.kind === "assistant" && e.text === "DONE"));
    expect(ends(stored).map((e) => [e.subagent?.id, e.subagent?.status])).toEqual([[ALPHA, "stopped"], [MISSING, "stopped"]]);
  });
});

describe("Codex subagents in a live chat", () => {
  const MAIN = "main-thread", CHILD = "child-thread";
  const notifications = [
    { method: "turn/started", params: { threadId: MAIN, turnId: "turn-main" } },
    { method: "item/started", params: { threadId: MAIN, turnId: "turn-main", item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "inProgress", senderThreadId: MAIN, receiverThreadIds: [], prompt: "Map the repo", model: "gpt-6-luna", reasoningEffort: null, agentsStates: {} } } },
    { method: "item/completed", params: { threadId: MAIN, turnId: "turn-main", item: { type: "collabAgentToolCall", id: "collab-1", tool: "spawnAgent", status: "completed", senderThreadId: MAIN, receiverThreadIds: [CHILD], prompt: "Map the repo", model: "gpt-6-luna", reasoningEffort: null, agentsStates: { [CHILD]: { status: "pendingInit", message: null } } } } },
    { method: "turn/started", params: { threadId: CHILD, turnId: "turn-child" } },
    { method: "item/started", params: { threadId: CHILD, turnId: "turn-child", item: { type: "commandExecution", id: "cmd-1", command: "ls" } } },
    { method: "item/completed", params: { threadId: CHILD, turnId: "turn-child", item: { type: "commandExecution", id: "cmd-1", command: "ls", aggregatedOutput: "a.txt", exitCode: 0 } } },
    { method: "item/agentMessage/delta", params: { threadId: CHILD, turnId: "turn-child", itemId: "msg-child", delta: "Found" } },
    { method: "item/completed", params: { threadId: CHILD, turnId: "turn-child", item: { type: "agentMessage", id: "msg-child", text: "Found a.txt" } } },
    { method: "thread/tokenUsage/updated", params: { threadId: CHILD, turnId: "turn-child", tokenUsage: { last: { inputTokens: 99999 }, modelContextWindow: 1 } } },
    { method: "turn/completed", params: { threadId: CHILD, turn: { id: "turn-child", status: "completed" } } },
    { method: "item/completed", params: { threadId: MAIN, turnId: "turn-main", item: { type: "collabAgentToolCall", id: "collab-2", tool: "wait", status: "completed", senderThreadId: MAIN, receiverThreadIds: [CHILD], prompt: null, model: null, reasoningEffort: null, agentsStates: { [CHILD]: { status: "completed", message: "Found a.txt" } } } } },
    { method: "item/completed", params: { threadId: MAIN, turnId: "turn-main", item: { type: "collabAgentToolCall", id: "collab-3", tool: "closeAgent", status: "completed", senderThreadId: MAIN, receiverThreadIds: [CHILD], prompt: null, model: null, reasoningEffort: null, agentsStates: { [CHILD]: { status: "completed", message: "Found a.txt" } } } } },
    { method: "item/completed", params: { threadId: MAIN, turnId: "turn-main", item: { type: "agentMessage", id: "msg-main", text: "Subagent done." } } },
    { method: "turn/completed", params: { threadId: MAIN, turn: { id: "turn-main", status: "completed" } } },
  ];
  const script = `const notifications = ${JSON.stringify(notifications)};
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + "\\n");
  if (request.method === "thread/start") process.stdout.write(JSON.stringify({ id: request.id, result: { thread: { id: "${MAIN}" } } }) + "\\n");
  if (request.method === "turn/start") {
    process.stdout.write(JSON.stringify({ id: request.id, result: { turn: { id: "turn-main" } } }) + "\\n");
    for (const note of notifications) { process.stdout.write(JSON.stringify(note) + "\\n"); await new Promise((r) => setTimeout(r, 5)); }
  }
});
`;

  test("a spawned thread becomes one subagent with its own steps, ended by the wait that reports it", async () => {
    const { stored, live } = await turn("codex", script, (events) => events.some((e) => e.kind === "assistant" && e.text === "Subagent done."));
    expect(starts(stored).map((e) => e.subagent)).toEqual([{ id: CHILD, description: "Map the repo" }]);
    expect(nested(stored, CHILD).map((e) => [e.kind, e.text])).toEqual([["tool-call", "ls"], ["tool-result", "a.txt"], ["assistant", "Found a.txt"]]);
    expect(ends(stored).map((e) => [e.subagent?.id, e.subagent?.status, e.text])).toEqual([[CHILD, "completed", "Found a.txt"]]);
    expect(stored.flatMap((event) => event.backgroundTask ? [event.backgroundTask] : []).filter((task) => task.id === CHILD).map((task) => task.state)).toEqual(["running", "completed"]);
    // The child's chunks, turn and usage are not the main chat's: no live delta, no early idle, no context change.
    expect(live.filter((e) => e.kind === "delta" && e.messageId === "msg-child")).toEqual([]);
    const sent = stored.findIndex((e) => e.kind === "user");
    const main = stored.findIndex((e) => e.kind === "assistant" && e.text === "Subagent done.");
    expect(stored.slice(sent, main).filter((e) => e.kind === "state" && e.text === "idle")).toHaveLength(0);
    expect(stored.find((e) => e.kind === "assistant" && e.text === "Subagent done.")?.parentId).toBeUndefined();
  });
});

describe("subagents imported from a session log", () => {
  test("Claude Bash background tasks keep their id from launch through notification", () => {
    const log = [
      { type: "assistant", uuid: "launch-row", timestamp: "2026-10-17T10:00:00.000Z", message: { id: "m1", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "bun run build", description: "Build", run_in_background: "true" } }] } },
      { type: "user", uuid: "receipt-row", timestamp: "2026-10-17T10:00:01.000Z", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: [{ type: "text", text: "Running" }] }] }, toolUseResult: { status: "async_launched" } },
      { type: "system", subtype: "task_notification", uuid: "done-row", timestamp: "2026-10-17T10:01:00.000Z", tool_use_id: "bash-1", status: "completed", summary: "Build passed" },
    ].map((row) => JSON.stringify(row)).join("\n");
    const tasks = parseClaudeLog(log).flatMap((turn) => turn.backgroundTask ? [turn.backgroundTask] : []);
    expect(tasks.map((task) => [task.id, task.state])).toEqual([["bash-1", "running"], ["bash-1", "completed"]]);
  });

  test("a Claude session log interruption imports a turn-cut event", () => {
    const log = [
      { type: "assistant", uuid: "answer-row", timestamp: "2026-10-17T10:00:00.000Z", message: { id: "m1", content: [{ type: "text", text: "partial answer" }] } },
      { type: "user", uuid: "interrupt-row", timestamp: "2026-10-17T10:00:01.000Z", message: { content: "[Request interrupted by user]" } },
    ].map((row) => JSON.stringify(row)).join("\n");
    expect(parseClaudeLog(log).filter((turn) => turn.kind === "turn-cut").map((turn) => ({ reason: turn.reason, partial: turn.partial }))).toEqual([{ reason: "interrupted", partial: true }]);
  });

  test("a background Bash stays running after its launch receipt and ends on its task notification", () => {
    const log = readFileSync(join(FIXTURES, "chat-session", "claude-background-shell.jsonl"), "utf8");
    const turns = parseClaudeLog(log);
    const tasks = turns.flatMap((turn) => turn.backgroundTask ? [turn.backgroundTask] : []);
    expect(tasks.map(({ state, id }) => [id, state])).toEqual([["toolu_shell", "running"], ["toolu_shell", "completed"]]);
    expect(tasks[0]?.endedAt).toBeUndefined();
    expect(tasks[1]).toMatchObject({ endedAt: "2026-10-20T12:05:00.000Z", summary: "Build finished" });
  });

  test("Claude: each Agent call joins its subagents/agent-<id>.jsonl steps under it", async () => {
    const home = scratch("megabrain-subagent-log-");
    const cwd = "/Users/operator/Workspaces/Canto";
    const session = "efa46a46-aa50-4bed-962b-4b89182102c2";
    const project = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(project, { recursive: true });
    cpSync(join(FIXTURES, "chat-session", "claude-subagents"), project, { recursive: true });
    const turns = await readSessionTurns({ agent: "claude", cwd, agentSessionId: session }, home);
    const DETAILS = "toolu_01WiRpje4CMPEhWG4fLm64HJ", VIDEOS = "toolu_01W8evryRJdd731YzWPF6auQ";
    expect(starts(turns).map((t) => t.subagent)).toEqual([
      { id: DETAILS, type: "general-purpose", description: "Details sheet with full info" },
      { id: VIDEOS, type: "Explore", description: "Map web media videos tab" },
    ]);
    // A launch receipt is not a result.
    expect(turns.some((t) => t.text.startsWith("Async agent launched"))).toBe(false);
    expect(nested(turns, VIDEOS).map((t) => [t.kind, t.tool?.name, t.tool?.status])).toEqual([["tool-call", "Bash", undefined], ["tool-result", "Bash", "ok"], ["tool-call", "Bash", undefined], ["tool-result", "Bash", "error"]]);
    expect(nested(turns, DETAILS).map((t) => t.kind)).toEqual(["assistant"]);
    // The prompt a subagent was given is the start's input, never a user message of the chat.
    expect(turns.filter((t) => t.kind === "user")).toEqual([]);
    // One ends on its final message; the other was cut off and the TUI that ran it is gone.
    expect(ends(turns).map((t) => [t.subagent?.id, t.subagent?.status])).toEqual([[DETAILS, "completed"], [VIDEOS, "stopped"]]);
    expect(ends(turns)[0]?.text).toContain("weekly limit");
    expectOrderedAndUnique(turns);
  });

  test("Codex: a spawned thread's own rollout, after its forked history, joins under the spawn", async () => {
    const home = scratch("megabrain-subagent-rollout-");
    const day = join(home, ".codex", "sessions", "2026", "09", "04");
    mkdirSync(day, { recursive: true });
    cpSync(join(FIXTURES, "chat-session", "codex-subagents"), day, { recursive: true });
    const CHILD = "01a06c1e-9a42-71b2-912d-27a25b647ffc";
    const turns = await readSessionTurns({ agent: "codex", cwd: "/Users/operator/Workspaces/local/stack", agentSessionId: "01a06b97-cdd1-7ff3-b96a-88514da569a0" }, home);
    expect(starts(turns).map((t) => t.subagent)).toEqual([{ id: CHILD, type: "Nash", description: "Work only in scripts/site.user.js: make the userscript robust on the new mirror domains." }]);
    expect(nested(turns, CHILD).map((t) => [t.kind, t.text])).toEqual([
      ["thinking", "Checking which domains the script matches."],
      ["assistant", "Reading the userscript first."],
      ["tool-call", "exec"],
      ["tool-result", "// ==UserScript==\n// @name site"],
      ["assistant", "Done without a commit: the userscript now supports the mirror domains and keeps the reader."],
    ]);
    // The wait and the close both report the end; it is told once.
    expect(ends(turns).map((t) => [t.subagent?.id, t.subagent?.status, t.text])).toEqual([[CHILD, "completed", "Done without a commit: the userscript now supports the mirror domains and keeps the reader."]]);
    expect(turns.filter((t) => t.parentId === undefined).map((t) => t.kind)).toEqual(["user", "tool-call", "background-task", "tool-result", "background-task", "assistant"]);
    expect(turns.flatMap((turn) => turn.backgroundTask ? [turn.backgroundTask.state] : [])).toEqual(["running", "completed"]);
    expectOrderedAndUnique(turns);
  });
});

function expectOrderedAndUnique(turns: LoggedTurn[]): void {
  expect(new Set(turns.map((t) => t.sourceId)).size).toBe(turns.length);
  expect(turns.map((t) => t.at)).toEqual(turns.map((t) => t.at).sort());
}
