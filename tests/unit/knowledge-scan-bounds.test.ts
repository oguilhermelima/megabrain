import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeKnowledge } from "../../src/cli/commands/knowledge.js";
import { KnowledgePipeline } from "../../src/knowledge/pipeline.js";
import { scanHorizon, scanProjects } from "../../src/knowledge/scanner.js";
import { effectiveToggles, readKnowledgeSettings } from "../../src/knowledge/settings.js";
import { openProject } from "../../src/knowledge/store.js";
import { defaultSummarySettings } from "../../src/chat/summaries.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const NOW = new Date("2026-10-17T12:00:00.000Z");
const DAY = 86_400_000;
const CURATE_NEW = JSON.stringify({ topic: { new: { kind: "feat", title: "Chat summaries" } }, sections: { overview: "Summaries of chats." } });
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-scan-bounds-")));
  directories.push(root);
  const state = join(root, "state"), home = join(root, "home"), repo = join(root, "repo");
  for (const directory of [state, home, repo]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(state, "chat-summaries.json"), JSON.stringify({ ...defaultSummarySettings, enabled: true, model: "stub" }));
  const calls: Array<{ purpose: "summary" | "curator"; prompt: string }> = [];
  const ask = async (prompt: string, purpose: "summary" | "curator"): Promise<string> => {
    calls.push({ purpose, prompt });
    return purpose === "summary" ? `TITLE: Outcome ${calls.length}\nSUMMARY: This feature groups summaries by topic.` : CURATE_NEW;
  };
  const environment = { HOME: home, MEGABRAIN_STATE_DIR: state };
  const pipeline = new KnowledgePipeline({ stateDir: state, environment, ask, now: () => NOW });
  const scan = (extra: Record<string, unknown> = {}) => scanProjects({ stateDir: state, home, environment, pipeline, projects: [repo], dispatchLinks: new Map(), now: () => NOW, ...extra });
  return { root, state, home, repo, calls, environment, pipeline, scan, project: openProject(state, repo), summaryCalls: () => calls.filter((call) => call.purpose === "summary").length };
}

type Harness = ReturnType<typeof harness>;

/** A Claude session log whose last activity (the file's mtime) is the given date. */
function claudeLog(h: Harness, id: string, last: Date, texts: string[] = ["make summaries a wiki", "and add a map", "include an index"], assistantChars = 0): void {
  const directory = join(h.home, ".claude", "projects", h.repo.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  const rows = texts.flatMap((text, index) => [
    { type: "user", uuid: `u${index}`, timestamp: last.toISOString(), message: { content: text } },
    { type: "assistant", uuid: `a${index}`, timestamp: last.toISOString(), message: { id: `m${index}`, content: [{ type: "text", text: assistantChars > 0 ? "x".repeat(assistantChars) : `reply ${index}` }] } },
  ]);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  utimesSync(path, last, last);
}

describe("scan horizon", () => {
  test("the first scan of a project sets its horizon to now minus seven days and takes only newer sessions", async () => {
    const h = harness();
    claudeLog(h, "OLD", ago(30));
    claudeLog(h, "RECENT", ago(2));
    const result = await h.scan();
    expect(scanHorizon(h.state, h.repo)).toBe(ago(7).toISOString());
    expect(h.project.chatBySession("claude:RECENT")).not.toBeNull();
    expect(h.project.chatBySession("claude:OLD")).toBeNull();
    expect(h.summaryCalls()).toBe(1);
    expect(result.processed).toBe(1);
  });

  test("the horizon is kept: a later scan, ten days on, still ignores what was older at the first scan and picks up what is new", async () => {
    const h = harness();
    claudeLog(h, "OLD", ago(30));
    await h.scan();
    h.calls.length = 0;
    claudeLog(h, "NEWER", ago(1));
    const later = new Date(NOW.getTime() + 10 * DAY);
    await h.scan({ now: () => later });
    expect(scanHorizon(h.state, h.repo)).toBe(ago(7).toISOString());
    expect(h.project.chatBySession("claude:OLD")).toBeNull();
    expect(h.project.chatBySession("claude:NEWER")).not.toBeNull();
    expect(h.summaryCalls()).toBe(1);
  });

  test("a session that grows after it was scanned is picked up again, a quiet one is not", async () => {
    const h = harness();
    claudeLog(h, "S1", ago(2), ["first", "second"]);
    await h.scan();
    h.calls.length = 0;
    await h.scan();
    expect(h.calls).toHaveLength(0);
    claudeLog(h, "S1", ago(1), ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"]);
    await h.scan();
    expect(h.summaryCalls()).toBe(1);
  });

  test("a project with its switches off gets no horizon and nothing is written", async () => {
    const h = harness();
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ projects: { [h.repo]: { summaries: false } } }));
    claudeLog(h, "RECENT", ago(1));
    await h.scan();
    expect(scanHorizon(h.state, h.repo)).toBeNull();
    expect(existsSync(join(h.state, "knowledge"))).toBe(false);
  });
});

describe("scan since", () => {
  test("since takes older sessions on demand without moving the stored horizon", async () => {
    const h = harness();
    claudeLog(h, "RECENT", ago(2));
    claudeLog(h, "OLD", ago(30));
    claudeLog(h, "ANCIENT", ago(90));
    await h.scan();
    h.calls.length = 0;
    await h.scan({ since: ago(60) });
    expect(h.project.chatBySession("claude:OLD")).not.toBeNull();
    expect(h.project.chatBySession("claude:ANCIENT")).toBeNull();
    expect(h.summaryCalls()).toBe(1);
    expect(scanHorizon(h.state, h.repo)).toBe(ago(7).toISOString());
  });

  test("the CLI reads since as an ISO date or as a number of days", async () => {
    const h = harness();
    claudeLog(h, "OLD", ago(30));
    const days = await executeKnowledge(["scan", "--repo", h.repo, "--since", "60d", "--dry-run", "--json"], h.environment);
    const iso = await executeKnowledge(["scan", "--repo", h.repo, "--since", ago(60).toISOString().slice(0, 10), "--dry-run", "--json"], h.environment);
    for (const outcome of [days, iso]) {
      expect(outcome.kind).toBe("ok");
      const body = outcome.kind === "ok" ? JSON.parse(outcome.value) : null;
      expect(body.projects[0]).toMatchObject({ repo: h.repo, inHorizon: 1 });
    }
    expect((await executeKnowledge(["scan", "--since", "yesterday", "--json"], h.environment)).kind).toBe("failed");
  });
});

describe("scan dry run", () => {
  test("it calls no model, writes nothing and reports the sessions in the horizon, the older ones and the calls it would make", async () => {
    const h = harness();
    claudeLog(h, "R1", ago(1));
    claudeLog(h, "R2", ago(3));
    claudeLog(h, "OLD1", ago(30));
    claudeLog(h, "OLD2", ago(40));
    claudeLog(h, "OLD3", ago(50));
    const result = await h.scan({ dryRun: true });
    expect(h.calls).toHaveLength(0);
    expect(result.processed).toBe(0);
    expect(result.projects).toEqual([{ repo: h.repo, inHorizon: 2, older: 3, estimatedCalls: 4 }]);
    expect(scanHorizon(h.state, h.repo)).toBeNull();
    expect(existsSync(join(h.state, "knowledge"))).toBe(false);
  });

  test("with since, the older sessions reached by it count as in the horizon", async () => {
    const h = harness();
    claudeLog(h, "R1", ago(1));
    claudeLog(h, "OLD1", ago(30));
    claudeLog(h, "OLD2", ago(100));
    const result = await h.scan({ dryRun: true, since: ago(60) });
    expect(result.projects[0]).toMatchObject({ inHorizon: 2, older: 1, estimatedCalls: 4 });
  });

  test("a dispatch worker's session costs no model call", async () => {
    const h = harness();
    claudeLog(h, "LEAD", ago(1));
    claudeLog(h, "WORKER", ago(1));
    const result = await h.scan({ dryRun: true, dispatchLinks: new Map([["claude:WORKER", "claude:LEAD"]]) });
    expect(result.projects[0]).toMatchObject({ inHorizon: 2, estimatedCalls: 2 });
  });
});

describe("scan cap", () => {
  test("by default a scan summarises at most 20 sessions, newest first, and the next scan takes the rest", async () => {
    const h = harness();
    for (let index = 0; index < 25; index += 1) claudeLog(h, `S${String(index).padStart(2, "0")}`, new Date(ago(6).getTime() + index * 3_600_000));
    const first = await h.scan();
    expect(first.processed).toBe(20);
    expect(h.summaryCalls()).toBe(20);
    const done = h.project.chats().map((chat) => chat.sessionKeys[0]).sort();
    expect(done).toEqual(Array.from({ length: 20 }, (_, index) => `claude:S${String(index + 5).padStart(2, "0")}`));
    expect(h.project.chatBySession("claude:S04")).toBeNull();
    h.calls.length = 0;
    const second = await h.scan();
    expect(second.processed).toBe(5);
    expect(h.summaryCalls()).toBe(5);
    expect(h.project.chats()).toHaveLength(25);
  });

  test("the cap is one budget for the whole scan, not one per project", async () => {
    const h = harness();
    const other = join(h.root, "other");
    mkdirSync(other, { recursive: true });
    for (let index = 0; index < 3; index += 1) claudeLog(h, `A${index}`, ago(1 + index));
    const otherDirectory = join(h.home, ".claude", "projects", other.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(otherDirectory, { recursive: true });
    for (let index = 0; index < 3; index += 1) {
      const path = join(otherDirectory, `B${index}.jsonl`);
      writeFileSync(path, ["work", "more", "finish"].map((text, turn) => ({ type: "user", uuid: `u${turn}`, timestamp: ago(1).toISOString(), message: { content: text } })).map((row) => JSON.stringify(row)).join("\n") + "\n");
      utimesSync(path, ago(1), ago(1));
    }
    const result = await h.scan({ projects: [h.repo, other], maxSessions: 4 });
    expect(result.processed).toBeLessThanOrEqual(4);
    expect(h.summaryCalls()).toBe(4);
  });

  test("the CLI takes the cap from --limit", async () => {
    const h = harness();
    for (let index = 0; index < 3; index += 1) claudeLog(h, `S${index}`, ago(1 + index));
    const outcome = await executeKnowledge(["scan", "--repo", h.repo, "--limit", "2", "--dry-run", "--json"], h.environment);
    const body = outcome.kind === "ok" ? JSON.parse(outcome.value) : null;
    expect(body.projects[0]).toMatchObject({ inHorizon: 3, estimatedCalls: 4 });
  });
});

describe("scan input size", () => {
  test("a very large session reaches the summariser clipped to the summary size limits", async () => {
    const h = harness();
    const texts = Array.from({ length: 300 }, (_, index) => `step ${index}: ${"y".repeat(2000)}`);
    claudeLog(h, "HUGE", ago(1), texts, 5000);
    await h.scan();
    const summary = h.calls.find((call) => call.purpose === "summary");
    expect(summary).toBeDefined();
    expect((summary as { prompt: string }).prompt.length).toBeLessThan(18_000);
    expect(h.project.chatBySession("claude:HUGE")).not.toBeNull();
  });
});

describe("fresh install default", () => {
  test("with no chat-summaries file and no knowledge file every toggle is off for every project", () => {
    const h = harness();
    rmSync(join(h.state, "chat-summaries.json"));
    const settings = readKnowledgeSettings(h.state);
    expect(settings.defaults).toEqual({ summaries: false, retitle: false, topics: false, sessions: false, context: false });
    expect(effectiveToggles(settings, h.repo)).toEqual({ summaries: false, retitle: false, topics: false, sessions: false, context: false });
    expect(existsSync(join(h.state, "knowledge-settings.json"))).toBe(false);
  });

  test("a fresh install scans nothing and calls no model", async () => {
    const h = harness();
    rmSync(join(h.state, "chat-summaries.json"));
    claudeLog(h, "S1", ago(1));
    const result = await h.scan();
    expect(result.scanned).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  test("migrating chat-summaries with enabled true turns summaries on, with the other toggles on beside it", () => {
    const h = harness();
    expect(readKnowledgeSettings(h.state).defaults).toEqual({ summaries: true, retitle: true, topics: true, sessions: true, context: true });
    expect(JSON.parse(readFileSync(join(h.state, "knowledge-settings.json"), "utf8")).defaults.summaries).toBe(true);
  });

  test("a chat-summaries file that never set enabled migrates to summaries off", () => {
    const h = harness();
    writeFileSync(join(h.state, "chat-summaries.json"), JSON.stringify({ model: "stub" }));
    expect(readKnowledgeSettings(h.state).defaults.summaries).toBe(false);
  });

  test("once the person has saved knowledge settings, those defaults apply as saved", () => {
    const h = harness();
    rmSync(join(h.state, "chat-summaries.json"));
    writeFileSync(join(h.state, "knowledge-settings.json"), JSON.stringify({ defaults: { summaries: true, context: false }, projects: {} }));
    expect(readKnowledgeSettings(h.state).defaults).toEqual({ summaries: true, retitle: true, topics: true, sessions: true, context: false });
  });
});
