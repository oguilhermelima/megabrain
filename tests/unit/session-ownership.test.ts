import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failed, ok, type Result } from "../../src/core/result.js";
import type { ProcessAdapter, ProcessOutput } from "../../src/adapters/proc.js";
import { executeSession } from "../../src/cli/commands/session.js";
import { executeSend } from "../../src/cli/commands/send.js";
import { ownedSessionName, resumeCommand, sessionOwnerFields, OWNED_TMUX_SERVER } from "../../src/core/session-ownership.js";
import { composerProcess } from "./composer-tmux.js";
import { readConversations } from "../../src/core/conversations.js";

const sessionId = "0f1e2d3c-aaaa-bbbb-cccc-1234567890ab";
const key = `claude:${sessionId}`;
const tmuxName = "mb-claude-0f1e2d3c";

type Call = Readonly<{ command: string; args: readonly string[] }>;
type Fake = ProcessAdapter & Readonly<{ calls: Call[]; sessions: Set<string>; setAgentReady: (ready: boolean) => void; pasted: () => string[] }>;

// A tmux that knows sessions by name. Every tmux call must name the -L server first; a call that
// does not is recorded as-is so the test sees the default server being touched.
function fakeTmux(options: Readonly<{ ready?: boolean; noServer?: string; ps?: string; appPanes?: string }> = {}): Fake {
  const calls: Call[] = [];
  const sessions = new Set<string>();
  let ready = options.ready ?? true;
  // Until new-session starts it, a missing server answers every query with this stderr.
  let serverMessage = options.noServer;
  const composer = composerProcess({ agent: "claude" });
  const done = (stdout = ""): Result<ProcessOutput> => ok({ stdout, stderr: "", exitCode: 0 });
  const adapter: Fake = {
    calls, sessions,
    setAgentReady: (value) => { ready = value; },
    pasted: () => calls.filter((call) => call.args.includes("paste-buffer")).map((call) => call.args.join(" ")),
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "ps") return done(options.ps ?? "");
      if (command !== "tmux") return done();
      const rest = args[0] === "-L" ? args.slice(2) : args;
      const target = rest[rest.indexOf("-t") + 1] ?? "";
      if (serverMessage !== undefined && rest[0] !== "new-session") return failed(serverMessage, 1);
      switch (rest[0]) {
        case "has-session": return sessions.has(target) ? done() : failed("can't find session: " + target, 1);
        case "new-session": serverMessage = undefined; sessions.add(rest[rest.indexOf("-s") + 1] ?? ""); return done();
        case "kill-session": sessions.delete(target); return done();
        case "list-panes":
          if (rest.includes("-a")) return done(rest.includes("#{pane_pid} #{session_name}") ? options.appPanes ?? "" : "%9|$1\n");
          return sessions.has(target) ? done("%9\n") : failed("can't find session: " + target, 1);
        case "capture-pane": {
          if (!ready) return done("loading...\n");
          const screen = await composer(command, rest);
          // A resumed conversation draws an empty composer, not the new-conversation hint.
          return screen?.kind === "ok" ? done(screen.value.stdout.replace(/❯ Try ".*"/u, "❯ ")) : done();
        }
        default: return (await composer(command, rest)) ?? done();
      }
    },
  };
  return adapter;
}

let root: string;
let home: string;
let worktree: string;
let environment: Record<string, string>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "megabrain-own-"));
  home = join(root, "home");
  worktree = join(root, "work");
  await mkdir(join(home, ".claude", "sessions"), { recursive: true });
  await mkdir(worktree, { recursive: true });
  // The file name is a pid that exists (this process), as a running Claude's would be.
  await writeFile(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId, cwd: worktree, status: "idle", startedAt: Date.now(), updatedAt: Date.now(),
  }));
  environment = { HOME: home, MEGABRAIN_STATE_DIR: join(root, "state") };
  await mkdir(environment.MEGABRAIN_STATE_DIR as string, { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const fast = { readyTimeoutMs: 80, pollMs: 5 };

describe("session own and release", () => {
  test("builds the resume command each agent needs, with its bypass flag", () => {
    expect(resumeCommand("claude", "abc")).toBe("claude --resume abc --dangerously-skip-permissions");
    expect(resumeCommand("claude", "abc", "claude-opus-5-5")).toBe("claude --resume abc --dangerously-skip-permissions --model claude-opus-5-5");
    expect(resumeCommand("codex", "abc")).toBe("codex resume abc --dangerously-bypass-approvals-and-sandbox -c check_for_update_on_startup=false");
    expect(ownedSessionName("claude", sessionId)).toBe(tmuxName);
    expect(OWNED_TMUX_SERVER).toBe("megabrain-app");
  });

  test("resumes the session in its own cwd on megabrain's tmux server and reports it", async () => {
    const tmux = fakeTmux();
    const result = await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(JSON.parse(result.value)).toEqual({
      session: key, owner: "megabrain", tmuxServer: "megabrain-app", tmuxSession: tmuxName,
      command: `claude --resume ${sessionId} --dangerously-skip-permissions`,
    });
    const created = tmux.calls.find((call) => call.args.includes("new-session"));
    expect(created?.args.slice(0, 2)).toEqual(["-L", "megabrain-app"]);
    expect(created?.args).toContain(tmuxName);
    expect(created?.args[created.args.indexOf("-c") + 1]).toBe(worktree);
    expect(created?.args.at(-1)).toBe(`claude --resume ${sessionId} --dangerously-skip-permissions`);
  });

  test("never touches the default tmux server or any Orca terminal", async () => {
    const tmux = fakeTmux();
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    await executeSession(["release", key, "--json"], environment, tmux, fast);
    const tmuxCalls = tmux.calls.filter((call) => call.command === "tmux");
    expect(tmuxCalls.length).toBeGreaterThan(0);
    for (const call of tmuxCalls) expect(call.args.slice(0, 2)).toEqual(["-L", "megabrain-app"]);
    expect(tmux.calls.some((call) => call.command === "orca")).toBe(false);
  });

  test("reuses a tmux session that is still alive instead of resuming twice", async () => {
    const tmux = fakeTmux();
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    const again = await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(again.kind).toBe("ok");
    expect(tmux.calls.filter((call) => call.args.includes("new-session")).length).toBe(1);
  });

  test("takes the app terminal already resuming the session instead of resuming it a second time", async () => {
    const tmux = fakeTmux({ ps: `  4242     1 claude --resume ${sessionId} --dangerously-skip-permissions\n`, appPanes: "4242 mb-app-chat\n" });
    tmux.sessions.add("mb-app-chat");
    const result = await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.kind === "ok" ? result.value : "{}")).toMatchObject({ tmuxSession: "mb-app-chat" });
    expect(tmux.calls.some((call) => call.args.includes("new-session"))).toBe(false);
  });

  for (const stderr of [
    "error connecting to /private/tmp/tmux-501/megabrain-app (No such file or directory)",
    "no server running on /private/tmp/tmux-501/megabrain-app",
  ]) {
    test(`owns a session before megabrain's tmux server exists (${stderr.slice(0, 20)})`, async () => {
      const tmux = fakeTmux({ noServer: stderr });
      const result = await executeSession(["own", key, "--json"], environment, tmux, fast);
      expect(result.kind).toBe("ok");
      expect(tmux.sessions.has(tmuxName)).toBe(true);
    });
  }

  test("still fails on a has-session error that is not a missing server", async () => {
    const tmux = fakeTmux({ noServer: "protocol version mismatch" });
    const result = await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(result.kind).toBe("failed");
    expect(tmux.sessions.size).toBe(0);
  });

  test("gives up when the composer never appears, leaving nothing owned or running", async () => {
    const tmux = fakeTmux({ ready: false });
    const result = await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("composer");
    expect(tmux.sessions.size).toBe(0);
    const send = await executeSend(["--session", key, "--text", "hi", "--json"], { ...environment, MEGABRAIN_OPERATOR: "1" }, tmux);
    expect(send.kind === "ok" && send.value.includes('"channel": "tmux"')).toBe(false);
  });

  test("refuses a session it cannot find and an agent it cannot resume", async () => {
    const tmux = fakeTmux();
    const missing = await executeSession(["own", "claude:no-such-session", "--json"], environment, tmux, fast);
    expect(missing.kind).toBe("failed");
    const grok = await executeSession(["own", "grok:abc", "--json"], environment, tmux, fast);
    expect(grok.kind).toBe("failed");
    expect(tmux.calls.some((call) => call.args.includes("new-session"))).toBe(false);
  });

  test("release forgets ownership and kills only that tmux session", async () => {
    const tmux = fakeTmux();
    tmux.sessions.add("someone-else");
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    const released = await executeSession(["release", key, "--json"], environment, tmux, fast);
    expect(released.kind).toBe("ok");
    expect([...tmux.sessions]).toEqual(["someone-else"]);
    const again = await executeSession(["release", key, "--json"], environment, tmux, fast);
    expect(again.kind).toBe("failed");
  });
});

describe("session own and release keep the conversation registry", () => {
  test("own records the session as an app terminal with its tmux alias; release drops it", async () => {
    const tmux = fakeTmux();
    const state = environment.MEGABRAIN_STATE_DIR as string;
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(readConversations(state).conversations[key]).toMatchObject({ owner: "app-terminal", cwd: worktree, hidden: false, aliases: { tmux: `megabrain-app:${tmuxName}` } });
    await executeSession(["release", key, "--json"], environment, tmux, fast);
    expect(readConversations(state).conversations[key]).toBeUndefined();
  });

  test("owning a session a chat already owns adds the alias and keeps the chat's entry", async () => {
    const state = environment.MEGABRAIN_STATE_DIR as string;
    const { upsertConversation } = await import("../../src/core/conversations.js");
    upsertConversation(state, key, { owner: "app-chat", cwd: worktree, aliases: { chatId: "c1", tmux: null, pid: null, dispatchId: null }, createdAt: "2026-10-16T09:00:00.000Z", hidden: false });
    const tmux = fakeTmux();
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    expect(readConversations(state).conversations[key]).toMatchObject({ owner: "app-chat", aliases: { chatId: "c1", tmux: `megabrain-app:${tmuxName}` } });
    await executeSession(["release", key, "--json"], environment, tmux, fast);
    expect(readConversations(state).conversations[key]).toMatchObject({ owner: "app-chat", aliases: { chatId: "c1", tmux: null } });
  });
});

describe("owner fields on listed sessions", () => {
  test("a session is external until owned, then carries the tmux server and session", async () => {
    expect(sessionOwnerFields(undefined, key)).toEqual({ owner: "external" });
    const tmux = fakeTmux();
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    const { readOwnedSessions } = await import("../../src/core/session-ownership.js");
    const owned = readOwnedSessions(environment.MEGABRAIN_STATE_DIR as string);
    expect(sessionOwnerFields(owned, key)).toEqual({ owner: "megabrain", tmuxServer: "megabrain-app", tmuxSession: tmuxName });
    expect(sessionOwnerFields(owned, "claude:other")).toEqual({ owner: "external" });
    await executeSession(["release", key, "--json"], environment, tmux, fast);
    expect(sessionOwnerFields(readOwnedSessions(environment.MEGABRAIN_STATE_DIR as string), key)).toEqual({ owner: "external" });
  });
});

describe("send to an owned session", () => {
  test("pastes into megabrain's tmux session without looking for an Orca terminal", async () => {
    const tmux = fakeTmux();
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    tmux.calls.length = 0;
    const sent = await executeSend(["--session", key, "--text", "olá mundo", "--json"], { ...environment, MEGABRAIN_OPERATOR: "1" }, tmux);
    expect(sent.kind).toBe("ok");
    if (sent.kind !== "ok") return;
    expect(JSON.parse(sent.value)).toEqual({ delivered: true, channel: "typed" });
    expect(tmux.calls.some((call) => call.command === "orca")).toBe(false);
    expect(tmux.pasted().length).toBe(1);
    for (const call of tmux.calls.filter((entry) => entry.command === "tmux")) expect(call.args.slice(0, 2)).toEqual(["-L", "megabrain-app"]);
  });

  test("says the owned session is not running when its tmux session is gone", async () => {
    const tmux = fakeTmux();
    await executeSession(["own", key, "--json"], environment, tmux, fast);
    tmux.sessions.clear();
    const sent = await executeSend(["--session", key, "--text", "hi", "--json"], { ...environment, MEGABRAIN_OPERATOR: "1" }, tmux);
    expect(sent.kind).toBe("ok");
    if (sent.kind !== "ok") return;
    expect(JSON.parse(sent.value).delivered).toBe(false);
    expect(JSON.parse(sent.value).detail).toContain("session own");
  });

  test("leaves an external session on the existing path", async () => {
    const tmux = fakeTmux();
    const sent = await executeSend(["--session", "claude:external-one", "--text", "hi", "--json"], { ...environment, MEGABRAIN_OPERATOR: "1" }, tmux);
    expect(sent.kind).toBe("ok");
    if (sent.kind === "ok") expect(JSON.parse(sent.value)).toMatchObject({ delivered: false, channel: "typed", detail: "no delivery channel is available for this session" });
    expect(tmux.calls.some((call) => call.args.includes("paste-buffer"))).toBe(false);
  });
});

