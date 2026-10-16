import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { registerMegabrainRepository } from "../../src/core/project-registry.js";
import { ok } from "../../src/core/result.js";
import { guardedOpenDatabase } from "./state-db-guard.js";

let root = "";
let home = "";
let state = "";
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-project-registry-")));
  home = join(root, "home");
  state = join(root, "state");
  mkdirSync(home);
  env = { HOME: home, MEGABRAIN_STATE_DIR: state };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function cli(...args: string[]) {
  return route(args, { environment: env, processAdapter: createProcessAdapter() });
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await createProcessAdapter().run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
  return result.value.stdout.trim();
}

async function repository(name: string): Promise<string> {
  const path = join(root, name);
  mkdirSync(path);
  await git(path, "init", "-b", "main");
  await git(path, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--allow-empty", "-m", "initial");
  return path;
}

function json<T>(result: { kind: string; value?: string; error?: string }): T {
  if (result.kind !== "ok" || result.value === undefined) throw new Error(result.error ?? "expected command output");
  return JSON.parse(result.value) as T;
}

describe("project registry", () => {
  test("repo add resolves a worktree to the main checkout and is idempotent", async () => {
    const main = await repository("main");
    const tree = join(root, "tree");
    await git(main, "worktree", "add", "-b", "feature", tree);

    const first = json<{ path: string; source: string }>(await cli("repo", "add", tree, "--json"));
    const second = json<{ path: string; addedAt: string }>(await cli("repo", "add", main, "--json"));
    expect(first.path).toBe(main);
    expect(first.source).toBe("import");
    expect(second.path).toBe(main);
    expect(second.addedAt).toBeTruthy();
    expect(json<unknown[]>(await cli("repo", "list", "--json"))).toHaveLength(1);
  });

  test("projects hide and unhide a repository and worktree without removing either", async () => {
    const main = await repository("hidden-roundtrip");
    const tree = join(root, "hidden-tree");
    await git(main, "worktree", "add", "-b", "hidden-branch", tree);
    await cli("repo", "add", main);
    expect((await cli("repo", "hide", main)).kind).toBe("ok");
    expect((await cli("worktree", "hide", tree)).kind).toBe("ok");
    let project = json<Array<{ hidden: boolean; worktrees: Array<{ path: string; hidden: boolean }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project).toMatchObject({ hidden: true });
    expect(project?.worktrees.find((item) => item.path === tree)).toMatchObject({ hidden: true });
    await cli("repo", "unhide", main);
    await cli("worktree", "unhide", tree);
    project = json<Array<{ hidden: boolean; worktrees: Array<{ path: string; hidden: boolean }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project).toMatchObject({ hidden: false });
    expect(project?.worktrees.find((item) => item.path === tree)).toMatchObject({ hidden: false });
  });

  test("Claude session timers use context tokens, settings and environment minimum", async () => {
    const path = await repository("timers");
    const directory = join(home, ".claude", "sessions");
    mkdirSync(directory, { recursive: true });
    const activity = new Date(Date.now() - 10_000).toISOString();
    writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "timer-session", cwd: path, startedAt: activity, updatedAt: activity, status: "idle" }));
    const transcript = join(home, ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(transcript, { recursive: true });
    writeFileSync(join(transcript, "timer-session.jsonl"), `${JSON.stringify({ type: "assistant", message: { model: "claude-sonnet", usage: { input_tokens: 210000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n`);
    await cli("repo", "add", path);
    const withDefault = json<Array<{ worktrees: Array<{ sessions: Array<{ contextTokens: number; cacheExpiresAt: string; idleCompactAt: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0]?.worktrees[0]?.sessions[0];
    expect(withDefault?.contextTokens).toBe(210000);
    expect(Date.parse(withDefault?.cacheExpiresAt ?? "") - Date.parse(activity)).toBe(60 * 60 * 1000);
    expect(Date.parse(withDefault?.idleCompactAt ?? "") - Date.parse(activity)).toBe(54 * 60 * 1000);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ idleCompaction: false }));
    const disabled = json<Array<{ worktrees: Array<{ sessions: Array<{ idleCompactAt: string | null }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0]?.worktrees[0]?.sessions[0];
    expect(disabled?.idleCompactAt).toBeNull();
    env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = "220000";
    const aboveMin = json<Array<{ worktrees: Array<{ sessions: Array<{ idleCompactAt: string | null }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0]?.worktrees[0]?.sessions[0];
    expect(aboveMin?.idleCompactAt).toBeNull();
  });

  test("projects report the latest Claude model and infer its actual context window", async () => {
    const path = await repository("session-models");
    const directory = join(home, ".claude", "sessions");
    const transcript = join(home, ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(directory, { recursive: true });
    mkdirSync(transcript, { recursive: true });
    const now = new Date().toISOString();
    const sessions = [
      { id: "usage-proof", model: "claude-sonnet-5-5", usage: { input_tokens: 210001 } },
      { id: "marker-proof", model: "claude-opus-5-5[1m]", usage: { input_tokens: 1000 } },
      { id: "settings-proof", model: "claude-haiku-5-5", usage: { input_tokens: 1000 } },
    ];
    for (const [index, session] of sessions.entries()) {
      const pid = process.pid + index;
      writeFileSync(join(directory, `${pid}.json`), JSON.stringify({ pid, sessionId: session.id, cwd: path, startedAt: now, updatedAt: now, status: "working" }));
      writeFileSync(join(transcript, `${session.id}.jsonl`), `${JSON.stringify({ type: "assistant", message: { model: session.model, usage: session.usage } })}\n`);
    }
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-haiku-5-5[1m]" }));
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ sessionId: string; model: string | null; contextWindow: number | null }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    const actual = project?.worktrees[0]?.sessions;
    expect(actual?.find((session) => session.sessionId === "claude:usage-proof")).toMatchObject({ model: "claude-sonnet-5-5", contextWindow: 1000000 });
    expect(actual?.find((session) => session.sessionId === "claude:marker-proof")).toMatchObject({ model: "claude-opus-5-5[1m]", contextWindow: 1000000 });
    expect(actual?.find((session) => session.sessionId === "claude:settings-proof")).toMatchObject({ model: "claude-haiku-5-5", contextWindow: 1000000 });
  });

  test("Claude context tokens restart at the latest compact boundary and its size proves the window", async () => {
    const path = await repository("compact-boundary");
    const directory = join(home, ".claude", "sessions");
    const transcript = join(home, ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(directory, { recursive: true });
    mkdirSync(transcript, { recursive: true });
    const now = new Date().toISOString();
    const assistant = (input: number) => ({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: input } } });
    const boundary = (postTokens?: number) => ({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "manual", preTokens: 700000, ...(postTokens === undefined ? {} : { postTokens }) } });
    const sessions = [
      { id: "recorded", lines: [assistant(700000), boundary(15000)] },
      { id: "unrecorded", lines: [assistant(700000), boundary()] },
      { id: "after", lines: [assistant(700000), boundary(15000), assistant(20000)] },
    ];
    for (const [index, session] of sessions.entries()) {
      const pid = process.pid + index;
      writeFileSync(join(directory, `${pid}.json`), JSON.stringify({ pid, sessionId: session.id, cwd: path, startedAt: now, updatedAt: now, status: "idle" }));
      writeFileSync(join(transcript, `${session.id}.jsonl`), `${session.lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    }
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ sessionId: string; contextTokens: number; contextWindow: number | null }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    const actual = project?.worktrees[0]?.sessions;
    expect(actual?.find((session) => session.sessionId === "claude:recorded")).toMatchObject({ contextTokens: 15000, contextWindow: 1000000 });
    expect(actual?.find((session) => session.sessionId === "claude:unrecorded")).toMatchObject({ contextTokens: 0, contextWindow: 1000000 });
    expect(actual?.find((session) => session.sessionId === "claude:after")).toMatchObject({ contextTokens: 20000, contextWindow: 1000000 });
  });

  test("repo add refuses a non-repository and remove leaves files intact", async () => {
    const folder = join(root, "folder");
    mkdirSync(folder);
    const refused = await cli("repo", "add", folder);
    expect(refused.kind).toBe("failed");
    expect(refused.error).toContain("not a git repository");

    const path = await repository("kept");
    await cli("repo", "add", path);
    const removed = await cli("repo", "remove", path);
    expect(removed.kind).toBe("ok");
    expect(existsSync(join(path, ".git"))).toBe(true);
  });

  test("repo clone accepts a local bare repository and refuses an existing destination", async () => {
    const source = await repository("origin");
    const bare = join(root, "origin.git");
    await git(root, "clone", "--bare", source, bare);
    const destination = join(root, "clones");
    const cloned = json<{ path: string }>(await cli("repo", "clone", bare, "--into", destination, "--json"));
    expect(cloned.path).toBe(join(destination, "origin"));
    expect((await cli("repo", "clone", bare, "--into", destination)).kind).toBe("failed");
  });

  test("GitHub owner/name shorthand expands to the GitHub HTTPS URL", async () => {
    const expanded = await import("../../src/core/project-registry.js");
    expect(expanded.expandRepositoryUrl("owner/project")).toBe("https://github.com/owner/project");
    expect(expanded.expandRepositoryUrl("git@github.com:owner/project.git")).toBe("git@github.com:owner/project.git");
  });

  test("megabrain-created repository registration is idempotent for spawn and worktree create", async () => {
    const path = await repository("registered");
    const process = createProcessAdapter();
    await registerMegabrainRepository(path, env, process);
    await registerMegabrainRepository(path, env, process);
    expect(json<Array<{ source: string }>>(await cli("repo", "list", "--json"))).toEqual([expect.objectContaining({ source: "megabrain" })]);
  });

  test("first projects read backfills dispatch and worktree history only once", async () => {
    const path = await repository("history");
    const opened = guardedOpenDatabase(env);
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      opened.value.db.run("INSERT INTO dispatches (id,state,worktree_path,chat_name,extra) VALUES (?,?,?,?,?)", ["dispatch-history", "done", path, "history", "{\"$present\":[\"dispatchId\",\"state\",\"worktreePath\"]}"]);
    } finally { opened.value.close(); }
    const projects = json<Array<{ path: string }>>(await cli("projects", "--json", "--include-foreign"));
    expect(projects.map((project) => project.path)).toContain(path);
    expect(json<Array<{ path: string }>>(await cli("projects", "--json", "--include-foreign"))).toHaveLength(projects.length);
  });

  test("projects put the main checkout first and sort branches with detached HEAD support", async () => {
    const main = await repository("ordered");
    const zTree = join(root, "z-tree");
    const aTree = join(root, "a-tree");
    const detached = join(root, "detached");
    await git(main, "worktree", "add", "-b", "zeta", zTree);
    await git(main, "worktree", "add", "-b", "alpha", aTree);
    await git(main, "worktree", "add", "--detach", detached);
    await cli("repo", "add", main);
    const project = json<Array<{ worktrees: Array<{ path: string; branch: string | null; primary: boolean }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project?.worktrees.map(({ path }) => path)).toEqual([main, aTree, zTree, detached]);
    expect(project?.worktrees[0]?.primary).toBe(true);
    expect(project?.worktrees.find((tree) => tree.path === detached)?.branch).toBeNull();
  });

  test("missing registered folders are marked missing and have no worktrees", async () => {
    const path = await repository("vanished");
    await cli("repo", "add", path);
    rmSync(path, { recursive: true, force: true });
    const project = json<Array<{ missing: boolean; worktrees: unknown[] }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project).toMatchObject({ missing: true, worktrees: [] });
  });

  test("Claude and Grok registry shapes map sessions, 24-hour cutoff and five ended limit", async () => {
    const path = await repository("sessions");
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    const now = Date.now();
    for (let index = 0; index < 7; index += 1) {
      const item = { pid: 900000 + index, sessionId: `claude-${index}`, cwd: path, startedAt: new Date(now - index * 1000).toISOString(), name: `Session ${index}`, status: "idle", updatedAt: new Date(now - index * 1000).toISOString() };
      writeFileSync(join(sessions, `${item.pid}.json`), JSON.stringify(item));
    }
    const old = { pid: 999999, sessionId: "claude-old", cwd: path, startedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString(), name: "Old session", status: "idle", updatedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString() };
    writeFileSync(join(sessions, `${old.pid}.json`), JSON.stringify(old));
    const grok = join(home, ".grok");
    mkdirSync(grok, { recursive: true });
    writeFileSync(join(grok, "active_sessions.json"), JSON.stringify([{ session_id: "grok-1", cwd: path, pid: process.pid, status: "busy", started_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(), title: "Grok session" }]));
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ agent: string; status: string; title: string; sessionId: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    const found = project?.worktrees[0]?.sessions ?? [];
    expect(found.filter((session) => session.agent === "claude")).toHaveLength(5);
    expect(found.some((session) => session.agent === "grok" && session.sessionId === "grok:grok-1")).toBe(true);
    expect(found.some((session) => session.sessionId === "claude:claude-old")).toBe(false);
    expect(found[0]?.title).toBeTruthy();
  });

  test("project command maps dispatch IDs to live sessions", async () => {
    const path = await repository("dispatch-session");
    const sessionDirectory = join(home, ".claude", "sessions");
    mkdirSync(sessionDirectory, { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(join(sessionDirectory, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "dispatch-session-id", cwd: path, startedAt, name: "Agent session", status: "busy", updatedAt: startedAt }));
    const opened = guardedOpenDatabase(env);
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      opened.value.db.run("INSERT INTO dispatches (id,state,agent,worktree_path,chat_name,agent_thread_id,created_at,updated_at,extra) VALUES (?,?,?,?,?,?,?,?,?)", ["dispatch-1", "running", "claude", path, "Agent session", "dispatch-session-id", startedAt, startedAt, "{\"$present\":[\"dispatchId\",\"state\",\"agent\",\"worktreePath\",\"agentThreadId\",\"createdAt\"]}"]);
    } finally { opened.value.close(); }
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ dispatchId: string | null }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project?.worktrees[0]?.sessions[0]?.dispatchId).toBe("dispatch-1");
  });

  test("project sessions prefer dispatch labels and explicit Claude names", async () => {
    const path = await repository("session-titles");
    const directory = join(home, ".claude", "sessions");
    mkdirSync(directory, { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(join(directory, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, sessionId: "title-session", cwd: path, startedAt,
      name: "Nome escolhido", nameSource: "user", status: "busy", updatedAt: startedAt,
    }));
    const opened = guardedOpenDatabase(env);
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      opened.value.db.run("INSERT INTO dispatches (id,state,agent,worktree_path,chat_name,agent_thread_id,created_at,updated_at,extra) VALUES (?,?,?,?,?,?,?,?,?)", [
        "dispatch-title", "running", "claude", path, "Título do despacho", "title-session", startedAt, startedAt,
        JSON.stringify({ label: "Título do despacho", "$present": ["dispatchId", "state", "agent", "worktreePath", "agentThreadId", "createdAt"] }),
      ]);
    } finally { opened.value.close(); }
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project?.worktrees[0]?.sessions[0]?.title).toBe("Título do despacho");
  });

  test("Claude titles use the latest AI title from the transcript tail and then the first user message", async () => {
    const path = await repository("claude-ai-titles");
    const sessions = join(home, ".claude", "sessions");
    const project = join(home, ".claude", "projects", path.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(sessions, { recursive: true });
    mkdirSync(project, { recursive: true });
    const startedAt = new Date().toISOString();
    const fixtures = await import("node:fs/promises");
    const aiTitle = (await fixtures.readFile(join(import.meta.dir, "../fixtures/projects/claude-ai-title.jsonl"), "utf8")).trim().replaceAll("redacted-session-id", "claude-ai-title");
    const userMessage = JSON.stringify({ type: "user", message: { content: "  Primeiro pedido   com espaços " } });
    writeFileSync(join(sessions, "900001.json"), JSON.stringify({ pid: 900001, sessionId: "claude-ai-title", cwd: path, startedAt, name: "auto-c3", nameSource: "derived", status: "idle", updatedAt: startedAt }));
    writeFileSync(join(project, "claude-ai-title.jsonl"), `${aiTitle}\n${userMessage}\n`);
    writeFileSync(join(sessions, "900002.json"), JSON.stringify({ pid: 900002, sessionId: "claude-user-title", cwd: path, startedAt, name: "auto-e7", nameSource: "derived", status: "idle", updatedAt: startedAt }));
    writeFileSync(join(project, "claude-user-title.jsonl"), `${userMessage}\n`);
    await cli("repo", "add", path);
    const result = json<Array<{ worktrees: Array<{ sessions: Array<{ sessionId: string; title: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    const titles = new Map(result?.worktrees[0]?.sessions.map(({ sessionId, title }) => [sessionId, title]));
    expect(titles.get("claude:claude-ai-title")).toBe("Atualize o registro do projeto");
    expect(titles.get("claude:claude-user-title")).toBe("Primeiro pedido com espaços");
  });

  test("Codex titles use the latest session index name and never the generic session label", async () => {
    const path = await repository("codex-titles");
    const directory = join(home, ".codex", "sessions", "2026", "10", "15");
    mkdirSync(directory, { recursive: true });
    const startedAt = new Date().toISOString();
    const rollout = join(directory, "rollout-title-session.jsonl");
    writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "codex-title-session", cwd: path, timestamp: startedAt } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Pedido inicial do Codex" }] } })}\n`);
    const fixture = await import("node:fs/promises");
    const index = (await fixture.readFile(join(import.meta.dir, "../fixtures/projects/codex-session-index.jsonl"), "utf8")).trim();
    writeFileSync(join(home, ".codex", "session_index.jsonl"), `${index.replaceAll("redacted-session-id", "codex-title-session")}\n${JSON.stringify({ id: "codex-title-session", thread_name: "Nome final do Codex", updated_at: startedAt })}\n`);
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project?.worktrees[0]?.sessions[0]?.title).toBe("Nome final do Codex");
  });

  test("Codex sessions reach back seven days while Claude keeps twenty-four hours", async () => {
    const path = await repository("codex-window");
    const directory = join(home, ".codex", "sessions", "2026", "10", "10");
    mkdirSync(directory, { recursive: true });
    const hours = 60 * 60 * 1000;
    for (const [id, age] of [["codex-3d", 72], ["codex-6d", 144], ["codex-8d", 192]] as const) {
      const rollout = join(directory, `rollout-${id}.jsonl`);
      writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: path, timestamp: new Date(Date.now() - age * hours).toISOString() } })}\n`);
      const modified = new Date(Date.now() - age * hours);
      utimesSync(rollout, modified, modified);
    }
    const claude = join(home, ".claude", "sessions");
    mkdirSync(claude, { recursive: true });
    const stamp = new Date(Date.now() - 72 * hours).toISOString();
    writeFileSync(join(claude, "999998.json"), JSON.stringify({ pid: 999998, sessionId: "claude-3d", cwd: path, startedAt: stamp, name: "Claude three days", status: "idle", updatedAt: stamp }));
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ sessionId: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    const ids = (project?.worktrees[0]?.sessions ?? []).map((session) => session.sessionId).sort();
    expect(ids).toEqual(["codex:codex-3d", "codex:codex-6d"]);
  });

  test("session titles fall back to the agent name when no session title or user message exists", async () => {
    const path = await repository("title-fallback");
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(join(sessions, "900003.json"), JSON.stringify({ pid: 900003, sessionId: "untitled", cwd: path, startedAt, name: "slug-a1", nameSource: "derived", status: "idle", updatedAt: startedAt }));
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await cli("projects", "--json", "--include-foreign"))[0];
    expect(project?.worktrees[0]?.sessions[0]?.title).toBe("Claude");
  });

  test("project pull requests stay fresh for 60 seconds and keep the last good result after refresh failure", async () => {
    const path = await repository("pull-request-cache");
    await cli("repo", "add", path);
    const initialCache = guardedOpenDatabase(env);
    if (initialCache.kind !== "ok") throw new Error(initialCache.error);
    try { initialCache.value.db.run("INSERT INTO repository_pull_requests (repository_path, value_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(repository_path) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at", [path, JSON.stringify([{ headRefName: "main", number: 42, state: "OPEN", url: "https://example.test/42" }]), Date.now() - 60_001]); }
    finally { initialCache.value.close(); }
    const process = createProcessAdapter();
    let ghCalls = 0;
    let failGh = false;
    const scheduled: string[][] = [];
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          ghCalls += 1;
          if (failGh) return { kind: "failed", error: "GitHub unavailable" };
          return ok({ stdout: JSON.stringify([{ headRefName: "main", number: 42, state: "OPEN", url: "https://example.test/42" }]), stderr: "", exitCode: 0 });
        }
        return process.run(command, args, options);
      },
      startDetached: async (command, args) => { scheduled.push([command, ...args]); return ok({ pid: 987653 }); },
      invocationCount: process.invocationCount,
    };
    const list = async () => route(["projects", "--json"], { environment: env, processAdapter: adapter });
    const first = json<Array<{ worktrees: Array<{ pullRequest: { number: number } | null }> }>>(await list())[0];
    expect(first?.worktrees[0]?.pullRequest?.number).toBe(42);
    expect(ghCalls).toBe(0);
    expect(scheduled).toHaveLength(1);
    const refresh = await route(["projects", "--refresh-pull-requests", path], { environment: env, processAdapter: adapter });
    expect(refresh.kind).toBe("ok");
    expect(ghCalls).toBe(1);
    const second = json<Array<{ worktrees: Array<{ pullRequest: { number: number } | null }> }>>(await list())[0];
    expect(second?.worktrees[0]?.pullRequest?.number).toBe(42);
    expect(ghCalls).toBe(1);

    const opened = guardedOpenDatabase(env);
    if (opened.kind !== "ok") throw new Error(opened.error);
    try { opened.value.db.run("UPDATE repository_pull_requests SET fetched_at = ? WHERE repository_path = ?", [Date.now() - 60_001, path]); }
    finally { opened.value.close(); }
    failGh = true;
    const stale = json<Array<{ worktrees: Array<{ pullRequest: { number: number } | null }> }>>(await list())[0];
    expect(stale?.worktrees[0]?.pullRequest?.number).toBe(42);
    expect(scheduled).toHaveLength(2);
    expect(ghCalls).toBe(1);
    const failedRefresh = await route(["projects", "--refresh-pull-requests", path], { environment: env, processAdapter: adapter });
    expect(failedRefresh.kind).toBe("ok");
    expect(ghCalls).toBe(2);
    expect(json<Array<{ worktrees: Array<{ pullRequest: { number: number } | null }> }>>(await list())[0]?.worktrees[0]?.pullRequest?.number).toBe(42);
    expect(scheduled).toHaveLength(2);
  });

  test("stale pull request cache is returned without waiting for gh", async () => {
    const path = await repository("pull-request-stale-cache");
    await cli("repo", "add", path);
    const opened = guardedOpenDatabase(env);
    if (opened.kind !== "ok") throw new Error(opened.error);
    try { opened.value.db.run("INSERT INTO repository_pull_requests (repository_path, value_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(repository_path) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at", [path, JSON.stringify([{ headRefName: "main", number: 73, state: "OPEN", url: "https://example.test/73", title: "Cached", isDraft: false }]), Date.now() - 60_001]); }
    finally { opened.value.close(); }
    const process = createProcessAdapter();
    const calls: string[] = [];
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        calls.push(`${command} ${args.join(" ")}`);
        if (command === "gh") throw new Error("gh must not run in the projects process");
        return process.run(command, args, options);
      },
      startDetached: async (command, args) => { calls.push(`detached ${command} ${args.join(" ")}`); return ok({ pid: 987654 }); },
      invocationCount: process.invocationCount,
    };
    const project = json<Array<{ worktrees: Array<{ pullRequest: Record<string, unknown> | null }> }>>(await route(["projects", "--json"], { environment: env, processAdapter: adapter }))[0];
    expect(project?.worktrees[0]?.pullRequest).toEqual({ number: 73, state: "OPEN", url: "https://example.test/73", title: "Cached", isDraft: false });
    expect(calls.some((call) => call.startsWith("gh "))).toBe(false);
    expect(calls.some((call) => call.startsWith("detached "))).toBe(true);
  });

  test("projects reuses unchanged worktree and session data and invalidates changed inputs", async () => {
    const path = await repository("derived-cache");
    await cli("repo", "add", path);
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    const startedAt = new Date().toISOString();
    const sessionFile = join(sessions, "900004.json");
    writeFileSync(sessionFile, JSON.stringify({ pid: 900004, sessionId: "cached-session", cwd: path, startedAt, name: "Initial", nameSource: "user", status: "idle", updatedAt: startedAt }));
    const callCounts = new Map<string, number>();
    const real = createProcessAdapter();
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command === "git" && args.includes("worktree")) callCounts.set("worktree", (callCounts.get("worktree") ?? 0) + 1);
        return real.run(command, args, options);
      },
      startDetached: real.startDetached,
      invocationCount: real.invocationCount,
    };
    const first = (await route(["projects", "--json", "--include-foreign"], { environment: env, processAdapter: adapter }));
    const second = (await route(["projects", "--json", "--include-foreign"], { environment: env, processAdapter: adapter }));
    expect(second).toEqual(first);
    expect(callCounts.get("worktree")).toBe(2);
    writeFileSync(sessionFile, JSON.stringify({ pid: 900004, sessionId: "cached-session", cwd: path, startedAt, name: "Changed", nameSource: "user", status: "idle", updatedAt: startedAt }));
    const third = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await route(["projects", "--json", "--include-foreign"], { environment: env, processAdapter: adapter }))[0];
    expect(third?.worktrees[0]?.sessions[0]?.title).toBe("Changed");
    expect(callCounts.get("worktree")).toBe(3);
  });

  test("project pull requests carry the title and draft flag gh reports", async () => {
    const path = await repository("pull-request-title");
    await cli("repo", "add", path);
    const process = createProcessAdapter();
    const asked: string[][] = [];
    const scheduled: string[][] = [];
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          asked.push([...args]);
          return ok({ stdout: JSON.stringify([{ headRefName: "main", number: 7, state: "OPEN", url: "https://example.test/7", title: "Add the pull request page", isDraft: true }]), stderr: "", exitCode: 0 });
        }
        return process.run(command, args, options);
      },
      startDetached: async (command, args) => { scheduled.push([command, ...args]); return ok({ pid: 987655 }); },
      invocationCount: process.invocationCount,
    };
    const initial = json<Array<{ worktrees: Array<{ pullRequest: Record<string, unknown> | null }> }>>(await route(["projects", "--json"], { environment: env, processAdapter: adapter }))[0];
    expect(initial?.worktrees[0]?.pullRequest).toBeNull();
    expect(asked).toHaveLength(0);
    expect(scheduled).toHaveLength(1);
    await route(["projects", "--refresh-pull-requests", path], { environment: env, processAdapter: adapter });
    const project = json<Array<{ worktrees: Array<{ pullRequest: Record<string, unknown> | null }> }>>(await route(["projects", "--json"], { environment: env, processAdapter: adapter }))[0];
    expect(asked[0]?.at(-1)).toBe("headRefName,number,state,url,title,isDraft");
    expect(project?.worktrees[0]?.pullRequest).toEqual({ number: 7, state: "OPEN", url: "https://example.test/7", title: "Add the pull request page", isDraft: true });
  });

  test("a pull request cached before titles were read still lists, with title and draft unknown", async () => {
    const path = await repository("pull-request-old-cache");
    await cli("repo", "add", path);
    const opened = guardedOpenDatabase(env);
    if (opened.kind !== "ok") throw new Error(opened.error);
    try { opened.value.db.run("INSERT INTO repository_pull_requests (repository_path, value_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(repository_path) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at", [path, JSON.stringify([{ headRefName: "main", number: 42, state: "MERGED", url: "https://example.test/42" }]), Date.now()]); }
    finally { opened.value.close(); }
    const process = createProcessAdapter();
    let ghCalls = 0;
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command === "gh") ghCalls += 1;
        return process.run(command, args, options);
      },
      startDetached: process.startDetached,
      invocationCount: process.invocationCount,
    };
    const project = json<Array<{ worktrees: Array<{ pullRequest: Record<string, unknown> | null }> }>>(await route(["projects", "--json"], { environment: env, processAdapter: adapter }))[0];
    expect(ghCalls).toBe(0);
    expect(project?.worktrees[0]?.pullRequest).toEqual({ number: 42, state: "MERGED", url: "https://example.test/42", title: null, isDraft: null });
  });

  test("project pull request failures without a good value are cached for 60 seconds", async () => {
    const path = await repository("pull-request-failure-cache");
    await cli("repo", "add", path);
    const process = createProcessAdapter();
    let ghCalls = 0;
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          ghCalls += 1;
          return { kind: "failed", error: "GitHub unavailable" };
        }
        return process.run(command, args, options);
      },
      startDetached: process.startDetached,
      invocationCount: process.invocationCount,
    };
    const scheduled: string[][] = [];
    adapter.startDetached = async (command, args) => { scheduled.push([command, ...args]); return ok({ pid: 987656 }); };
    const list = async () => route(["projects", "--json"], { environment: env, processAdapter: adapter });
    const first = json<Array<{ worktrees: Array<{ pullRequest: null }> }>>(await list())[0];
    expect(first?.worktrees[0]?.pullRequest).toBeNull();
    expect(ghCalls).toBe(0);
    await route(["projects", "--refresh-pull-requests", path], { environment: env, processAdapter: adapter });
    const second = json<Array<{ worktrees: Array<{ pullRequest: null }> }>>(await list())[0];
    expect(second?.worktrees[0]?.pullRequest).toBeNull();
    expect(ghCalls).toBe(1);
    expect(scheduled).toHaveLength(1);
  });
});
