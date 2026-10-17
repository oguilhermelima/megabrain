import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCuratorOutput, candidateTopics } from "../../src/knowledge/curator.js";
import { distill, editedFiles, type DistillTurn } from "../../src/knowledge/distill.js";
import { extractRefs, isWellFormedRef } from "../../src/knowledge/refs.js";
import { listProjects, openProject } from "../../src/knowledge/store.js";
import type { Topic, TranscriptLine } from "../../src/knowledge/types.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const NOW = "2026-10-17T12:00:00.000Z";

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-knowledge-")));
  directories.push(root);
  const state = join(root, "state"), repo = join(root, "repo");
  mkdirSync(state, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { root, state, repo, project: openProject(state, repo) };
}

function topic(repo: string, overrides: Partial<Topic> = {}): Topic {
  return { id: "t1", project: repo, title: "Chat summaries", kind: "feat", status: "active", createdAt: NOW, updatedAt: NOW, aliases: [], sections: { overview: "Summaries of chats.", state: "Draft.", pitfalls: "", open: "" }, decisions: [], refs: [], chats: [], keyMessages: [], ...overrides };
}

const LINES: TranscriptLine[] = [
  { cursor: "0", at: NOW, role: "person", text: "make summaries a wiki, grouped by topic" },
  { cursor: "1", at: NOW, role: "agent", text: "Topics it is. I will add a curator." },
];
const CONTEXT = { chatId: "c1", at: NOW, branch: "feat/summaries-wiki", refs: [], lines: LINES, keyMessages: [{ cursor: "0", why: "sets the direction" }] };

describe("knowledge store", () => {
  test("a topic lives under knowledge/<project>/topics/<id> and every save appends the previous one to revisions", () => {
    const { state, repo, project } = workspace();
    project.saveTopic(topic(repo));
    expect(existsSync(join(project.dir, "topics", "t1", "topic.json"))).toBe(true);
    expect(project.dir.startsWith(join(state, "knowledge"))).toBe(true);
    expect(project.revisions("t1")).toHaveLength(0);
    project.saveTopic(topic(repo, { title: "Chat summaries v2", updatedAt: "2026-10-17T13:00:00.000Z" }));
    project.saveTopic(topic(repo, { title: "Chat summaries v3", updatedAt: "2026-10-17T14:00:00.000Z" }));
    expect(project.revisions("t1").map((revision) => revision.title)).toEqual(["Chat summaries", "Chat summaries v2"]);
    expect(project.topic("t1")?.title).toBe("Chat summaries v3");
    expect(readdirSync(join(project.dir, "topics", "t1")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("topics are listed per project and projects are listed with their repo", () => {
    const { state, repo, project } = workspace();
    project.saveTopic(topic(repo));
    project.saveTopic(topic(repo, { id: "t2", title: "Desktop terminal" }));
    expect(project.topics().map((entry) => entry.id).sort()).toEqual(["t1", "t2"]);
    expect(project.topic("missing")).toBeNull();
    expect(listProjects(state).map((entry) => entry.repo)).toEqual([repo]);
  });

  test("a chat record and its transcript round trip, and a record is found by any of its session keys", () => {
    const { repo, project } = workspace();
    project.saveChat({ id: "c1", sessionKeys: ["chat:c1", "claude:S1"], title: "Wiki", summary: "s", agent: "claude", model: null, branch: "feat/x", worktree: repo, startedAt: NOW, endedAt: NOW, topics: [], refs: [], userTurns: 2, summarizedAt: NOW, curated: false });
    project.writeTranscript("c1", LINES);
    expect(project.chat("c1")?.title).toBe("Wiki");
    expect(project.chatBySession("claude:S1")?.id).toBe("c1");
    expect(project.chatBySession("claude:other")).toBeNull();
    expect(project.transcript("c1")).toEqual(LINES);
  });
});

describe("mechanical refs", () => {
  test("pull requests, issues and commits are read from urls and prose, once each", () => {
    const refs = extractRefs([
      "Opened https://github.com/o/r/pull/214 and PR #214 again.",
      "Closes issue #198, fixes #7. [feat/summaries-wiki 3fa91c2] feat(x): add",
      "see commit 9ab12cd4e5f6 on branch feat/summaries-by-branch",
    ].join("\n"), { source: "git-output" });
    expect(refs).toContainEqual({ kind: "pr", id: "214", url: "https://github.com/o/r/pull/214" });
    expect(refs.filter((ref) => ref.kind === "pr" && ref.id === "214")).toHaveLength(1);
    expect(refs.map((ref) => `${ref.kind}:${ref.id}`)).toEqual(expect.arrayContaining(["issue:198", "issue:7", "commit:3fa91c2", "commit:9ab12cd4e5f6", "branch:feat/summaries-by-branch", "branch:feat/summaries-wiki"]));
  });

  test("things that only look like refs are ignored", () => {
    const refs = extractRefs("color #ff00aa, version 1234567, port :8787, the word deadbeef alone, a/b/c path");
    expect(refs).toEqual([]);
  });

  test("colours and invalid issue numbers never become refs, while issue-like contexts do", () => {
    const refs = extractRefs("#111111 #282828 #fff #0 #000000 issue #42 PR #43 https://github.com/o/r/issues/44");
    expect(refs.map(({ kind, id }) => `${kind}:${id}`)).toEqual(["issue:42", "pr:43", "issue:44"]);
  });

  test("only hashes in git output become commits", () => {
    expect(extractRefs("prose mentions abcdef0; commit abcdef0123456789 from git log", { source: "git-output" }).map((ref) => ref.id)).toEqual(["abcdef0123456789"]);
  });

  test("a ref is well formed by kind", () => {
    expect(isWellFormedRef({ kind: "issue", id: "12" })).toBe(true);
    expect(isWellFormedRef({ kind: "pr", id: "12", title: "x", state: "open" })).toBe(true);
    expect(isWellFormedRef({ kind: "commit", id: "3fa91c2" })).toBe(true);
    expect(isWellFormedRef({ kind: "branch", id: "feat/x" })).toBe(true);
    expect(isWellFormedRef({ kind: "file", id: "src/a.ts" })).toBe(true);
    for (const bad of [{ kind: "issue", id: "abc" }, { kind: "issue", id: "" }, { kind: "commit", id: "xyz" }, { kind: "commit", id: "abc" }, { kind: "branch", id: "has space" }, { kind: "pr", id: "1", url: 3 }, { kind: "thing", id: "1" }, { id: "1" }, "issue 3", null]) expect(isWellFormedRef(bad)).toBe(false);
  });
});

describe("distilled transcript", () => {
  const big = "x".repeat(6000);
  const turns: DistillTurn[] = [];
  for (let index = 0; index < 20; index += 1) {
    turns.push({ kind: "user", text: `request ${index}: ${"please ".repeat(10)}`, at: NOW });
    turns.push({ kind: "thinking", text: big, at: NOW });
    turns.push({ kind: "tool-call", text: "Edit", tool: { name: "Edit", input: JSON.stringify({ file_path: `/repo/src/file${index}.ts`, old_string: big, new_string: big }) }, at: NOW });
    turns.push({ kind: "tool-result", text: big, tool: { name: "Edit", status: "ok" }, at: NOW });
    turns.push({ kind: "assistant", text: `answer ${index}`, at: NOW });
  }

  test("keeps person and agent text, one line per tool call, and is a small fraction of the raw log", () => {
    const lines = distill(turns);
    expect(lines.filter((line) => line.role === "person")).toHaveLength(20);
    expect(lines.filter((line) => line.role === "agent")).toHaveLength(20);
    const tools = lines.filter((line) => line.role === "tool");
    expect(tools).toHaveLength(20);
    expect(tools[3]?.text).toContain("file3.ts");
    expect(JSON.stringify(lines)).not.toContain(big);
    expect(JSON.stringify(lines).length).toBeLessThan(JSON.stringify(turns).length * 0.1);
    expect(lines.map((line) => line.cursor)).toEqual(lines.map((_, index) => String(index)));
  });

  test("a long person message is kept in full", () => {
    const long = "decision ".repeat(400);
    const [line] = distill([{ kind: "user", text: long, at: NOW }]);
    expect(line?.text).toBe(long);
  });

  test("a command carries the short outcome of its result on the same line", () => {
    const lines = distill([
      { kind: "tool-call", text: "Bash", tool: { name: "Bash", input: JSON.stringify({ command: "bun test" }) }, at: NOW },
      { kind: "tool-result", text: "2511 pass\n0 fail\nRan 2511 tests across 190 files.", tool: { name: "Bash", status: "ok" }, at: NOW },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toContain("bun test");
    expect(lines[0]?.text).toContain("2511 pass");
  });

  test("images are references only", () => {
    const [line] = distill([{ kind: "user", text: "look at this", at: NOW, images: [{ path: "/tmp/shot.png" }] }]);
    expect(line?.images).toEqual(["/tmp/shot.png"]);
    expect(line?.text).toContain("look at this");
  });

  test("files an agent edited become file refs relative to the working folder", () => {
    expect(editedFiles(turns.slice(0, 5), "/repo")).toEqual([{ kind: "file", id: "src/file0.ts" }]);
  });
});

describe("curator patch validation", () => {
  const newTopic = JSON.stringify({ topic: { new: { kind: "feat", title: "Chat summaries" } }, sections: { overview: "Summaries become a wiki.", state: "Curator written." }, decisions: { add: [{ text: "Topics, not branches", why: "branches rot" }] }, refs: [{ kind: "issue", id: "42", title: "Wiki" }] });

  test("a good answer creates a topic with a decision, refs and the key messages it points at", () => {
    const { repo, project } = workspace();
    const result = applyCuratorOutput(project, newTopic, { ...CONTEXT, refs: [{ kind: "issue", id: "42" }] });
    expect(result.kind).toBe("ok");
    const created = result.kind === "ok" ? result.value : null;
    expect(created).toMatchObject({ title: "Chat summaries", kind: "feat", status: "active", project: repo, chats: ["c1"], sections: { overview: "Summaries become a wiki.", state: "Curator written.", pitfalls: "", open: "" } });
    expect(created?.decisions).toEqual([{ id: "d1", text: "Topics, not branches", why: "branches rot", at: NOW, chatId: "c1" }]);
    expect(created?.refs).toContainEqual({ kind: "issue", id: "42", title: "Wiki" });
    expect(created?.refs).toContainEqual(expect.objectContaining({ kind: "branch", id: "feat/summaries-wiki" }));
    expect(created?.keyMessages).toEqual([{ chatId: "c1", eventCursor: "0", at: NOW, role: "person", text: "make summaries a wiki, grouped by topic", why: "sets the direction" }]);
    expect(project.topics()).toHaveLength(1);
  });

  test("curator proposals are intersected with mechanically verified refs", () => {
    const { project } = workspace();
    const output = JSON.stringify({ topic: { new: { kind: "feat", title: "Verified refs" } }, refs: [{ kind: "issue", id: "42" }, { kind: "issue", id: "900" }] });
    const result = applyCuratorOutput(project, output, { ...CONTEXT, branch: "(no branch)", refs: [{ kind: "issue", id: "42" }] });
    expect(result.kind === "ok" ? result.value.refs.map((ref) => ref.id) : []).toEqual(["42"]);
  });

  test("topic refs rank session-created refs first and cap each kind at twelve", () => {
    const { project } = workspace();
    const refs = Array.from({ length: 15 }, (_, index) => ({ kind: "issue" as const, id: String(index + 1), lastAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`, count: 1 }));
    refs[0] = { ...refs[0]!, origin: "created" };
    const output = JSON.stringify({ topic: { new: { kind: "feat", title: "Capped refs" } }, refs: refs.map(({ kind, id }) => ({ kind, id })) });
    const result = applyCuratorOutput(project, output, { ...CONTEXT, refs });
    const issues = result.kind === "ok" ? result.value.refs.filter((ref) => ref.kind === "issue") : [];
    expect(issues).toHaveLength(12);
    expect(issues[0]?.id).toBe("1");
  });

  test("assigning to an existing topic patches it, supersedes a decision, keeps the rest and writes a revision", () => {
    const { repo, project } = workspace();
    project.saveTopic(topic(repo, { decisions: [{ id: "d1", text: "Group by branch", why: "simple", at: NOW, chatId: "c0" }], sections: { overview: "Edited by hand.", state: "Draft.", pitfalls: "", open: "" }, chats: ["c0"] }));
    const output = "```json\n" + JSON.stringify({ topic: { assign: "t1" }, sections: { state: "Curator in place." }, decisions: { add: [{ text: "Group by topic", why: "branches repeat" }], supersede: [{ id: "d1", by: 0 }] } }) + "\n```";
    const result = applyCuratorOutput(project, output, { ...CONTEXT, refs: [{ kind: "issue", id: "42" }] });
    expect(result.kind).toBe("ok");
    const saved = project.topic("t1");
    expect(saved?.sections.overview).toBe("Edited by hand.");
    expect(saved?.sections.state).toBe("Curator in place.");
    expect(saved?.decisions.map((decision) => decision.id)).toEqual(["d1", "d2"]);
    expect(saved?.decisions[0]?.supersededBy).toBe("d2");
    expect(saved?.chats).toEqual(["c0", "c1"]);
    expect(project.revisions("t1")).toHaveLength(1);
    expect(project.revisions("t1")[0]?.sections.state).toBe("Draft.");
  });

  test.each([
    ["an unknown section", JSON.stringify({ topic: { assign: "t1" }, sections: { history: "x" } })],
    ["decisions as a section", JSON.stringify({ topic: { assign: "t1" }, sections: { decisions: "x" } })],
    ["a removed decision", JSON.stringify({ topic: { assign: "t1" }, decisions: { remove: ["d1"] } })],
    ["a decisions list replacing the old one", JSON.stringify({ topic: { assign: "t1" }, decisions: [] })],
    ["superseding a decision that does not exist", JSON.stringify({ topic: { assign: "t1" }, decisions: { add: [{ text: "a", why: "b" }], supersede: [{ id: "d9", by: 0 }] } })],
    ["superseding without a decision to supersede it", JSON.stringify({ topic: { assign: "t1" }, decisions: { supersede: [{ id: "d1", by: 0 }] } })],
    ["a malformed ref", JSON.stringify({ topic: { assign: "t1" }, refs: [{ kind: "issue", id: "abc" }] })],
    ["a topic that does not exist", JSON.stringify({ topic: { assign: "nope" } })],
    ["an unknown kind", JSON.stringify({ topic: { new: { kind: "chore", title: "X" } } })],
    ["an empty title", JSON.stringify({ topic: { new: { kind: "fix", title: "  " } } })],
    ["no topic", JSON.stringify({ sections: { state: "x" } })],
    ["prose instead of an answer", "I think this belongs to the summaries topic."],
    ["nothing", ""],
  ])("%s writes nothing", (_name, output) => {
    const { repo, project } = workspace();
    const original = topic(repo, { decisions: [{ id: "d1", text: "Group by branch", why: "simple", at: NOW, chatId: "c0" }] });
    project.saveTopic(original);
    const before = readFileSync(join(project.dir, "topics", "t1", "topic.json"), "utf8");
    const result = applyCuratorOutput(project, output, CONTEXT);
    expect(result.kind).toBe("failed");
    expect(readFileSync(join(project.dir, "topics", "t1", "topic.json"), "utf8")).toBe(before);
    expect(project.revisions("t1")).toHaveLength(0);
    expect(project.topics()).toHaveLength(1);
  });

  test("a key message whose cursor is not in the transcript is dropped, not fatal", () => {
    const { project } = workspace();
    const result = applyCuratorOutput(project, newTopic, { ...CONTEXT, keyMessages: [{ cursor: "99", why: "ghost" }, { cursor: "1", why: "agreed" }] });
    expect(result.kind === "ok" ? result.value.keyMessages.map((message) => message.eventCursor) : null).toEqual(["1"]);
  });
});

describe("candidate topics", () => {
  test("the branch name, shared refs and title words pick at most two candidates", () => {
    const { repo } = workspace();
    const summaries = topic(repo, { id: "a", title: "Chat summaries", aliases: ["Summaries by branch"] });
    const terminal = topic(repo, { id: "b", title: "Desktop terminal", refs: [{ kind: "issue", id: "77" }] });
    const other = topic(repo, { id: "c", title: "Worktree finish" });
    expect(candidateTopics([other, terminal, summaries], { branch: "feat/summaries-wiki", refs: [], text: "" }).map((entry) => entry.id)).toEqual(["a"]);
    expect(candidateTopics([other, terminal, summaries], { branch: "feat/zzz", refs: [{ kind: "issue", id: "77" }], text: "" }).map((entry) => entry.id)).toEqual(["b"]);
    expect(candidateTopics([other, terminal, summaries], { branch: "feat/summaries-wiki", refs: [{ kind: "issue", id: "77" }], text: "worktree finish bug" })).toHaveLength(2);
    expect(candidateTopics([other], { branch: "feat/unrelated", refs: [], text: "nothing alike" })).toEqual([]);
  });
});
