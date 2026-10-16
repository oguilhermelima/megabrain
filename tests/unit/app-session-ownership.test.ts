import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { route } from "../../src/cli/router.js";
import { createProcessAdapter, type ProcessAdapter } from "../../src/adapters/proc.js";
import { ok } from "../../src/core/result.js";

// A Claude TUI the desktop app launched in one of its own terminals: its registry entry and the
// `ps` rows around it were captured from a real machine (home redacted to /Users/operator).
const fixtures = join(import.meta.dir, "..", "fixtures", "projects");
const capturedEntry = JSON.parse(readFileSync(join(fixtures, "app-terminal-claude-session.json"), "utf8")) as Record<string, unknown>;
const capturedTable = readFileSync(join(fixtures, "app-terminal-ps.txt"), "utf8").split("\n").filter((line) => line.trim() !== "");
const CAPTURED_PID = 54192;
const CAPTURED_ID = "6e69d457-6446-4efa-b65f-01d6987cc048";

let root = "";
let home = "";
let state = "";
let project = "";
let env: NodeJS.ProcessEnv;
let children: ChildProcess[] = [];

type Listed = { sessionId: string; origin?: string; conversationOwner?: string; owner?: string; terminalPid?: number | null; tmuxServer?: string | null; tmuxSession?: string | null };
type Call = { command: string; args: readonly string[] };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "megabrain-app-session-")));
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

// Fakes `ps`, the app's tmux server and `kill`; git and everything else reach the real adapter.
function fakeMachine(table: readonly string[], panes: readonly string[], calls: Call[]): ProcessAdapter {
  const real = createProcessAdapter();
  const answer = (stdout: string) => Promise.resolve(ok({ stdout, stderr: "", exitCode: 0 }));
  return {
    ...real,
    run: (command, args, options) => {
      if (command === "ps") return answer(`${table.join("\n")}\n`);
      if (command === "tmux" || command === "kill") {
        calls.push({ command, args });
        return answer(command === "tmux" && args.includes("list-panes") ? `${panes.join("\n")}\n` : "");
      }
      return real.run(command, args, options);
    },
  };
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await createProcessAdapter().run("git", args, { cwd });
  if (result.kind !== "ok") throw new Error(result.error);
}

function registry(pid: number, entry: Record<string, unknown>): void {
  const directory = join(home, ".claude", "sessions");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${pid}.json`), JSON.stringify({ ...entry, pid, cwd: project }));
}

async function listed(machine: ProcessAdapter): Promise<Map<string, Listed>> {
  const result = await route(["projects", "--json", "--include-foreign"], { environment: env, processAdapter: machine });
  if (result.kind !== "ok") throw new Error(result.error);
  const parsed = JSON.parse(result.value) as Array<{ worktrees: Array<{ sessions: Listed[] }> }>;
  return new Map(parsed.flatMap((entry) => entry.worktrees.flatMap((tree) => tree.sessions)).map((session) => [session.sessionId, session]));
}

type Scenario = { machine: ProcessAdapter; calls: Call[]; native: number; tmux: number; plain: number };

async function scenario(): Promise<Scenario> {
  await git(project, "init", "-b", "main");
  await git(project, "-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "--allow-empty", "-m", "initial");
  await route(["repo", "add", project], { environment: env, processAdapter: createProcessAdapter() });
  const native = livePid(); const tmux = livePid(); const plain = livePid();
  const now = Date.now();
  // The captured entry, alive under a stand-in pid; its own timestamps are kept.
  registry(native, { ...capturedEntry, updatedAt: now, statusUpdatedAt: now });
  registry(tmux, { sessionId: "app-tmux", startedAt: now, updatedAt: now, status: "idle" });
  registry(plain, { sessionId: "plain-terminal", startedAt: now, updatedAt: now, status: "idle" });
  const table = [
    ...capturedTable.map((line) => line.replace(new RegExp(`^(\\s*)${CAPTURED_PID}(\\s)`), `$1${native}$2`)),
    "200 1 tmux -L megabrain-app new-session -d -s mb-app-term-7",
    `${tmux} 200 claude`,
    "400 1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "401 400 -zsh",
    `${plain} 401 claude`,
  ];
  const calls: Call[] = [];
  return { machine: fakeMachine(table, [`${tmux} mb-app-term-7`], calls), calls, native, tmux, plain };
}

describe("sessions the desktop app launched", () => {
  test("a Claude TUI in a native app terminal that nobody registered is not the app's conversation", async () => {
    const { machine } = await scenario();
    expect((await listed(machine)).get(`claude:${CAPTURED_ID}`)).toMatchObject({ origin: "external", owner: "external", conversationOwner: "foreign" });
  });

  test("one in an app tmux terminal that nobody registered is not either", async () => {
    const { machine } = await scenario();
    expect((await listed(machine)).get("claude:app-tmux")).toMatchObject({ origin: "external", owner: "external", conversationOwner: "foreign" });
  });

  test("a session opened in a plain terminal stays external", async () => {
    const { machine } = await scenario();
    expect((await listed(machine)).get("claude:plain-terminal")).toMatchObject({ origin: "external", owner: "external" });
  });

  test("releasing an app tmux session nobody recorded closes that tmux session", async () => {
    const { machine, calls } = await scenario();
    const result = await route(["session", "release", "claude:app-tmux", "--json"], { environment: env, processAdapter: machine });
    expect(result.kind).toBe("ok");
    expect(calls).toContainEqual({ command: "tmux", args: ["-L", "megabrain-app", "kill-session", "-t", "mb-app-term-7"] });
  });

  test("releasing a native app session ends the process the app started for it", async () => {
    const { machine, calls, native } = await scenario();
    const result = await route(["session", "release", `claude:${CAPTURED_ID}`, "--json"], { environment: env, processAdapter: machine });
    expect(result.kind).toBe("ok");
    expect(calls).toContainEqual({ command: "kill", args: ["-TERM", String(native)] });
  });

  test("releasing a session the app did not launch still refuses", async () => {
    const { machine, calls } = await scenario();
    const result = await route(["session", "release", "claude:plain-terminal", "--json"], { environment: env, processAdapter: machine });
    expect(result.kind).toBe("failed");
    expect(calls.filter((call) => call.command === "kill" || call.args.includes("kill-session"))).toEqual([]);
  });

  test("closing a terminal conversation of ours that ended drops its entry, with nothing left to kill but its tmux alias", async () => {
    const { machine, calls } = await scenario();
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "conversations.json"), JSON.stringify({ version: 1, hiddenKeys: [], migratedFrom: [], conversations: {
      "claude:long-gone": { owner: "app-terminal", cwd: project, aliases: { chatId: null, tmux: "megabrain-app:mb-app-gone", pid: null, dispatchId: null }, createdAt: "2026-10-01T10:00:00.000Z", hidden: false },
    } }));
    const result = await route(["session", "release", "claude:long-gone", "--json"], { environment: env, processAdapter: machine });
    expect(result.kind).toBe("ok");
    expect(calls).toContainEqual({ command: "tmux", args: ["-L", "megabrain-app", "kill-session", "-t", "mb-app-gone"] });
    expect((JSON.parse(readFileSync(join(state, "conversations.json"), "utf8")) as { conversations: Record<string, unknown> }).conversations).toEqual({});
  });

  test("closing a live terminal conversation of ours ends its tmux session and drops its entry", async () => {
    const { machine, calls } = await scenario();
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "conversations.json"), JSON.stringify({ version: 1, hiddenKeys: [], migratedFrom: [], conversations: {
      "claude:app-tmux": { owner: "app-terminal", cwd: project, aliases: { chatId: null, tmux: "megabrain-app:mb-app-term-7", pid: null, dispatchId: null }, createdAt: "2026-10-16T10:00:00.000Z", hidden: false },
    } }));
    const result = await route(["session", "release", "claude:app-tmux", "--json"], { environment: env, processAdapter: machine });
    expect(result.kind).toBe("ok");
    expect(calls).toContainEqual({ command: "tmux", args: ["-L", "megabrain-app", "kill-session", "-t", "mb-app-term-7"] });
    expect((JSON.parse(readFileSync(join(state, "conversations.json"), "utf8")) as { conversations: Record<string, unknown> }).conversations).toEqual({});
  });
});
