import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ChatStore, type Chat, type ChatEvent } from "../../src/chat/store.js";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { ChatSummarizer, parseSummarySettings, readSummaries, searchSummaries, defaultSummarySettings, type SummarySettings } from "../../src/chat/summaries.js";
import { executeChat } from "../../src/cli/commands/chat.js";
import { executeSettings } from "../../src/cli/commands/settings.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

type Call = { args: string[]; stdin: string; cwd: string; entries: string[] };

/** A state dir, a fake claude on PATH that logs every call, and a store; `mode` picks how the fake answers. */
async function harness(settings: Partial<SummarySettings> = {}) {
  const root = mkdtempSync(join(tmpdir(), "megabrain-summaries-"));
  directories.push(root);
  const state = join(root, "state"), bin = join(root, "bin"), project = join(root, "project"), log = join(root, "calls.jsonl"), mode = join(root, "mode");
  for (const directory of [state, bin, project]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(mode, "ok");
  const script = `#!${process.execPath}
const fs = require("node:fs");
let stdin = ""; try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd(), entries: fs.readdirSync(process.cwd()) }) + "\\n");
const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim();
const count = fs.readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
if (mode === "fail") { process.stderr.write("quota exceeded\\n"); process.exit(1); }
if (mode === "hang") setTimeout(() => {}, 60000);
else setTimeout(() => process.stdout.write(mode === "long" ? "TITLE: " + "x".repeat(200) + "\\nSUMMARY: long title\\n" : "TITLE: Fix login redirect " + count + "\\nSUMMARY: Summary number " + count + " about login.\\n"), mode === "slow" ? 300 : 0);
`;
  for (const name of ["claude", "codex", "grok", "agy"]) { writeFileSync(join(bin, name), script); chmodSync(join(bin, name), 0o700); }
  const environment = { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`, MEGABRAIN_STATE_DIR: state, MEGABRAIN_CHAT_SUMMARY_TIMEOUT_MS: "30000" };
  writeFileSync(join(state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, agent: "claude", model: "haiku", ...settings }));
  const store = new ChatStore(state);
  await store.initialize();
  const emitted: Array<{ chat: Chat; event: ChatEvent }> = [];
  const summarizer = new ChatSummarizer({ store, stateDir: state, environment, emit: async (chat, event) => { emitted.push({ chat, event }); } });
  const calls = (): Call[] => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Call) : [];
  return { root, state, project, store, summarizer, emitted, calls, environment, setMode: (value: string) => writeFileSync(mode, value) };
}

async function seedChat(h: Awaited<ReturnType<typeof harness>>, overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = { id: randomUUID(), agent: "claude", model: null, cwd: h.project, title: "first message", state: "idle", mode: "chat", agentSessionId: null, createdAt: new Date().toISOString(), lastActivityAt: null, summary: null, titleSource: "first-message", ...overrides };
  await h.store.put(chat);
  return chat;
}

let eventClock = 0;
async function turn(h: Awaited<ReturnType<typeof harness>>, chat: Chat, user: string, assistant = "done") {
  for (const [kind, text] of [["user", user], ["assistant", assistant]] as const) {
    await h.store.append(chat.id, { id: randomUUID(), at: new Date(Date.now() + (eventClock += 1)).toISOString(), kind, text });
  }
}

describe("summary settings", () => {
  test("defaults are off and validated", () => {
    expect(defaultSummarySettings).toMatchObject({ enabled: false, everyMessages: 6, everyMinutes: 10, retitle: true });
    expect(parseSummarySettings("{}").kind).toBe("ok");
    for (const bad of ["not json", `{"agent":"gpt"}`, `{"everyMessages":0}`, `{"everyMinutes":-1}`, `{"enabled":"yes"}`, `{"model":3}`, `{"extra":1}`]) expect(parseSummarySettings(bad).kind).toBe("failed");
  });

  test("settings get and set chat-summaries round trip through the state dir", async () => {
    const h = await harness();
    const environment = { MEGABRAIN_STATE_DIR: h.state, HOME: h.root };
    const set = await executeSettings(["set", "chat-summaries", JSON.stringify({ enabled: true, agent: "agy", model: "flash", effort: "low", everyMessages: 3 })], environment, undefined as never);
    expect(set.kind).toBe("ok");
    const got = await executeSettings(["get", "chat-summaries"], environment, undefined as never);
    expect(got.kind === "ok" && JSON.parse(got.value)).toMatchObject({ enabled: true, agent: "agy", model: "flash", effort: "low", everyMessages: 3, everyMinutes: 10, retitle: true });
  });
});

describe("summary triggers", () => {
  test("disabled never calls an agent", async () => {
    const h = await harness({ enabled: false });
    const chat = await seedChat(h);
    for (let index = 0; index < 8; index += 1) await turn(h, chat, `message ${index}`);
    await h.summarizer.turnEnded(chat.id);
    expect(h.calls()).toHaveLength(0);
  });

  test("everyMessages user turns trigger a summary, fewer do not", async () => {
    const h = await harness({ everyMessages: 3, everyMinutes: 1000 });
    const chat = await seedChat(h);
    await turn(h, chat, "one"); await turn(h, chat, "two");
    await h.summarizer.turnEnded(chat.id);
    expect(h.calls()).toHaveLength(0);
    await turn(h, chat, "three");
    await h.summarizer.turnEnded(chat.id);
    expect(h.calls()).toHaveLength(1);
    // Counting restarts from the summary: two more turns are not enough.
    await turn(h, chat, "four"); await turn(h, chat, "five");
    await h.summarizer.turnEnded(chat.id);
    expect(h.calls()).toHaveLength(1);
  });

  test("everyMinutes triggers on one new turn once enough time passed since the chat or last summary", async () => {
    const h = await harness({ everyMessages: 100, everyMinutes: 10 });
    const fresh = await seedChat(h);
    await turn(h, fresh, "hello");
    await h.summarizer.turnEnded(fresh.id);
    expect(h.calls()).toHaveLength(0);
    const old = await seedChat(h, { createdAt: new Date(Date.now() - 11 * 60_000).toISOString() });
    await turn(h, old, "hello");
    await h.summarizer.turnEnded(old.id);
    expect(h.calls()).toHaveLength(1);
    // No new user turn since the summary: time alone never triggers.
    await h.summarizer.turnEnded(old.id);
    expect(h.calls()).toHaveLength(1);
  });
});

describe("summary job", () => {
  test("runs the configured agent in an empty directory with tools off, and stores the summary", async () => {
    const h = await harness({ everyMessages: 1, model: "haiku", effort: "low" });
    const chat = await seedChat(h);
    await turn(h, chat, "please fix the login redirect", "I changed the redirect handler");
    await h.summarizer.turnEnded(chat.id);
    const [call] = h.calls();
    expect(call?.args).toContain("-p");
    expect(call?.args.join(" ")).toContain("--model haiku");
    expect(call?.args.join(" ")).toContain("--effort low");
    const tools = call?.args.indexOf("--tools") ?? -1;
    expect(tools).toBeGreaterThan(-1);
    expect(call?.args[tools + 1]).toBe("");
    expect(call?.cwd).not.toBe(h.project);
    expect(call?.entries).toEqual([]);
    expect(call?.stdin).toContain("please fix the login redirect");
    const stored = await h.store.get(chat.id);
    expect(stored?.summary).toMatchObject({ text: "Summary number 1 about login.", model: "haiku" });
    expect(Date.parse(stored?.summary?.updatedAt ?? "")).toBeGreaterThan(0);
    expect(readSummaries(h.state, chat.id).map((entry) => entry.text)).toEqual(["Summary number 1 about login."]);
    expect(h.emitted.map((entry) => entry.event.kind)).toContain("summary");
  });

  test("the second summary is incremental: previous summary in, already-summarised turns out", async () => {
    const h = await harness({ everyMessages: 1 });
    const chat = await seedChat(h);
    await turn(h, chat, "alpha topic request");
    await h.summarizer.turnEnded(chat.id);
    await turn(h, chat, "beta follow up request");
    await h.summarizer.turnEnded(chat.id);
    const [first, second] = h.calls();
    expect(first?.stdin).not.toContain("Previous summary");
    expect(second?.stdin).toContain("Summary number 1 about login.");
    expect(second?.stdin).toContain("beta follow up request");
    expect(second?.stdin).not.toContain("alpha topic request");
    expect(readSummaries(h.state, chat.id).map((entry) => entry.text)).toEqual(["Summary number 2 about login.", "Summary number 1 about login."]);
  });

  test("only one job runs per chat at a time", async () => {
    const h = await harness({ everyMessages: 1 });
    h.setMode("slow");
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await Promise.all([h.summarizer.turnEnded(chat.id), h.summarizer.turnEnded(chat.id), h.summarizer.turnEnded(chat.id)]);
    expect(h.calls()).toHaveLength(1);
  });

  test("an agent failure leaves the chat alone and the next trigger retries", async () => {
    const h = await harness({ everyMessages: 1 });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    h.setMode("fail");
    await expect(h.summarizer.turnEnded(chat.id)).resolves.toBeUndefined();
    expect(await h.store.get(chat.id)).toEqual(chat);
    expect(h.emitted).toHaveLength(0);
    h.setMode("ok");
    await h.summarizer.turnEnded(chat.id);
    expect(h.calls()).toHaveLength(2);
    expect((await h.store.get(chat.id))?.summary?.text).toBe("Summary number 2 about login.");
  });

  test("a hung agent is killed at the timeout and the chat is untouched", async () => {
    const h = await harness({ everyMessages: 1 });
    h.setMode("hang");
    h.environment.MEGABRAIN_CHAT_SUMMARY_TIMEOUT_MS = "1500";
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    const started = Date.now();
    await h.summarizer.turnEnded(chat.id);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await h.store.get(chat.id))?.summary).toBeNull();
  });

  test("a missing agent binary is a logged failure, not a throw", async () => {
    const h = await harness({ everyMessages: 1 });
    const missing = new ChatSummarizer({ store: h.store, stateDir: h.state, environment: { ...h.environment, PATH: "/nonexistent" }, emit: async () => {} });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await expect(missing.turnEnded(chat.id)).resolves.toBeUndefined();
    expect((await h.store.get(chat.id))?.summary).toBeNull();
  });

  test("summarize on demand ignores the thresholds and reports failure", async () => {
    const h = await harness({ everyMessages: 100, everyMinutes: 1000 });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    const summary = await h.summarizer.summarize(chat.id);
    expect(summary.text).toBe("Summary number 1 about login.");
    h.setMode("fail");
    await turn(h, chat, "two");
    await expect(h.summarizer.summarize(chat.id)).rejects.toThrow();
  });
});

describe("automatic titles", () => {
  test("the summary becomes the title, short, and titleSource moves to summary", async () => {
    const h = await harness({ everyMessages: 1 });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await h.summarizer.turnEnded(chat.id);
    const stored = await h.store.get(chat.id);
    expect(stored).toMatchObject({ title: "Fix login redirect 1", titleSource: "summary" });
    expect(h.emitted.some((entry) => entry.event.kind === "state")).toBe(true);
  });

  test("a title over 60 characters is cut", async () => {
    const h = await harness({ everyMessages: 1 });
    h.setMode("long");
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await h.summarizer.turnEnded(chat.id);
    expect(((await h.store.get(chat.id))?.title ?? "").length).toBeLessThanOrEqual(60);
  });

  test("a person-set title is never replaced, though the summary is still stored", async () => {
    const h = await harness({ everyMessages: 1 });
    const chat = await seedChat(h, { title: "My own name", titleSource: "person" });
    await turn(h, chat, "one");
    await h.summarizer.turnEnded(chat.id);
    const stored = await h.store.get(chat.id);
    expect(stored).toMatchObject({ title: "My own name", titleSource: "person" });
    expect(stored?.summary?.text).toBe("Summary number 1 about login.");
    expect(h.emitted.some((entry) => entry.event.kind === "state")).toBe(false);
  });

  test("retitle off keeps the title", async () => {
    const h = await harness({ everyMessages: 1, retitle: false });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await h.summarizer.turnEnded(chat.id);
    expect(await h.store.get(chat.id)).toMatchObject({ title: "first message", titleSource: "first-message" });
  });

  test("the daemon records a person's rename as titleSource person", async () => {
    const h = await harness();
    const daemon = new ChatDaemon(h.state, h.environment);
    await daemon.start();
    const chat = await seedChat(h);
    await daemon.handle({ operation: "rename", id: chat.id, title: "Renamed by hand" });
    expect(await h.store.get(chat.id)).toMatchObject({ title: "Renamed by hand", titleSource: "person" });
    await daemon.close();
  });
});

describe("search and cli", () => {
  test("the index finds past chats by project, branch, title and summary", async () => {
    const h = await harness({ everyMessages: 1 });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await h.summarizer.turnEnded(chat.id);
    const other = await seedChat(h);
    h.setMode("ok");
    await turn(h, other, "two");
    await h.summarizer.turnEnded(other.id);
    const hits = searchSummaries(h.state, "LOGIN");
    expect(hits.map((hit) => hit.chatId).sort()).toEqual([chat.id, other.id].sort());
    expect(hits[0]).toMatchObject({ project: "project", branch: null, summary: expect.stringContaining("login"), title: expect.any(String) });
    expect(searchSummaries(h.state, "project")).toHaveLength(2);
    expect(searchSummaries(h.state, "nothing like this")).toEqual([]);
  });

  test("chat summaries and chat search answer from the files without a daemon", async () => {
    const h = await harness({ everyMessages: 1 });
    const chat = await seedChat(h);
    await turn(h, chat, "one");
    await h.summarizer.turnEnded(chat.id);
    const listed = await executeChat(["summaries", chat.id, "--json"], h.environment, undefined as never);
    expect(listed.kind === "ok" && JSON.parse(listed.value)).toHaveLength(1);
    const found = await executeChat(["search", "login", "--json"], h.environment, undefined as never);
    expect(found.kind === "ok" && JSON.parse(found.value)[0]).toMatchObject({ chatId: chat.id });
    expect((await executeChat(["search", "login"], h.environment, undefined as never)).kind).toBe("failed");
  });
});
