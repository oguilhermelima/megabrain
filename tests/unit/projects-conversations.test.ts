import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { openDatabase } from "../../src/db/db.js";
import { insertDispatch } from "../../src/db/queries/dispatches.js";
import { chatKey, readConversations, terminalKey, upsertConversation } from "../../src/core/conversations.js";
import { ok } from "../../src/core/result.js";

let root = "";
let home = "";
let state = "";
let project = "";
let env: NodeJS.ProcessEnv;
let children: ChildProcess[] = [];

type Row = { sessionId: string; agent: string; title: string; status: string; lastActivityAt: string | null; dispatchId: string | null; conversationOwner: string; owner: string; origin: string; host: string; parent: string | null; chatId?: string | null };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-projects-conv-")));
  home = join(root, "home");
  state = join(root, "state");
  project = join(root, "repo");
  mkdirSync(home);
  mkdirSync(project);
  mkdirSync(state);
  env = { HOME: home, MEGABRAIN_STATE_DIR: state };
});

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children = [];
  rmSync(root, { recursive: true, force: true });
});

function livePid(): number {
  const child = spawn("sleep", ["300"], { stdio: "ignore" });
  children.push(child);
  if (child.pid === undefined) throw new Error("sleep did not start");
  return child.pid;
}

type Fakes = { ps?: readonly string[]; panes?: readonly string[]; lsof?: Readonly<Record<string, string>> };
// Fakes ps, the app's tmux server and lsof; git and everything else reach the real adapter.
function machine(fakes: Fakes = {}): ProcessAdapter {
  const real = createProcessAdapter();
  const answer = (stdout: string) => Promise.resolve(ok({ stdout, stderr: "", exitCode: 0 }));
  return {
    ...real,
    run: (command, args, options) => {
      if (command === "ps") return answer(`${(fakes.ps ?? ["1 0 /sbin/launchd"]).join("\n")}\n`);
      if (command === "tmux") return answer(args.includes("list-panes") ? `${(fakes.panes ?? []).join("\n")}\n` : "");
      if (command === "lsof") {
        const key = args.join(" ");
        const hit = Object.entries(fakes.lsof ?? {}).find(([pattern]) => key.includes(pattern));
        return answer(hit?.[1] ?? "");
      }
      return real.run(command, args, options);
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await createProcessAdapter().run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
}

async function repository(): Promise<void> {
  await git(project, "init", "-b", "main");
  await git(project, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--allow-empty", "-m", "initial");
  await route(["repo", "add", project], { environment: env, processAdapter: createProcessAdapter() });
}

function claudeRegistry(pid: number, id: string, status = "idle"): void {
  const directory = join(home, ".claude", "sessions");
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(directory, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: project, startedAt: now, updatedAt: now, status }));
}

function codexRollout(id: string, minutesAgo: number): string {
  const directory = join(home, ".codex", "sessions", "2026", "10", "16");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-16T10-00-00-${id}.jsonl`);
  const line = JSON.stringify({ type: "session_meta", timestamp: "2026-10-16T10:00:00.000Z", payload: { id, cwd: project, timestamp: "2026-10-16T10:00:00.000Z" } });
  writeFileSync(path, `${line}\n`);
  const at = new Date(Date.now() - minutesAgo * 60_000);
  require("node:fs").utimesSync(path, at, at);
  return path;
}

function ours(key: string, owner: "app-chat" | "app-terminal", aliases: Partial<{ chatId: string; tmux: string }> = {}, hidden = false): void {
  upsertConversation(state, key, { owner, cwd: project, aliases: { chatId: aliases.chatId ?? null, tmux: aliases.tmux ?? null, pid: null, dispatchId: null }, createdAt: new Date(Date.now() - 3_600_000).toISOString(), hidden });
}

function chatRecord(id: string, sessionId: string | null, overrides: Record<string, unknown> = {}): void {
  const directory = join(state, "chats", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "chat.json"), JSON.stringify({ id, agent: "claude", model: "claude-opus", cwd: project, title: "Fix the registry", state: "suspended", mode: "chat", agentSessionId: sessionId, createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: "2026-10-16T09:30:00.000Z", ...overrides }));
}

function dispatch(id: string, fields: Record<string, unknown>): void {
  const opened = openDatabase(env);
  if (opened.kind !== "ok") throw new Error(opened.error);
  try { insertDispatch(opened.value.db, { dispatchId: id, state: "running", agent: "codex", worktreePath: project, createdAt: new Date().toISOString(), ...fields }); }
  finally { opened.value.close(); }
}

async function listed(adapter: ProcessAdapter, ...extra: string[]): Promise<Row[]> {
  const result = await route(["projects", "--json", ...extra], { environment: env, processAdapter: adapter });
  if (result.kind !== "ok") throw new Error(result.error);
  const parsed = JSON.parse(result.value) as Array<{ worktrees: Array<{ sessions: Row[] }> }>;
  return parsed.flatMap((entry) => entry.worktrees.flatMap((tree) => tree.sessions));
}
const ids = (rows: readonly Row[]): string[] => rows.map((row) => row.sessionId).sort();

describe("projects lists conversations from the registry", () => {
  test("a conversation of ours is listed with no process running, taking its facts from the chat", async () => {
    await repository();
    chatRecord("11111111-1111-4111-8111-111111111111", "ended-chat-session");
    ours("claude:ended-chat-session", "app-chat", { chatId: "11111111-1111-4111-8111-111111111111" });
    const [row, ...rest] = await listed(machine());
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ sessionId: "claude:ended-chat-session", status: "ended", title: "Fix the registry", conversationOwner: "app-chat", owner: "megabrain", origin: "megabrain", chatId: "11111111-1111-4111-8111-111111111111", lastActivityAt: "2026-10-16T09:30:00.000Z" });
  });

  test("an ended conversation of ours stays listed however old, with its last activity", async () => {
    await repository();
    chatRecord("22222222-2222-4222-8222-222222222222", "old-session", { lastActivityAt: "2026-01-01T00:00:00.000Z" });
    ours("claude:old-session", "app-chat", { chatId: "22222222-2222-4222-8222-222222222222" });
    expect(await listed(machine())).toMatchObject([{ sessionId: "claude:old-session", status: "ended", lastActivityAt: "2026-01-01T00:00:00.000Z" }]);
  });

  test("a hidden conversation is not listed", async () => {
    await repository();
    ours("claude:hidden-one", "app-terminal", {}, true);
    expect(await listed(machine())).toEqual([]);
  });

  test("a chat, its TUI and its log all reporting the same session are one row", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "shared-session", "working");
    chatRecord("33333333-3333-4333-8333-333333333333", "shared-session", { state: "working" });
    ours("claude:shared-session", "app-chat", { chatId: "33333333-3333-4333-8333-333333333333" });
    const rows = await listed(machine({ ps: ["1 0 /sbin/launchd", `${pid} 1 claude`] }), "--include-foreign");
    expect(rows.filter((row) => row.sessionId === "claude:shared-session")).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "working", conversationOwner: "app-chat" });
  });

  test("a provisional terminal conversation is promoted when a session runs inside its tmux pane", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "tui-session");
    ours(terminalKey("t1"), "app-terminal", { tmux: "megabrain-app:mb-app-t1" });
    const adapter = machine({ ps: ["1 0 /sbin/launchd", "200 1 tmux -L megabrain-app new-session -d -s mb-app-t1", `${pid} 200 claude`], panes: [`${pid} mb-app-t1`] });
    expect(await listed(adapter)).toMatchObject([{ sessionId: "claude:tui-session", conversationOwner: "app-terminal" }]);
    const conversations = readConversations(state).conversations;
    expect(conversations[terminalKey("t1")]).toBeUndefined();
    expect(conversations["claude:tui-session"]?.aliases.tmux).toBe("megabrain-app:mb-app-t1");
  });
});

describe("what is not ours stays out of the app's list", () => {
  test("a dispatch session on Orca is megabrain-originated and reports its recorded host and parent", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "orca-dispatch");
    dispatch("dispatch-orca", { agent: "claude", agentPid: pid, agentThreadId: "orca-dispatch", childHost: "orca", parentSessionId: "coordinator-session" });
    const adapter = machine({ ps: ["1 0 /sbin/launchd", "300 1 /Applications/Orca.app/Contents/MacOS/Orca", `${pid} 300 claude`] });
    expect(await listed(adapter, "--origin", "megabrain")).toMatchObject([{ sessionId: "claude:orca-dispatch", dispatchId: "dispatch-orca", origin: "megabrain", host: "orca", parent: "coordinator-session" }]);
  });

  test("a hand-opened Orca session is only in all, with its inferred host and no parent", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "orca-child");
    const adapter = machine({ ps: ["1 0 /sbin/launchd", "300 1 /Applications/Orca.app/Contents/MacOS/Orca", `${pid} 300 claude`] });
    expect(await listed(adapter, "--origin", "megabrain")).toEqual([]);
    expect(await listed(adapter)).toMatchObject([{ sessionId: "claude:orca-child", conversationOwner: "foreign", owner: "external", origin: "external", host: "orca", parent: null }]);
  });

  test("a worker running under an app terminal is the dispatch's, not the terminal's", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "worker-session");
    dispatch("dispatch-1", { agent: "claude", agentPid: pid, agentThreadId: "worker-session", chatName: "lane A" });
    const adapter = machine({ ps: ["1 0 /sbin/launchd", "200 1 tmux -L megabrain-app new-session -d -s mb-app-t1", `${pid} 200 claude`], panes: [`${pid} mb-app-t1`] });
    ours(terminalKey("t1"), "app-terminal", { tmux: "megabrain-app:mb-app-t1" });
    expect(await listed(adapter, "--origin", "megabrain")).toEqual([]);
    expect(await listed(adapter, "--include-foreign")).toMatchObject([{ sessionId: "claude:worker-session", conversationOwner: "dispatch", dispatchId: "dispatch-1" }]);
    expect(readConversations(state).conversations[terminalKey("t1")]).toBeDefined();
  });

  test("a worker is matched by its pid tree when its dispatch recorded no session id", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "unrecorded-worker");
    dispatch("dispatch-2", { agent: "claude", agentPid: 4242 });
    const adapter = machine({ ps: ["1 0 /sbin/launchd", "4242 1 claude", `${pid} 4242 node helper`] });
    expect(await listed(adapter, "--include-foreign")).toMatchObject([{ sessionId: "claude:unrecorded-worker", conversationOwner: "dispatch", dispatchId: "dispatch-2" }]);
  });

  test("a session started within ten minutes of an unrelated dispatch carries no dispatch id", async () => {
    await repository();
    const pid = livePid();
    claudeRegistry(pid, "plain-session");
    dispatch("dispatch-3", { agent: "claude", agentThreadId: "some-other-session" });
    const rows = await listed(machine({ ps: ["1 0 /sbin/launchd", `${pid} 1 claude`] }), "--include-foreign");
    expect(rows).toMatchObject([{ sessionId: "claude:plain-session", conversationOwner: "foreign", dispatchId: null }]);
  });

  test("two Codex rollouts in one folder with one live process make one live row", async () => {
    await repository();
    const live = codexRollout("11111111-aaaa-4aaa-8aaa-111111111111", 1);
    codexRollout("22222222-bbbb-4bbb-8bbb-222222222222", 120);
    const pid = livePid();
    const adapter = machine({ ps: ["1 0 /sbin/launchd", `${pid} 1 codex`], lsof: { [String(pid)]: `p${pid}\nn${project}\nn${live}\n` } });
    const rows = await listed(adapter, "--include-foreign");
    expect(Object.fromEntries(rows.map((row) => [row.sessionId, row.status]))).toEqual({
      "codex:11111111-aaaa-4aaa-8aaa-111111111111": "working",
      "codex:22222222-bbbb-4bbb-8bbb-222222222222": "ended",
    });
  });

  test("a live agy conversation, found by its presence lock, is listed as foreign", async () => {
    await repository();
    const conversation = "5a5a5a5a-1111-4111-8111-555555555555";
    mkdirSync(join(home, ".gemini", "antigravity-cli", "presence"), { recursive: true });
    writeFileSync(join(home, ".gemini", "antigravity-cli", "presence", `${conversation}.lock`), "");
    writeFileSync(join(home, ".gemini", "antigravity-cli", "history.jsonl"), `${JSON.stringify({ conversationId: conversation, workspace: project, timestamp: new Date().toISOString(), display: "Write the brief", type: "prompt" })}\n`);
    const adapter = machine({ lsof: { [`${conversation}.lock`]: `p4343\nn${join(home, ".gemini", "antigravity-cli", "presence", `${conversation}.lock`)}\n` } });
    expect(await listed(adapter, "--include-foreign")).toMatchObject([{ sessionId: `agy:${conversation}`, agent: "agy", status: "working", title: "Write the brief", conversationOwner: "foreign" }]);
    expect(await listed(adapter, "--origin", "megabrain")).toEqual([]);
  });
});
