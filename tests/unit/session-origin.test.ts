import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { ok } from "../../src/core/result.js";

let root = "";
let home = "";
let state = "";
let project = "";
let env: NodeJS.ProcessEnv;
let children: ChildProcess[] = [];

type Listed = { sessionId: string; origin: string };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-session-origin-")));
  home = join(root, "home");
  state = join(root, "state");
  project = join(root, "repo");
  mkdirSync(home);
  mkdirSync(project);
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

// A fake `ps -axo pid=,ppid=,command=` table: every other command goes to the real adapter.
function withTable(lines: readonly string[]): ProcessAdapter {
  const real = createProcessAdapter();
  return { ...real, run: (command, args, options) => command === "ps" ? Promise.resolve(ok({ stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 })) : real.run(command, args, options) };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await createProcessAdapter().run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
}

function registry(pid: number, id: string): void {
  const directory = join(home, ".claude", "sessions");
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(directory, `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd: project, startedAt: now, updatedAt: now, status: "idle" }));
}

async function listed(table: ProcessAdapter, ...extra: string[]): Promise<Listed[]> {
  const result = await route(["projects", "--json", ...extra], { environment: env, processAdapter: table });
  if (result.kind !== "ok") throw new Error(result.error);
  const parsed = JSON.parse(result.value) as Array<{ worktrees: Array<{ sessions: Listed[] }> }>;
  return parsed.flatMap((entry) => entry.worktrees.flatMap((tree) => tree.sessions));
}

async function scenario(): Promise<ProcessAdapter> {
  await git(project, "init", "-b", "main");
  await git(project, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--allow-empty", "-m", "initial");
  await route(["repo", "add", project], { environment: env, processAdapter: createProcessAdapter() });
  const app = livePid(); const tmux = livePid(); const orca = livePid(); const plain = livePid();
  registry(app, "app-terminal"); registry(tmux, "app-tmux"); registry(orca, "orca-child"); registry(plain, "plain-terminal");
  // Dead pids: the origin of an ended session comes only from a record.
  registry(2_000_001, "owned-record"); registry(2_000_002, "native-chat"); registry(2_000_003, "ended-plain");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "owned-sessions.json"), JSON.stringify({ "claude:owned-record": { tmuxServer: "megabrain-app", tmuxSession: "mb-claude-owned-re", command: "claude", cwd: project, ownedAt: new Date().toISOString() } }));
  const chat = join(state, "chats", "11111111-1111-4111-8111-111111111111");
  mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, "chat.json"), JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", agent: "claude", model: null, cwd: project, title: null, state: "idle", mode: "chat", agentSessionId: "native-chat", createdAt: new Date().toISOString(), lastActivityAt: null }));
  return withTable([
    "1 0 /sbin/launchd",
    "100 1 /Applications/megabrain.app/Contents/MacOS/megabrain-desktop",
    "101 100 -zsh",
    `${app} 101 claude`,
    "200 1 tmux -L megabrain-app new-session -d -s mb-claude-app-tmux",
    "201 200 -zsh",
    `${tmux} 201 claude`,
    "300 1 /Applications/Orca.app/Contents/MacOS/Orca",
    "301 300 -zsh",
    `${orca} 301 claude`,
    "400 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "401 400 -zsh",
    `${plain} 401 claude`,
  ]);
}

describe("session origin", () => {
  test("each session reports where it was opened", async () => {
    const origins = new Map((await listed(await scenario())).map((session) => [session.sessionId, session.origin]));
    expect(Object.fromEntries(origins)).toEqual({
      "claude:app-terminal": "megabrain",
      "claude:app-tmux": "megabrain",
      "claude:orca-child": "external",
      "claude:plain-terminal": "external",
      "claude:owned-record": "megabrain",
      "claude:native-chat": "megabrain",
      "claude:ended-plain": "external",
    });
  });

  test("--origin megabrain lists only sessions megabrain started", async () => {
    const table = await scenario();
    expect((await listed(table, "--origin", "megabrain")).map((session) => session.sessionId).sort())
      .toEqual(["claude:app-terminal", "claude:app-tmux", "claude:native-chat", "claude:owned-record"]);
    expect(await listed(table, "--origin", "all")).toHaveLength(7);
    expect(await listed(table)).toHaveLength(7);
  });

  test("--origin rejects an unknown value", async () => {
    const result = await route(["projects", "--json", "--origin", "orca"], { environment: env, processAdapter: createProcessAdapter() });
    expect(result.kind).toBe("failed");
    expect(result.kind === "failed" ? result.error : "").toContain("--origin");
  });
});
