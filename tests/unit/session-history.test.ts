import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentCommand } from "../../src/adapters/agent-command.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { sessionHistory } from "../../src/adapters/session-history.js";
import { executeAgent } from "../../src/cli/commands/agent.js";
import { executeSessions } from "../../src/cli/commands/sessions.js";
import { failed, ok } from "../../src/core/result.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const CWD = "/work/demo";
const OTHER = "/work/other";

function machine(): { home: string; stateDir: string; environment: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "megabrain-history-"));
  roots.push(root);
  const home = join(root, "home");
  const stateDir = join(root, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { home, stateDir, environment: { HOME: home, MEGABRAIN_STATE_DIR: stateDir } };
}

function write(path: string, contents: string, at?: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  if (at !== undefined) utimesSync(path, new Date(at), new Date(at));
}

function claudeLog(home: string, cwd: string, id: string, prompt: string, at: string): void {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const lines = [{ type: "user", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: prompt } }, { type: "assistant", message: { role: "assistant", content: "ok" } }];
  write(join(home, ".claude", "projects", encoded, `${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, at);
}

function codexRollout(home: string, cwd: string, id: string, prompt: string, at: string): void {
  const lines = [
    { type: "session_meta", timestamp: "2026-10-02T09:00:00.000Z", payload: { id, cwd, timestamp: "2026-10-02T09:00:00.000Z" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
  ];
  write(join(home, ".codex", "sessions", "2026", "10", "02", `rollout-2026-10-02T09-00-00-${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, at);
}

function grokSession(home: string, cwd: string, id: string, title: string, messages: number): void {
  const summary = { info: { id, cwd }, session_summary: title, created_at: "2026-10-03T08:00:00.000Z", updated_at: "2026-10-03T08:30:00.000Z", num_chat_messages: messages };
  write(join(home, ".grok", "sessions", encodeURIComponent(cwd), id, "summary.json"), JSON.stringify(summary));
}

function agyHistory(home: string, rows: readonly object[]): void {
  write(join(home, ".gemini", "antigravity-cli", "history.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

describe("session history", () => {
  test("lists every agent's past sessions for the folder, newest first, and no other folder's", async () => {
    const { home, stateDir } = machine();
    claudeLog(home, CWD, "claude-old", "first claude prompt", "2026-10-01T10:05:00Z");
    claudeLog(home, OTHER, "claude-other", "elsewhere", "2026-10-09T10:05:00Z");
    codexRollout(home, CWD, "codex-1", "codex prompt", "2026-10-02T09:30:00Z");
    codexRollout(home, OTHER, "codex-other", "elsewhere", "2026-10-09T09:30:00Z");
    grokSession(home, CWD, "grok-1", "grok title", 12);
    agyHistory(home, [
      { display: "/model", timestamp: Date.parse("2026-10-04T07:00:00Z"), workspace: CWD, conversationId: "agy-1", type: "slash_command" },
      { display: "agy first prompt", timestamp: Date.parse("2026-10-04T07:01:00Z"), workspace: CWD, conversationId: "agy-1" },
      { display: "agy later", timestamp: Date.parse("2026-10-04T07:20:00Z"), workspace: CWD, conversationId: "agy-1" },
      { display: "not here", timestamp: Date.parse("2026-10-09T07:20:00Z"), workspace: OTHER, conversationId: "agy-other" },
    ]);
    const sessions = await sessionHistory(CWD, undefined, { home, stateDir });
    expect(sessions.map((session) => `${session.agent}:${session.id}`)).toEqual(["agy:agy-1", "grok:grok-1", "codex:codex-1", "claude:claude-old"]);
    const byAgent = Object.fromEntries(sessions.map((session) => [session.agent, session]));
    expect(byAgent.claude).toMatchObject({ title: "first claude prompt", messageCount: null, lastActivityAt: "2026-10-01T10:05:00.000Z" });
    expect(byAgent.codex).toMatchObject({ title: "codex prompt", startedAt: "2026-10-02T09:00:00.000Z", lastActivityAt: "2026-10-02T09:30:00.000Z" });
    expect(byAgent.grok).toMatchObject({ title: "grok title", messageCount: 12, startedAt: "2026-10-03T08:00:00.000Z", lastActivityAt: "2026-10-03T08:30:00.000Z" });
    expect(byAgent.agy).toMatchObject({ title: "agy first prompt", startedAt: "2026-10-04T07:00:00.000Z", lastActivityAt: "2026-10-04T07:20:00.000Z" });
  });

  test("an agent filter and a limit narrow the list", async () => {
    const { home, stateDir } = machine();
    for (const [index, id] of ["a", "b", "c"].entries()) claudeLog(home, CWD, id, `prompt ${id}`, `2026-10-0${index + 1}T10:00:00Z`);
    codexRollout(home, CWD, "codex-1", "codex prompt", "2026-10-09T09:30:00Z");
    expect((await sessionHistory(CWD, "claude", { home, stateDir })).map((session) => session.id)).toEqual(["c", "b", "a"]);
    expect((await sessionHistory(CWD, undefined, { home, stateDir, limit: 2 })).map((session) => session.id)).toEqual(["codex-1", "c"]);
  });

  test("an agent with no readable history contributes nothing and a malformed log is skipped", async () => {
    const { home, stateDir } = machine();
    write(join(home, ".codex", "sessions", "2026", "10", "02", "rollout-bad.jsonl"), "{not json\n");
    write(join(home, ".grok", "sessions", encodeURIComponent(CWD), "broken", "summary.json"), "{");
    write(join(home, ".gemini", "antigravity-cli", "history.jsonl"), "garbage\n");
    claudeLog(home, CWD, "only", "solo", "2026-10-01T10:00:00Z");
    expect((await sessionHistory(CWD, undefined, { home, stateDir })).map((session) => session.id)).toEqual(["only"]);
  });

  test("a warm run reads the cache and reflects a changed log", async () => {
    const { home, stateDir } = machine();
    codexRollout(home, CWD, "codex-1", "before", "2026-10-02T09:30:00Z");
    expect((await sessionHistory(CWD, "codex", { home, stateDir }))[0]?.title).toBe("before");
    const cache = JSON.parse(await Bun.file(join(stateDir, "session-history-cache.json")).text()) as unknown;
    expect(typeof cache).toBe("object");
    codexRollout(home, CWD, "codex-1", "after the edit, longer", "2026-10-02T09:45:00Z");
    expect((await sessionHistory(CWD, "codex", { home, stateDir }))[0]).toMatchObject({ title: "after the edit, longer", lastActivityAt: "2026-10-02T09:45:00.000Z" });
  });

  test("sessions history --json prints the list and rejects a missing folder", async () => {
    const { home, environment } = machine();
    claudeLog(home, CWD, "one", "hello", "2026-10-01T10:00:00Z");
    const result = await executeSessions(["history", "--cwd", CWD, "--agent", "claude", "--limit", "5", "--json"], environment);
    expect(result.kind).toBe("ok");
    const rows = JSON.parse(result.kind === "ok" ? result.value : "null") as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ agent: "claude", id: "one", title: "hello", startedAt: "2026-10-01T10:00:00.000Z", lastActivityAt: "2026-10-01T10:00:00.000Z", messageCount: null }]);
    expect((await executeSessions(["history", "--json"], environment)).kind).toBe("failed");
    expect((await executeSessions(["history", "--cwd", CWD, "--agent", "gemini"], environment)).kind).toBe("failed");
  });
});

function installed(): ProcessAdapter {
  return {
    run: async (_command, args) => ok({ stdout: `/bin/${(args.at(-1) ?? "").split(" ").at(-1)}\n`, stderr: "", exitCode: 0 }),
    startDetached: async () => failed("a TUI is never started here"),
    invocationCount: () => 0,
  };
}

describe("agent command --resume", () => {
  test("each agent resumes by id in its own TUI with permission prompts skipped", async () => {
    const adapter = installed();
    expect(await agentCommand("claude", { resume: "s1" }, adapter)).toEqual(["claude", "--dangerously-skip-permissions", "--resume", "s1"]);
    expect(await agentCommand("codex", { resume: "s1" }, adapter)).toEqual(["codex", "resume", "s1", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false"]);
    expect(await agentCommand("grok", { resume: "s1" }, adapter)).toEqual(["grok", "--always-approve", "--resume", "s1"]);
    expect(await agentCommand("agy", { resume: "s1" }, adapter)).toEqual(["agy", "--dangerously-skip-permissions", "--conversation", "s1"]);
  });

  test("model and effort ride along with the resume", async () => {
    expect(await agentCommand("claude", { resume: "s1", model: "m1", effort: "high" }, installed())).toEqual(["claude", "--dangerously-skip-permissions", "--model", "m1", "--effort", "high", "--resume", "s1"]);
    expect(await agentCommand("codex", { resume: "s1", model: "m1" }, installed())).toEqual(["codex", "resume", "s1", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false", "-c", "model=m1"]);
  });

  test("--resume prints through the command line and needs a value", async () => {
    const result = await executeAgent(["command", "grok", "--resume", "s1", "--json"], {}, installed());
    expect(JSON.parse(result.kind === "ok" ? result.value : "null")).toEqual({ agent: "grok", argv: ["grok", "--always-approve", "--resume", "s1"] });
    expect((await executeAgent(["command", "grok", "--resume"], {}, installed())).kind).toBe("failed");
  });
});
