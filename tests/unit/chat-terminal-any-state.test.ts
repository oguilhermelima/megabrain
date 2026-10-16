import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChatDaemon } from "../../src/chat/daemon.js";
import { claudeLogPath } from "../../src/chat/session-log.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const directories: string[] = [];
const daemons: ChatDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ID = "3b1f0c52-8f5e-4d1e-9a55-0d3f2b6a1e33";
type Mode = { chat: Chat; command: string[] | null };

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "megabrain-anystate-"));
  directories.push(root);
  const state = join(root, "state");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(bin);
  for (const name of ["claude", "codex"]) {
    const path = join(bin, name);
    writeFileSync(path, `#!${process.execPath}\nprocess.stdin.resume();\n`);
    chmodSync(path, 0o700);
  }
  return { root, state, cwd, bin };
}
type Env = ReturnType<typeof sandbox>;

async function daemonWith(env: Env, chat: Partial<Chat>): Promise<ChatDaemon> {
  const record: Chat = {
    id: ID, agent: "claude", model: null, cwd: env.cwd, title: "t", state: "idle", mode: "chat",
    agentSessionId: "sess-1", createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: null, ...chat,
  };
  await new ChatStore(env.state).put(record);
  const environment = { HOME: env.root, PATH: `${env.bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  const daemon = new ChatDaemon(env.state, environment);
  await daemon.start();
  await daemon.listen();
  daemons.push(daemon);
  // start() suspends live chats; put the wanted state back after it.
  await daemon.store.put({ ...record, ...chat, id: ID });
  return daemon;
}

const toTerminal = (daemon: ChatDaemon) => daemon.handle({ operation: "mode", id: ID, mode: "terminal" }) as Promise<Mode>;

describe("terminal mode from every chat state", () => {
  for (const agent of ["claude", "codex"] as const) {
    for (const state of ["idle", "suspended", "stopped", "error", "working", "waiting-approval", "starting"] as const) {
      test(`${agent} from ${state} switches and returns the resume command`, async () => {
        const env = sandbox();
        const daemon = await daemonWith(env, { agent, state, error: state === "error" ? "boom" : null });
        const result = await toTerminal(daemon);
        expect(result.chat.mode).toBe("terminal");
        expect(result.chat.state).toBe("idle");
        expect(result.chat.error ?? null).toBeNull();
        expect(result.command).toContain("sess-1");
        expect((await daemon.store.get(ID))?.mode).toBe("terminal");
      });
    }
  }

  test("a running turn is recorded as interrupted", async () => {
    const env = sandbox();
    const daemon = await daemonWith(env, { state: "working" });
    await toTerminal(daemon);
    const texts = (await daemon.store.events(ID)).flatMap((line) => line.event === undefined ? [] : [line.event.text]);
    expect(texts).toContain("Interrupted");
  });
});

describe("a chat with no session id yet", () => {
  test("claude opens the TUI fresh, without resume", async () => {
    const env = sandbox();
    const daemon = await daemonWith(env, { agentSessionId: null, state: "idle" });
    const result = await toTerminal(daemon);
    expect(result.command?.[0]).toBe("claude");
    expect(result.command).not.toContain("--resume");
  });

  test("codex opens the TUI fresh, without resume", async () => {
    const env = sandbox();
    const daemon = await daemonWith(env, { agent: "codex", agentSessionId: null, state: "idle" });
    const result = await toTerminal(daemon);
    expect(result.command?.[0]).toBe("codex");
    expect(result.command).not.toContain("resume");
  });

  test("terminal-command works too", async () => {
    const env = sandbox();
    const daemon = await daemonWith(env, { agentSessionId: null, state: "idle", mode: "terminal" });
    const command = await daemon.handle({ operation: "terminal-command", id: ID }) as string[];
    expect(command[0]).toBe("claude");
  });

  test("the session id the TUI wrote is recorded when switching back", async () => {
    const env = sandbox();
    const daemon = await daemonWith(env, { agentSessionId: null, state: "idle" });
    await toTerminal(daemon);
    const path = claudeLogPath(env.root, env.cwd, "fresh-tui-session");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    const later = new Date(Date.now() + 5000);
    utimesSync(path, later, later);
    await daemon.handle({ operation: "mode", id: ID, mode: "chat" });
    expect((await daemon.store.get(ID))?.agentSessionId).toBe("fresh-tui-session");
  });
});
