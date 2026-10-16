import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import type { Chat } from "../../src/chat/store.js";
import { scrubAgentEnvironment } from "../../src/core/agent-env.js";

const markers = [
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT", "CLAUDE_PID",
  "ORCA_AGENT_ID", "ORCA_PANE_KEY", "ORCA_TAB_ID", "ORCA_TERMINAL_HANDLE", "ORCA_WORKTREE_ID", "SUPERSET_TERMINAL_ID",
  "CODEX_THREAD_ID", "CODEX_SESSION_ID", "GROK_AGENT", "ANTIGRAVITY_AGENT", "AI_AGENT", "MEGABRAIN_DISPATCH_ID",
  "MEGABRAIN_SESSION_ID", "TMUX", "TMUX_PANE",
];
const kept = ["PATH", "HOME", "CODEX_HOME", "MEGABRAIN_STATE_DIR", "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY"];

describe("agent environment scrub", () => {
  test("removes every agent and host session marker", () => {
    const dirty = Object.fromEntries(markers.map((name) => [name, "x"]));
    expect(scrubAgentEnvironment({ ...dirty, PATH: "/bin" })).toEqual({ PATH: "/bin" });
  });
  test("keeps the person's own configuration", () => {
    const own = Object.fromEntries(kept.map((name) => [name, "v"]));
    expect(scrubAgentEnvironment({ ...own, CLAUDECODE: "1" })).toEqual(own);
  });
  test("does not change its input", () => {
    const input = { CLAUDECODE: "1" };
    scrubAgentEnvironment(input);
    expect(input).toEqual({ CLAUDECODE: "1" });
  });
});

const directories: string[] = [];
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-env-"));
  directories.push(root);
  const state = join(root, "state"), cwd = join(root, "project"), bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(cwd); mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(join(root, "env.json"))}, JSON.stringify(process.env));
process.stdin.resume();
`);
  chmodSync(join(bin, "claude"), 0o700);
  for (const name of markers) { saved[name] = process.env[name]; process.env[name] = "leaked"; }
  const daemon = new ChatDaemon(state, { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
  await daemon.start();
  await daemon.listen();
  return { root, cwd, daemon };
}

// Polls until the read value passes, on a wall-clock deadline rather than an attempt count, so a slow
// machine gets the same time and a timeout says what it last saw.
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, label: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  let seen: T;
  while (!ok(seen = await read())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}; last saw ${JSON.stringify(seen)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("chat agent process", () => {
  test("starts without another session's markers", async () => {
    const h = await harness();
    await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd });
    await until(() => { try { readFileSync(join(h.root, "env.json")); return "written"; } catch { return "missing"; } }, (seen) => seen === "written", "child env file");
    const env = JSON.parse(readFileSync(join(h.root, "env.json"), "utf8")) as Record<string, string>;
    expect(markers.filter((name) => name in env)).toEqual([]);
    await h.daemon.close();
  });

  test("is idle once spawned and after a respawn, with no input", async () => {
    const h = await harness();
    const chat = await h.daemon.handle({ operation: "start", agent: "claude", cwd: h.cwd }) as Chat;
    const state = async () => ((await h.daemon.handle({ operation: "list" })) as Chat[]).find((item) => item.id === chat.id)?.state;
    await until(state, (seen) => seen === "idle", "idle after start");
    await h.daemon.handle({ operation: "mode", id: chat.id, mode: "terminal" });
    await h.daemon.handle({ operation: "mode", id: chat.id, mode: "chat" });
    await until(state, (seen) => seen === "idle", "idle after respawn");
    await h.daemon.close();
  }, 30_000);
});
