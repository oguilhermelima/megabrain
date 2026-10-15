import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    const projects = json<Array<{ path: string }>>(await cli("projects", "--json"));
    expect(projects.map((project) => project.path)).toContain(path);
    expect(json<Array<{ path: string }>>(await cli("projects", "--json"))).toHaveLength(projects.length);
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
    const project = json<Array<{ worktrees: Array<{ path: string; branch: string | null; primary: boolean }> }>>(await cli("projects", "--json"))[0];
    expect(project?.worktrees.map(({ path }) => path)).toEqual([main, aTree, zTree, detached]);
    expect(project?.worktrees[0]?.primary).toBe(true);
    expect(project?.worktrees.find((tree) => tree.path === detached)?.branch).toBeNull();
  });

  test("missing registered folders are marked missing and have no worktrees", async () => {
    const path = await repository("vanished");
    await cli("repo", "add", path);
    rmSync(path, { recursive: true, force: true });
    const project = json<Array<{ missing: boolean; worktrees: unknown[] }>>(await cli("projects", "--json"))[0];
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
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ agent: string; status: string; title: string; sessionId: string }> }> }>>(await cli("projects", "--json"))[0];
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
      opened.value.db.run("INSERT INTO dispatches (id,state,agent,worktree_path,chat_name,created_at,updated_at,extra) VALUES (?,?,?,?,?,?,?,?)", ["dispatch-1", "running", "claude", path, "Agent session", startedAt, startedAt, "{\"$present\":[\"dispatchId\",\"state\",\"agent\",\"worktreePath\",\"createdAt\"]}"]);
    } finally { opened.value.close(); }
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ dispatchId: string | null }> }> }>>(await cli("projects", "--json"))[0];
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
      opened.value.db.run("INSERT INTO dispatches (id,state,agent,worktree_path,chat_name,created_at,updated_at,extra) VALUES (?,?,?,?,?,?,?,?)", [
        "dispatch-title", "running", "claude", path, "Título do despacho", startedAt, startedAt,
        JSON.stringify({ label: "Título do despacho", "$present": ["dispatchId", "state", "agent", "worktreePath", "createdAt"] }),
      ]);
    } finally { opened.value.close(); }
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await cli("projects", "--json"))[0];
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
    const result = json<Array<{ worktrees: Array<{ sessions: Array<{ sessionId: string; title: string }> }> }>>(await cli("projects", "--json"))[0];
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
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await cli("projects", "--json"))[0];
    expect(project?.worktrees[0]?.sessions[0]?.title).toBe("Nome final do Codex");
  });

  test("session titles fall back to the agent name when no session title or user message exists", async () => {
    const path = await repository("title-fallback");
    const sessions = join(home, ".claude", "sessions");
    mkdirSync(sessions, { recursive: true });
    const startedAt = new Date().toISOString();
    writeFileSync(join(sessions, "900003.json"), JSON.stringify({ pid: 900003, sessionId: "untitled", cwd: path, startedAt, name: "slug-a1", nameSource: "derived", status: "idle", updatedAt: startedAt }));
    await cli("repo", "add", path);
    const project = json<Array<{ worktrees: Array<{ sessions: Array<{ title: string }> }> }>>(await cli("projects", "--json"))[0];
    expect(project?.worktrees[0]?.sessions[0]?.title).toBe("Claude");
  });

  test("project pull requests stay fresh for 60 seconds and keep the last good result after refresh failure", async () => {
    const path = await repository("pull-request-cache");
    await cli("repo", "add", path);
    const process = createProcessAdapter();
    let ghCalls = 0;
    let failGh = false;
    const adapter: ProcessAdapter = {
      run: async (command, args, options) => {
        if (command === "gh" && args[0] === "pr" && args[1] === "list") {
          ghCalls += 1;
          if (failGh) return { kind: "failed", error: "GitHub unavailable" };
          return ok({ stdout: JSON.stringify([{ headRefName: "main", number: 42, state: "OPEN", url: "https://example.test/42" }]), stderr: "", exitCode: 0 });
        }
        return process.run(command, args, options);
      },
      startDetached: process.startDetached,
      invocationCount: process.invocationCount,
    };
    const list = async () => route(["projects", "--json"], { environment: env, processAdapter: adapter });
    const first = json<Array<{ worktrees: Array<{ pullRequest: { number: number } | null }> }>>(await list())[0];
    expect(first?.worktrees[0]?.pullRequest?.number).toBe(42);
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
    expect(ghCalls).toBe(2);
  });
});
