import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeKnowledge } from "../../src/cli/commands/knowledge.js";
import { openProject } from "../../src/knowledge/store.js";
import type { ChatRecord, Topic } from "../../src/knowledge/types.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const NOW = "2026-10-17T12:00:00.000Z";

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-knowledge-edit-")));
  directories.push(root);
  const state = join(root, "state"), repo = join(root, "repo"), other = join(root, "other");
  for (const directory of [state, repo, other]) mkdirSync(directory, { recursive: true });
  const project = openProject(state, repo);
  return { state, repo, other, project, environment: { MEGABRAIN_STATE_DIR: state, HOME: root } };
}

function topic(repo: string, overrides: Partial<Topic> = {}): Topic {
  return { id: "a", project: repo, title: "Chat summaries", kind: "feat", status: "active", createdAt: NOW, updatedAt: NOW, aliases: [], sections: { overview: "Summaries of chats.", state: "Draft.", pitfalls: "", open: "" }, decisions: [], refs: [], chats: [], keyMessages: [], ...overrides };
}

function chat(repo: string, id: string, topics: string[]): ChatRecord {
  return { id, sessionKeys: [`chat:${id}`], title: id, summary: "s", agent: "claude", model: null, branch: "feat/x", worktree: repo, startedAt: NOW, endedAt: NOW, topics, refs: [], userTurns: 2, summarizedAt: NOW, curated: true };
}

async function run(w: ReturnType<typeof workspace>, ...args: string[]) {
  const outcome = await executeKnowledge([...args, "--json"], w.environment);
  return { outcome, body: outcome.kind === "ok" ? JSON.parse(outcome.value) : null };
}

describe("rename", () => {
  test("it changes the title, keeps the old one as an alias and writes a revision", async () => {
    const w = workspace();
    w.project.saveTopic(topic(w.repo));
    const { outcome, body } = await run(w, "rename", "a", "Session wiki");
    expect(outcome.kind).toBe("ok");
    expect(body.topic).toMatchObject({ id: "a", title: "Session wiki" });
    expect(w.project.topic("a")?.title).toBe("Session wiki");
    expect(w.project.topic("a")?.aliases).toContain("Chat summaries");
    expect(w.project.revisions("a").map((revision) => revision.title)).toEqual(["Chat summaries"]);
  });

  test("an empty title or an unknown topic changes nothing", async () => {
    const w = workspace();
    w.project.saveTopic(topic(w.repo));
    expect((await run(w, "rename", "a", "  ")).outcome.kind).toBe("failed");
    expect((await run(w, "rename", "missing", "X")).outcome.kind).toBe("failed");
    expect(w.project.revisions("a")).toHaveLength(0);
  });
});

describe("kind and status", () => {
  test("each sets its field and writes a revision", async () => {
    const w = workspace();
    w.project.saveTopic(topic(w.repo));
    expect((await run(w, "kind", "a", "decision")).body.topic.kind).toBe("decision");
    expect((await run(w, "status", "a", "shipped")).body.topic.status).toBe("shipped");
    expect(w.project.topic("a")).toMatchObject({ kind: "decision", status: "shipped" });
    expect(w.project.revisions("a")).toHaveLength(2);
  });

  test("a value outside the allowed ones is refused and writes nothing", async () => {
    const w = workspace();
    w.project.saveTopic(topic(w.repo));
    expect((await run(w, "kind", "a", "epic")).outcome.kind).toBe("failed");
    expect((await run(w, "status", "a", "done")).outcome.kind).toBe("failed");
    expect(w.project.topic("a")).toMatchObject({ kind: "feat", status: "active" });
    expect(w.project.revisions("a")).toHaveLength(0);
  });
});

describe("merge", () => {
  function seeded() {
    const w = workspace();
    w.project.saveTopic(topic(w.repo, { id: "into", title: "Wiki", aliases: ["Summaries wiki"], refs: [{ kind: "issue", id: "1" }], chats: ["c1"], decisions: [{ id: "d1", text: "Group by topic", why: "scales", at: NOW, chatId: "c1" }], keyMessages: [{ chatId: "c1", eventCursor: "0", at: NOW, role: "person", text: "wiki", why: "direction" }] }));
    w.project.saveTopic(topic(w.repo, { id: "from", title: "Map", aliases: ["Topic map"], refs: [{ kind: "issue", id: "1" }, { kind: "pr", id: "9" }], chats: ["c1", "c2"], decisions: [{ id: "d1", text: "Draw a map", why: "overview", at: NOW, chatId: "c2", supersededBy: "d2" }, { id: "d2", text: "Draw a graph", why: "clearer", at: NOW, chatId: "c2" }], keyMessages: [{ chatId: "c2", eventCursor: "3", at: NOW, role: "agent", text: "graph", why: "pivot" }] }));
    w.project.saveChat(chat(w.repo, "c1", ["into", "from"]));
    w.project.saveChat(chat(w.repo, "c2", ["from"]));
    return w;
  }

  test("the target keeps the aliases, refs, chats, decisions and key messages of both, and the source is gone", async () => {
    const w = seeded();
    const { outcome } = await run(w, "merge", "from", "into");
    expect(outcome.kind).toBe("ok");
    const merged = w.project.topic("into") as Topic;
    expect(merged.title).toBe("Wiki");
    expect(merged.aliases).toEqual(expect.arrayContaining(["Summaries wiki", "Map", "Topic map"]));
    expect(merged.refs.map((ref) => `${ref.kind}:${ref.id}`).sort()).toEqual(["issue:1", "pr:9"]);
    expect([...merged.chats].sort()).toEqual(["c1", "c2"]);
    expect(merged.decisions.map((decision) => decision.text)).toEqual(["Group by topic", "Draw a map", "Draw a graph"]);
    expect(new Set(merged.decisions.map((decision) => decision.id)).size).toBe(3);
    const map = merged.decisions.find((decision) => decision.text === "Draw a map") as Topic["decisions"][number];
    expect(merged.decisions.find((decision) => decision.id === map.supersededBy)?.text).toBe("Draw a graph");
    expect(merged.keyMessages.map((message) => message.text).sort()).toEqual(["graph", "wiki"]);
    expect(w.project.topic("from")).toBeNull();
    expect(w.project.topics().map((entry) => entry.id)).toEqual(["into"]);
  });

  test("it writes a revision of the target and points the chats at it", async () => {
    const w = seeded();
    await run(w, "merge", "from", "into");
    expect(w.project.revisions("into")).toHaveLength(1);
    expect(w.project.revisions("into")[0]?.title).toBe("Wiki");
    expect(w.project.chat("c1")?.topics).toEqual(["into"]);
    expect(w.project.chat("c2")?.topics).toEqual(["into"]);
  });

  test("merging a topic into itself or into an unknown topic changes nothing", async () => {
    const w = seeded();
    expect((await run(w, "merge", "from", "from")).outcome.kind).toBe("failed");
    expect((await run(w, "merge", "from", "ghost")).outcome.kind).toBe("failed");
    expect((await run(w, "merge", "ghost", "into")).outcome.kind).toBe("failed");
    expect(w.project.topics().map((entry) => entry.id).sort()).toEqual(["from", "into"]);
    expect(w.project.revisions("into")).toHaveLength(0);
  });
});

describe("move-chat", () => {
  test("the chat leaves its topics for the target, and every topic touched gets a revision", async () => {
    const w = workspace();
    w.project.saveTopic(topic(w.repo, { id: "a", chats: ["c1", "c2"] }));
    w.project.saveTopic(topic(w.repo, { id: "b", title: "Other", chats: [] }));
    w.project.saveChat(chat(w.repo, "c1", ["a"]));
    w.project.saveChat(chat(w.repo, "c2", ["a"]));
    const { outcome } = await run(w, "move-chat", "c1", "b");
    expect(outcome.kind).toBe("ok");
    expect(w.project.topic("a")?.chats).toEqual(["c2"]);
    expect(w.project.topic("b")?.chats).toEqual(["c1"]);
    expect(w.project.chat("c1")?.topics).toEqual(["b"]);
    expect(w.project.revisions("a")).toHaveLength(1);
    expect(w.project.revisions("b")).toHaveLength(1);
  });

  test("an unknown chat, an unknown topic, or a chat of another project changes nothing", async () => {
    const w = workspace();
    const elsewhere = openProject(w.state, w.other);
    w.project.saveTopic(topic(w.repo, { id: "a", chats: ["c1"] }));
    elsewhere.saveTopic(topic(w.other, { id: "z", chats: [] }));
    w.project.saveChat(chat(w.repo, "c1", ["a"]));
    expect((await run(w, "move-chat", "nope", "a")).outcome.kind).toBe("failed");
    expect((await run(w, "move-chat", "c1", "ghost")).outcome.kind).toBe("failed");
    expect((await run(w, "move-chat", "c1", "z")).outcome.kind).toBe("failed");
    expect(w.project.topic("a")?.chats).toEqual(["c1"]);
    expect(elsewhere.topic("z")?.chats).toEqual([]);
    expect(w.project.revisions("a")).toHaveLength(0);
  });
});
