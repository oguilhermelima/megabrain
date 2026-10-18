import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backfillSummaries } from "../../src/knowledge/backfill.js";
import { knowledgeContext } from "../../src/knowledge/library.js";
import { KnowledgePipeline, type SessionInput } from "../../src/knowledge/pipeline.js";
import { scanProjects } from "../../src/knowledge/scanner.js";
import { defaultKnowledgeSettings, effectiveToggles, parseKnowledgeSettings, readKnowledgeSettings } from "../../src/knowledge/settings.js";
import { ChatStore } from "../../src/chat/store.js";
import { openProject } from "../../src/knowledge/store.js";
import type { Topic } from "../../src/knowledge/types.js";
import { executeHookSessionStart } from "../../src/cli/commands/hook-session-start.js";
import { executeKnowledge } from "../../src/cli/commands/knowledge.js";
import { executeSettings } from "../../src/cli/commands/settings.js";
import { executeSummaries } from "../../src/cli/commands/summaries.js";
import { ChatSummarizer, buildSummaryPrompt, parseSummaryAnswer, defaultSummarySettings } from "../../src/chat/summaries.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const NOW = "2026-10-17T12:00:00.000Z";
const CURATE_NEW = JSON.stringify({ topic: { new: { kind: "feat", title: "Chat summaries" } }, sections: { overview: "Summaries of chats." } });

type Call = { purpose: "summary" | "curator"; prompt: string };

function harness(options: { summariesOn?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-knowledge-pipeline-")));
  directories.push(root);
  const state = join(root, "state"), home = join(root, "home"), repo = join(root, "repo");
  for (const directory of [state, home, repo]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: options.summariesOn ?? true, model: "stub", minNewTurns: 2, idleMinutes: 0.01 }));
  const calls: Call[] = [];
  const curator: string[] = [];
  let counter = 0;
  const ask = async (prompt: string, purpose: "summary" | "curator"): Promise<string> => {
    calls.push({ purpose, prompt });
    if (purpose === "summary") { counter += 1; return `TITLE: Wiki outcome ${counter}\nSUMMARY: This feature groups summaries by topic (summary ${counter}).\nREFS: issue 42 - Wiki page\nKEY: 0 | sets the direction`; }
    return curator.shift() ?? CURATE_NEW;
  };
  let clock = new Date(NOW);
  const environment = { HOME: home, MEGABRAIN_STATE_DIR: state };
  const pipeline = new KnowledgePipeline({ stateDir: state, environment, ask, now: () => clock });
  return { root, state, home, repo, calls, curator, pipeline, environment, project: openProject(state, repo), advance: (minutes: number) => { clock = new Date(clock.getTime() + minutes * 60_000); }, purposes: () => calls.map((call) => call.purpose) };
}

function session(h: ReturnType<typeof harness>, overrides: Partial<SessionInput> = {}, users = 2): SessionInput {
  const turns: SessionInput["turns"] = [];
  for (let index = 0; index < users; index += 1) {
    turns.push({ kind: "user", text: index === 0 ? "make summaries a wiki, grouped by topic" : `follow up ${index}`, at: "2026-10-17T10:00:00.000Z" });
    turns.push({ kind: "assistant", text: `done ${index}`, at: "2026-10-17T10:01:00.000Z" });
  }
  turns.push({ kind: "tool-result", text: "created https://github.com/o/r/pull/300", tool: { name: "Bash", status: "ok" }, at: "2026-10-17T10:02:00.000Z" });
  return { sessionKeys: ["chat:c1", "claude:S1"], chatId: "c1", agent: "claude", model: "opus", repo: h.repo, cwd: h.repo, branch: "feat/summaries-wiki", worktree: h.repo, startedAt: "2026-10-17T10:00:00.000Z", endedAt: "2026-10-17T10:02:00.000Z", title: null, turns, ...overrides };
}

describe("subject-first summary prompt", () => {
  test("it forbids naming the actors, asks for concrete subjects, refs, key messages and the chat's language", () => {
    const prompt = buildSummaryPrompt(null, [{ cursor: "0", at: NOW, role: "person", text: "wiki please" }, { cursor: "1", at: NOW, role: "agent", text: "on it" }]);
    expect(prompt).toMatch(/never.*the person/i);
    expect(prompt).toMatch(/the agent/i);
    expect(prompt).toContain("In this session");
    expect(prompt).toMatch(/number and subject/i);
    expect(prompt).toMatch(/same language/i);
    expect(prompt).toContain("TITLE:");
    expect(prompt).toContain("SUMMARY:");
    expect(prompt).toContain("REFS:");
    expect(prompt).toContain("KEY:");
    expect(prompt).toContain("[0]");
    expect(prompt).toContain("wiki please");
  });

  test("an update carries the previous summary and only the new lines", () => {
    const prompt = buildSummaryPrompt("Earlier text.", [{ cursor: "9", at: NOW, role: "person", text: "new ask" }]);
    expect(prompt).toContain("Earlier text.");
    expect(prompt).toContain("new ask");
  });

  test("the answer is split into title, summary, refs with titles and key messages", () => {
    const answer = parseSummaryAnswer("TITLE: QA defects become 12 issues\nSUMMARY: This session files twelve issues.\nIt also dispatches five lanes.\nREFS: pr 214 - Summaries wiki page | issue 198 | commit 3fa91c2 - feat: add | branch feat/x | nonsense\nKEY: 3 | sets the direction\nKEY: 7 | decides to drop branches");
    expect(answer.title).toBe("QA defects become 12 issues");
    expect(answer.text).toBe("This session files twelve issues.\nIt also dispatches five lanes.");
    expect(answer.refs).toEqual([{ kind: "pr", id: "214", title: "Summaries wiki page" }, { kind: "issue", id: "198" }, { kind: "commit", id: "3fa91c2", title: "feat: add" }, { kind: "branch", id: "feat/x" }]);
    expect(answer.keys).toEqual([{ cursor: "3", why: "sets the direction" }, { cursor: "7", why: "decides to drop branches" }]);
  });

  test("an old-style answer without REFS and KEY still parses", () => {
    const answer = parseSummaryAnswer("TITLE: Fix login\nSUMMARY: Done.");
    expect(answer).toMatchObject({ title: "Fix login", text: "Done.", refs: [], keys: [] });
  });
});

describe("knowledge settings", () => {
  test("a saved file fills the toggles it leaves out with on, and a project value beats the default", () => {
    const h = harness();
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ defaults: { retitle: false }, projects: { "/a": { retitle: true, context: false } } }));
    const settings = readKnowledgeSettings(h.state);
    expect(effectiveToggles(settings, "/a")).toEqual({ summaries: true, retitle: true, topics: true, sessions: true, context: false });
    expect(effectiveToggles(settings, "/b")).toEqual({ summaries: true, retitle: false, topics: true, sessions: true, context: true });
    expect(effectiveToggles(defaultKnowledgeSettings, "/x")).toEqual({ summaries: false, retitle: false, topics: false, sessions: false, context: false });
  });

  test("with summaries off nothing else applies, however it is set", () => {
    const settings = { defaults: { summaries: true, retitle: true, topics: true, sessions: true, context: true }, projects: { "/off": { summaries: false, topics: true, sessions: true, context: true, retitle: true } } };
    expect(effectiveToggles(settings, "/off")).toEqual({ summaries: false, retitle: false, topics: false, sessions: false, context: false });
  });

  test("the old chat-summaries enabled and retitle become the defaults once, then are ignored", () => {
    const h = harness();
    writeFileSync(join(h.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: false, retitle: false }));
    expect(readKnowledgeSettings(h.state).defaults).toEqual({ summaries: false, retitle: false, topics: true, sessions: true, context: true });
    expect(existsSync(join(h.state, "knowledge-settings.json"))).toBe(true);
    writeFileSync(join(h.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, retitle: true }));
    expect(readKnowledgeSettings(h.state).defaults.summaries).toBe(false);
  });

  test("parsing validates toggles and the set and get verbs round trip", async () => {
    const h = harness();
    expect(parseKnowledgeSettings("{}").kind).toBe("ok");
    for (const bad of ["nope", `{"projects":[]}`, `{"projects":{"/a":{"enabled":false}}}`, `{"defaults":{"summaries":"yes"}}`, `{"extra":1}`]) expect(parseKnowledgeSettings(bad).kind).toBe("failed");
    const environment = { MEGABRAIN_STATE_DIR: h.state, HOME: h.root };
    const body = { defaults: { summaries: true, retitle: true, topics: true, sessions: false, context: true }, projects: { [h.repo]: { topics: false } } };
    expect((await executeSettings(["set", "knowledge", JSON.stringify(body)], environment, undefined as never)).kind).toBe("ok");
    const got = await executeSettings(["get", "knowledge"], environment, undefined as never);
    expect(got.kind === "ok" && JSON.parse(got.value)).toEqual(body);
  });
});

describe("a project with summaries off sends nothing to any model", () => {
  test("the app-chat summarizer neither summarises nor retitles it, and a project with it on still does", async () => {
    const h = harness();
    const bin = join(h.root, "bin"), log = join(h.root, "calls.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, "call\\n"); process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("TITLE: New title\\nSUMMARY: Done.\\n"));\n`);
    chmodSync(join(bin, "claude"), 0o700);
    const environment = { ...h.environment, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
    const store = new ChatStore(h.state);
    await store.initialize();
    const make = async (id: string, cwd: string) => {
      await store.put({ id, agent: "claude", model: null, cwd, title: "first message", state: "idle", mode: "chat", agentSessionId: null, createdAt: "2020-01-01T00:00:00.000Z", lastActivityAt: null, summary: null, titleSource: "first-message" });
      await store.append(id, { id: "e1", at: NOW, kind: "user", text: "hello" });
      await store.append(id, { id: "e2", at: NOW, kind: "assistant", text: "hi" });
    };
    const other = join(h.root, "other");
    mkdirSync(other);
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await make(A, h.repo);
    await make(B, other);
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { summaries: false } } }));
    const summarizer = new ChatSummarizer({ store, stateDir: h.state, environment, emit: async () => {} });
    await summarizer.turnEnded(A);
    expect(existsSync(log)).toBe(false);
    await expect(summarizer.summarize(A)).rejects.toThrow();
    expect((await store.get(A))?.title).toBe("first message");
    await summarizer.summarize(B);
    expect(existsSync(log)).toBe(true);
    expect((await store.get(B))?.title).toBe("New title");
  });

  test("retitle off keeps the title but still summarises", async () => {
    const h = harness();
    const bin = join(h.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on("end", () => process.stdout.write("TITLE: New title\\nSUMMARY: Done.\\n"));\n`);
    chmodSync(join(bin, "claude"), 0o700);
    const environment = { ...h.environment, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
    const store = new ChatStore(h.state);
    await store.initialize();
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await store.put({ id, agent: "claude", model: null, cwd: h.repo, title: "first message", state: "idle", mode: "chat", agentSessionId: null, createdAt: "2020-01-01T00:00:00.000Z", lastActivityAt: null, summary: null, titleSource: "first-message" });
    await store.append(id, { id: "e1", at: NOW, kind: "user", text: "hello" });
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { retitle: false } } }));
    await new ChatSummarizer({ store, stateDir: h.state, environment, emit: async () => {} }).summarize(id);
    const chat = await store.get(id);
    expect(chat?.summary?.text).toBe("Done.");
    expect(chat?.title).toBe("first message");
  });
});

describe("pipeline", () => {
  test("work-block trigger waits for quiet and three new user turns, while long sessions cap at forty", async () => {
    const h = harness();
    writeFileSync(join(h.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, model: "stub", idleMinutes: 20, minNewTurns: 3, maxTurns: 40 }));
    const fresh = session(h, { startedAt: NOW, endedAt: NOW }, 3);
    expect((await h.pipeline.processSession(fresh)).status).toBe("nothing-new");
    expect(h.calls).toHaveLength(0);
    h.advance(21);
    expect((await h.pipeline.processSession(fresh)).status).toBe("curated");
    h.calls.length = 0;
    const many = session(h, { startedAt: NOW, endedAt: NOW }, 43);
    expect((await h.pipeline.processSession(many)).status).toBe("queued");
    h.advance(60);
    expect((await h.pipeline.processSession(many)).status).toBe("curated");
    expect(h.purposes()).toEqual(["summary", "curator"]);
  });

  test("a session with fewer than three user turns is never summarized, even after it goes quiet", async () => {
    const h = harness();
    writeFileSync(join(h.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, model: "stub", idleMinutes: 20, minNewTurns: 3, maxTurns: 40 }));
    h.advance(120);
    expect((await h.pipeline.processSession(session(h, { startedAt: NOW, endedAt: NOW }, 2))).status).toBe("nothing-new");
    expect(h.calls).toHaveLength(0);
  });

  test("a session becomes a summary, a topic, a chat record with mechanical refs and a distilled transcript", async () => {
    const h = harness();
    const result = await h.pipeline.processSession(session(h));
    expect(result.status).toBe("curated");
    expect(h.purposes()).toEqual(["summary", "curator"]);
    const chat = h.project.chat("c1");
    expect(chat).toMatchObject({ id: "c1", agent: "claude", branch: "feat/summaries-wiki", userTurns: 2, curated: true });
    expect(chat?.title).toBe("Wiki outcome 1");
    expect(chat?.refs.map((ref) => `${ref.kind}:${ref.id}`)).toEqual(expect.arrayContaining(["issue:42", "pr:300"]));
    expect(h.project.topics()).toHaveLength(1);
    expect(chat?.topics).toEqual([h.project.topics()[0]?.id]);
    expect(h.project.transcript("c1").filter((line) => line.role === "person")).toHaveLength(2);
    expect(h.calls[1]?.prompt).toContain("This feature groups summaries by topic");
  });

  test("with nothing new there is no model call at all", async () => {
    const h = harness();
    await h.pipeline.processSession(session(h));
    h.calls.length = 0;
    expect((await h.pipeline.processSession(session(h))).status).toBe("nothing-new");
    expect(h.calls).toHaveLength(0);
  });

  test("a little new content waits for the cadence; summaries queue while curator calls batch by the hour", async () => {
    const h = harness();
    await h.pipeline.processSession(session(h));
    writeFileSync(join(h.state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, model: "stub", idleMinutes: 20, minNewTurns: 3, maxTurns: 40, curatorEveryMinutes: 60 }));
    h.calls.length = 0;
    expect((await h.pipeline.processSession(session(h, {}, 4))).status).toBe("nothing-new");
    expect(h.calls).toHaveLength(0);
    const assign = JSON.stringify({ topic: { assign: h.project.topics()[0]?.id } });
    h.curator.push(assign, assign);
    h.advance(11);
    expect((await h.pipeline.processSession(session(h, {}, 5))).status).toBe("queued");
    expect(h.purposes()).toEqual(["summary"]);
    expect(h.calls[0]?.prompt).toContain("This feature groups summaries by topic (summary 1)");
    expect(h.project.transcript("c1").filter((line) => line.role === "person")).toHaveLength(5);
    h.advance(60);
    expect((await h.pipeline.processSession(session(h, {}, 4))).status).toBe("curated");
    expect(h.purposes()).toEqual(["summary", "curator"]);
    h.calls.length = 0;
    expect((await h.pipeline.processSession(session(h, {}, 10))).status).toBe("queued");
    expect(h.project.topics()).toHaveLength(1);
    expect(readdirSync(join(h.project.dir, "chats")).filter((name) => name.endsWith(".json"))).toEqual(["c1.json"]);
  });

  test("a disabled project is never summarised, curated or written", async () => {
    const h = harness();
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { summaries: false } } }));
    expect((await h.pipeline.processSession(session(h))).status).toBe("disabled");
    expect(h.calls).toHaveLength(0);
    expect(existsSync(join(h.state, "knowledge"))).toBe(false);
  });

  test("a chat summaries switch that is off (migrated to the default) means no model call", async () => {
    const h = harness({ summariesOn: false });
    expect((await h.pipeline.processSession(session(h))).status).toBe("disabled");
    expect(h.calls).toHaveLength(0);
  });

  test("a bad curator answer writes no topic and is retried at the next pass without asking for the summary again", async () => {
    const h = harness();
    h.curator.push("I would put this under summaries.");
    expect((await h.pipeline.processSession(session(h))).status).toBe("queued");
    expect(h.project.topics()).toHaveLength(0);
    expect(h.project.chat("c1")).toMatchObject({ curated: false, topics: [] });
    h.calls.length = 0;
    h.advance(60);
    expect((await h.pipeline.processSession(session(h))).status).toBe("curated");
    expect(h.purposes()).toEqual(["curator"]);
    expect(h.project.topics()).toHaveLength(1);
  });

  test("a failing summary model writes nothing and is retried", async () => {
    const h = harness();
    const failing = new KnowledgePipeline({ stateDir: h.state, environment: h.environment, ask: async () => { throw new Error("quota"); }, now: () => new Date(NOW) });
    expect((await failing.processSession(session(h))).status).toBe("summary-failed");
    expect(h.project.chat("c1")).toBeNull();
    expect((await h.pipeline.processSession(session(h))).status).toBe("curated");
  });

  test("a worker session is linked to its parent and never summarised on its own", async () => {
    const h = harness();
    const result = await h.pipeline.processSession(session(h, { sessionKeys: ["claude:S2"], chatId: undefined, parentSessionKey: "claude:S1" }));
    expect(result.status).toBe("worker");
    expect(h.calls).toHaveLength(0);
    const worker = h.project.chatBySession("claude:S2");
    expect(worker?.parentSessionKey).toBe("claude:S1");
    expect(worker?.topics).toEqual([]);
    expect(h.project.transcript(worker?.id ?? "").length).toBeGreaterThan(0);
  });

  test("two branches of one subject land in one topic when the model assigns the second to the first", async () => {
    const h = harness();
    await h.pipeline.processSession(session(h, { branch: "feat/summaries-by-branch" }));
    const first = h.project.topics()[0] as Topic;
    h.curator.push(JSON.stringify({ topic: { assign: first.id }, sections: { state: "Now a wiki." } }));
    await h.pipeline.processSession(session(h, { sessionKeys: ["chat:c2"], chatId: "c2", branch: "feat/summaries-wiki" }, 3));
    h.advance(60);
    await h.pipeline.processSession(session(h, { sessionKeys: ["chat:c2"], chatId: "c2", branch: "feat/summaries-wiki" }, 3));
    expect(h.calls.at(-1)?.prompt).toContain(first.id);
    expect(h.calls.at(-1)?.prompt).toContain("Summaries of chats.");
    const topics = h.project.topics();
    expect(topics).toHaveLength(1);
    expect(topics[0]?.chats).toEqual(["c1", "c2"]);
    expect(topics[0]?.refs.filter((ref) => ref.kind === "branch").map((ref) => ref.id).sort()).toEqual(["feat/summaries-by-branch", "feat/summaries-wiki"]);
    expect(topics[0]?.sections.state).toBe("Now a wiki.");
  });
});

function claudeLog(h: ReturnType<typeof harness>, id: string, cwd: string, texts: string[]): string {
  const directory = join(h.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  const rows = texts.flatMap((text, index) => [
    { type: "user", uuid: `u${index}`, timestamp: "2026-10-17T10:00:00.000Z", message: { content: text } },
    { type: "assistant", uuid: `a${index}`, timestamp: "2026-10-17T10:01:00.000Z", message: { id: `m${index}`, content: [{ type: "text", text: `reply ${index}` }] } },
  ]);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const endedAt = new Date("2026-10-17T10:02:00.000Z");
  utimesSync(path, endedAt, endedAt);
  return path;
}

function tree(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => { const path = join(entry.parentPath, entry.name); return `${path}:${statSync(path).mtimeMs}:${statSync(path).size}`; }).sort();
}

describe("scanner", () => {
  test("it reads sessions of an enabled project from the agents' logs, once each, without writing to them", async () => {
    const h = harness();
    claudeLog(h, "S1", h.repo, ["make summaries a wiki", "and add a map", "include an index"]);
    const before = tree(join(h.home, ".claude"));
    const first = await scanProjects({ stateDir: h.state, home: h.home, environment: h.environment, pipeline: h.pipeline, projects: [h.repo], dispatchLinks: new Map(), now: () => new Date(NOW) });
    expect(first.scanned).toEqual([h.repo]);
    expect(h.purposes()).toEqual(["summary", "curator"]);
    expect(h.project.chatBySession("claude:S1")?.userTurns).toBe(3);
    h.calls.length = 0;
    await scanProjects({ stateDir: h.state, home: h.home, environment: h.environment, pipeline: h.pipeline, projects: [h.repo], dispatchLinks: new Map(), now: () => new Date(NOW) });
    expect(h.calls).toHaveLength(0);
    expect(tree(join(h.home, ".claude"))).toEqual(before);
  });

  test("a session an app chat already holds is the same session: one record, no second model call", async () => {
    const h = harness();
    await h.pipeline.processSession(session(h, { sessionKeys: ["chat:c1", "claude:S1"] }, 2));
    claudeLog(h, "S1", h.repo, ["make summaries a wiki", "follow up 1"]);
    h.calls.length = 0;
    await scanProjects({ stateDir: h.state, home: h.home, environment: h.environment, pipeline: h.pipeline, projects: [h.repo], dispatchLinks: new Map() });
    expect(h.calls).toHaveLength(0);
    expect(readdirSync(join(h.project.dir, "chats")).filter((name) => name.endsWith(".json"))).toEqual(["c1.json"]);
  });

  test("a dispatch worker's session is linked to its parent's chat and shown under it", async () => {
    const h = harness();
    claudeLog(h, "S1", h.repo, ["lead the work", "second", "third"]);
    claudeLog(h, "S2", h.repo, ["do lane 1"]);
    await scanProjects({ stateDir: h.state, home: h.home, environment: h.environment, pipeline: h.pipeline, projects: [h.repo], dispatchLinks: new Map([["claude:S2", "claude:S1"]]), now: () => new Date(NOW) });
    expect(h.calls.filter((call) => call.purpose === "summary")).toHaveLength(1);
    const parent = h.project.chatBySession("claude:S1");
    const worker = h.project.chatBySession("claude:S2");
    expect(worker?.parentSessionKey).toBe("claude:S1");
    const topicId = h.project.topics()[0]?.id as string;
    const shown = await executeKnowledge(["show", topicId, "--json"], h.environment);
    const body = shown.kind === "ok" ? JSON.parse(shown.value) : null;
    expect(body.chatRecords.map((record: { id: string }) => record.id)).toContain(worker?.id);
    expect(body.chatRecords.find((record: { id: string }) => record.id === worker?.id)?.parent).toBe(parent?.id);
  });

  test("a disabled project is not scanned: its logs are not read and no model is called", async () => {
    const h = harness();
    claudeLog(h, "S1", h.repo, ["secret work", "more"]);
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { summaries: false } } }));
    const result = await scanProjects({ stateDir: h.state, home: h.home, environment: h.environment, pipeline: h.pipeline, projects: [h.repo], dispatchLinks: new Map() });
    expect(result.scanned).toEqual([]);
    expect(h.calls).toHaveLength(0);
    expect(existsSync(join(h.state, "knowledge"))).toBe(false);
  });

  test("with the summaries switch off nothing is scanned", async () => {
    const h = harness({ summariesOn: false });
    claudeLog(h, "S1", h.repo, ["work", "more"]);
    const result = await scanProjects({ stateDir: h.state, home: h.home, environment: h.environment, pipeline: h.pipeline, projects: [h.repo], dispatchLinks: new Map() });
    expect(result.scanned).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});

function seedSummaries(h: ReturnType<typeof harness>, entries: Array<{ chatId: string; createdAt: string; branch: string }>): void {
  for (const entry of entries) {
    const directory = join(h.state, "chats", entry.chatId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "chat.json"), JSON.stringify({ id: entry.chatId, agent: "claude", model: null, cwd: h.repo, title: entry.branch, state: "idle", mode: "chat", agentSessionId: null, createdAt: entry.createdAt, lastActivityAt: null }));
    writeFileSync(join(directory, "summaries.jsonl"), `${JSON.stringify({ text: `Summary for ${entry.branch}`, updatedAt: entry.createdAt, model: "m", title: `Title ${entry.branch}`, userTurns: 3, id: `s-${entry.chatId}`, chatId: entry.chatId, repo: h.repo, project: "repo", worktree: h.repo, branch: entry.branch, agent: "claude", createdAt: entry.createdAt })}\n`);
  }
}

describe("backfill", () => {
  const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";

  test("existing summaries are curated oldest first, once, and a second run asks nothing", async () => {
    const h = harness();
    seedSummaries(h, [{ chatId: B, createdAt: "2026-10-02T10:00:00.000Z", branch: "feat/two" }, { chatId: A, createdAt: "2026-10-01T10:00:00.000Z", branch: "feat/one" }, { chatId: C, createdAt: "2026-10-03T10:00:00.000Z", branch: "feat/three" }]);
    h.curator.push(JSON.stringify({ results: [
      { chatId: A, topic: { new: { kind: "feat", title: "One" } }, sections: { overview: "One." } },
      { chatId: B, topic: { new: { kind: "feat", title: "Two" } }, sections: { overview: "Two." } },
      { chatId: C, topic: { new: { kind: "feat", title: "Three" } }, sections: { overview: "Three." } },
    ] }));
    const first = await backfillSummaries({ stateDir: h.state, pipeline: h.pipeline });
    expect(first).toMatchObject({ curated: 3, failed: 0 });
    expect(h.calls.map((call) => call.purpose)).toEqual(["curator"]);
    expect(h.calls[0]?.prompt).toContain("Summary for feat/one");
    expect(h.calls[0]?.prompt).toContain("Summary for feat/two");
    expect(h.calls[0]?.prompt).toContain("Summary for feat/three");
    h.calls.length = 0;
    expect(await backfillSummaries({ stateDir: h.state, pipeline: h.pipeline })).toMatchObject({ curated: 0, skipped: 3 });
    expect(h.calls).toHaveLength(0);
  });

  test("it is resumable: a failure leaves the rest for the next run and never repeats what is done", async () => {
    const h = harness();
    seedSummaries(h, [{ chatId: A, createdAt: "2026-10-01T10:00:00.000Z", branch: "feat/one" }, { chatId: B, createdAt: "2026-10-02T10:00:00.000Z", branch: "feat/two" }, { chatId: C, createdAt: "2026-10-03T10:00:00.000Z", branch: "feat/three" }]);
    h.curator.push(JSON.stringify({ results: [
      { chatId: A, topic: { new: { kind: "feat", title: "Chat summaries" } }, sections: { overview: "Summaries of chats." } },
      { chatId: B, malformed: true },
      { chatId: C, topic: { new: { kind: "feat", title: "Other work" } }, sections: { overview: "Other work." } },
    ] }));
    const first = await backfillSummaries({ stateDir: h.state, pipeline: h.pipeline });
    expect(first).toMatchObject({ curated: 2, failed: 1 });
    h.calls.length = 0;
    h.advance(60);
    h.curator.push(CURATE_NEW);
    const second = await backfillSummaries({ stateDir: h.state, pipeline: h.pipeline });
    expect(second.curated).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.prompt).toContain("Summary for feat/two");
    expect(h.calls[0]?.prompt).not.toContain("Summary for feat/one");
  });

  test("a disabled project's summaries are not sent to a model", async () => {
    const h = harness();
    seedSummaries(h, [{ chatId: A, createdAt: "2026-10-01T10:00:00.000Z", branch: "feat/one" }]);
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { summaries: false } } }));
    await backfillSummaries({ stateDir: h.state, pipeline: h.pipeline });
    expect(h.calls).toHaveLength(0);
  });
});

function gitRepo(root: string, branch: string): string {
  const repo = join(root, "git-repo");
  mkdirSync(repo, { recursive: true });
  const run = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "pipe" });
  run("init", "-q", "-b", branch);
  writeFileSync(join(repo, "a.txt"), "a");
  run("add", ".");
  run("commit", "-q", "-m", "init");
  return realpathSync(repo);
}

describe("agent context", () => {
  function seed(repo: string, state: string): void {
    const project = openProject(state, repo);
    const pad = "A long paragraph about how the summaries wiki works. ".repeat(60);
    project.saveTopic({ id: "t1", project: repo, title: "Chat summaries", kind: "feat", status: "active", createdAt: NOW, updatedAt: NOW, aliases: [], sections: { overview: `What it is. ${pad}`, state: `Where it stands. ${pad}`, pitfalls: "Never write ~/.claude.", open: "Map view." }, decisions: [{ id: "d1", text: "Group by branch", why: "old", at: NOW, chatId: "c", supersededBy: "d2" }, { id: "d2", text: "Group by topic", why: "branches repeat", at: NOW, chatId: "c" }], refs: [{ kind: "branch", id: "feat/summaries-wiki" }], chats: ["c"], keyMessages: [] });
    project.saveTopic({ id: "t2", project: repo, title: "Unrelated terminal work", kind: "fix", status: "active", createdAt: NOW, updatedAt: "2026-01-01T00:00:00.000Z", aliases: [], sections: { overview: "Terminal.", state: "", pitfalls: "", open: "" }, decisions: [], refs: [], chats: [], keyMessages: [] });
  }

  test("it holds the topic of the branch, live decisions, pitfalls and open items, capped near 3 KB", async () => {
    const h = harness();
    const repo = gitRepo(h.root, "feat/summaries-wiki");
    seed(repo, h.state);
    const context = await knowledgeContext(h.state, repo);
    expect(context).toContain("Chat summaries");
    expect(context).toContain("Group by topic");
    expect(context).not.toContain("Group by branch");
    expect(context).toContain("Never write ~/.claude.");
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(3072);
    expect(context).not.toContain("Unrelated terminal work");
  });

  test("with no topics it is empty, and the session hook prints the topic when there is one", async () => {
    const h = harness();
    const repo = gitRepo(h.root, "feat/summaries-wiki");
    expect(await knowledgeContext(h.state, repo)).toBe("");
    expect(await executeHookSessionStart([], h.environment, async () => JSON.stringify({ cwd: repo }))).toEqual({ kind: "ok", value: "" });
    seed(repo, h.state);
    const hook = await executeHookSessionStart([], h.environment, async () => JSON.stringify({ cwd: repo }));
    expect(hook.kind === "ok" && JSON.parse(hook.value).hookSpecificOutput.additionalContext).toContain("Chat summaries");
  });
});

describe("knowledge verbs", () => {
  async function seeded() {
    const h = harness();
    await h.pipeline.processSession(session(h, { sessionKeys: ["chat:c1", "claude:S1"] }));
    await h.pipeline.processSession(session(h, { sessionKeys: ["claude:S2"], chatId: undefined, parentSessionKey: "claude:S1" }));
    return h;
  }
  const json = (result: Awaited<ReturnType<typeof executeKnowledge>>) => { if (result.kind !== "ok") throw new Error(result.error); return JSON.parse(result.value); };
  const summaryKeys = ["activity", "aliases", "chats", "createdAt", "id", "kind", "overview", "project", "refs", "status", "title", "updatedAt"];

  test("list gives projects with their topic summaries", async () => {
    const h = await seeded();
    const body = json(await executeKnowledge(["list", "--json"], h.environment));
    expect(body.projects).toHaveLength(1);
    expect(Object.keys(body.projects[0]).sort()).toEqual(["enabled", "project", "repo", "topics"]);
    expect(body.projects[0]).toMatchObject({ repo: h.repo, project: "repo", enabled: true });
    expect(Object.keys(body.projects[0].topics[0]).sort()).toEqual(summaryKeys);
    expect(body.projects[0].topics[0]).toMatchObject({ title: "Chat summaries", kind: "feat", overview: "Summaries of chats." });
    expect(body.projects[0].topics[0].activity).toBeGreaterThanOrEqual(1);
    expect(json(await executeKnowledge(["list", "--repo", join(h.root, "elsewhere"), "--json"], h.environment)).projects).toEqual([]);
  });

  test("a disabled project is listed as disabled", async () => {
    const h = await seeded();
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { summaries: false } } }));
    expect(json(await executeKnowledge(["list", "--json"], h.environment)).projects[0].enabled).toBe(false);
  });

  test("search ranks topics by title and text and carries a score", async () => {
    const h = await seeded();
    const body = json(await executeKnowledge(["search", "summaries", "--json"], h.environment));
    expect(body.results).toHaveLength(1);
    expect(Object.keys(body.results[0]).sort()).toEqual([...summaryKeys, "score"].sort());
    expect(body.results[0].score).toBeGreaterThan(0);
    expect(json(await executeKnowledge(["search", "zzzqqq", "--json"], h.environment)).results).toEqual([]);
  });

  test("show gives the full topic and its chat records, the worker under its parent", async () => {
    const h = await seeded();
    const id = h.project.topics()[0]?.id as string;
    const body = json(await executeKnowledge(["show", id, "--json"], h.environment));
    expect(Object.keys(body).sort()).toEqual(["activity", "aliases", "chatRecords", "chats", "createdAt", "decisions", "id", "keyMessages", "kind", "overview", "project", "refs", "sections", "status", "title", "updatedAt"]);
    expect(Object.keys(body.sections).sort()).toEqual(["open", "overview", "pitfalls", "state"]);
    const parent = body.chatRecords.find((record: { id: string }) => record.id === "c1");
    expect(Object.keys(parent).sort()).toEqual(["agent", "branch", "endedAt", "id", "lastMessages", "model", "refs", "startedAt", "summary", "title", "topics", "worktree"]);
    expect(parent.lastMessages[0]).toEqual(expect.objectContaining({ role: expect.any(String), text: expect.any(String), at: expect.any(String) }));
    expect(body.chatRecords.some((record: { parent?: string }) => record.parent === "c1")).toBe(true);
    expect((await executeKnowledge(["show", "missing", "--json"], h.environment)).kind).toBe("failed");
  });

  test("transcript gives the chat record and its distilled events", async () => {
    const h = await seeded();
    const body = json(await executeKnowledge(["transcript", "c1", "--json"], h.environment));
    expect(body.chat.id).toBe("c1");
    expect(Object.keys(body.events[0]).sort()).toEqual(["at", "cursor", "role", "text"]);
    expect(body.events.map((event: { role: string }) => event.role)).toEqual(expect.arrayContaining(["person", "agent"]));
    expect((await executeKnowledge(["transcript", "missing", "--json"], h.environment)).kind).toBe("failed");
  });

  test("a chat's edited files are its file refs, so the map can draw shared-file edges", async () => {
    const h = harness();
    const input = session(h);
    input.turns.push({ kind: "tool-call", text: "Edit", tool: { name: "Edit", input: JSON.stringify({ file_path: join(h.repo, "src/chat/daemon.ts") }) }, at: NOW });
    await h.pipeline.processSession(input);
    expect(h.project.chat("c1")?.refs).toContainEqual({ kind: "file", id: "src/chat/daemon.ts" });
  });

  test("topic-for finds the topics of a folder's branch", async () => {
    const h = harness();
    const repo = gitRepo(h.root, "feat/summaries-wiki");
    const pipeline = new KnowledgePipeline({ stateDir: h.state, environment: h.environment, ask: async (_prompt, purpose) => purpose === "summary" ? "TITLE: T\nSUMMARY: S." : CURATE_NEW, now: () => new Date(NOW) });
    await pipeline.processSession({ ...session(h, { repo, cwd: repo, worktree: repo }) });
    const body = json(await executeKnowledge(["topic-for", "--cwd", repo, "--json"], h.environment));
    expect(body.topics.map((entry: { title: string }) => entry.title)).toEqual(["Chat summaries"]);
    expect(Object.keys(body.topics[0]).sort()).toEqual(summaryKeys);
  });

  test("the old summaries verbs still answer", async () => {
    const h = harness();
    seedSummaries(h, [{ chatId: "11111111-1111-4111-8111-111111111111", createdAt: "2026-10-01T10:00:00.000Z", branch: "feat/one" }]);
    const list = await executeSummaries(["list", "--json"], h.environment);
    expect(list.kind === "ok" && JSON.parse(list.value).projects[0].branches[0].branch).toBe("feat/one");
    expect((await executeSummaries(["search", "feat", "--json"], h.environment)).kind).toBe("ok");
  });
});
