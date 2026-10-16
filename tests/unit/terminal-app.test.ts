import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { forgetAppTerminal, readAppTerminals, recordAppTerminal } from "../../src/core/app-terminals.js";
import { executeAppTerminalClose, executeAppTerminalList } from "../../src/cli/commands/terminal-app.js";
import { executeTerminalList } from "../../src/cli/commands/terminal-list.js";
import { executeTerminalLifecycle } from "../../src/cli/commands/terminal-lifecycle.js";

// The desktop app opens its tmux terminals on its own tmux server, named mb-app-<uuid>. Every test
// here talks to a private server (-L) and never to the default one or to megabrain-app.

const process = createProcessAdapter();
const servers: string[] = [];

function privateServer(): string {
  const name = `mbtest-${randomUUID().slice(0, 8)}`;
  servers.push(name);
  return name;
}

async function tmux(server: string, ...args: string[]) {
  return process.run("tmux", ["-L", server, ...args]);
}

async function newSession(server: string, id: string, cwd: string): Promise<string> {
  const name = `mb-app-${id}`;
  const result = await tmux(server, "new-session", "-d", "-s", name, "-c", cwd, "sleep 300");
  expect(result.kind).toBe("ok");
  return name;
}

async function sessionNames(server: string): Promise<string[]> {
  const result = await tmux(server, "list-sessions", "-F", "#{session_name}");
  return result.kind === "ok" ? result.value.stdout.split("\n").filter((line) => line !== "") : [];
}

// A registry that already ran its one-time migration, so a test never reaches the real app server through it.
async function writeRegistry(stateDir: string, conversations: Record<string, unknown>): Promise<void> {
  await writeFile(`${stateDir}/conversations.json`, JSON.stringify({ version: 1, conversations, hiddenKeys: [], migratedFrom: [] }));
}

async function readRegistry(stateDir: string): Promise<Record<string, { owner: string; aliases: { tmux: string | null } }>> {
  return (JSON.parse(await readFile(`${stateDir}/conversations.json`, "utf8")) as { conversations: Record<string, { owner: string; aliases: { tmux: string | null } }> }).conversations;
}

const entry = (owner: string, tmux: string | null, chatId: string | null = null) => ({ owner, cwd: "/work", aliases: { chatId, tmux, pid: null, dispatchId: null }, createdAt: "2026-10-15T10:00:00.000Z", hidden: false });

async function listed(stateDir: string, server: string) {
  const result = await executeAppTerminalList(["--server", server, "--json"], { MEGABRAIN_STATE_DIR: stateDir }, process);
  expect(result.kind).toBe("ok");
  return result.kind === "ok" ? JSON.parse(result.value) as Array<Record<string, unknown>> : [];
}

afterEach(async () => {
  for (const server of servers.splice(0)) await tmux(server, "kill-server");
});

describe("app terminal records", () => {
  test("records the title and command at creation and reads them back", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    recordAppTerminal(stateDir, "mb-app-one", { title: "claude", command: "claude --resume x", cwd: "/work", createdAt: "2026-10-15T10:00:00.000Z" });
    recordAppTerminal(stateDir, "mb-app-two", { title: "zsh", command: "", cwd: "/work", createdAt: "2026-10-15T10:01:00.000Z" });
    expect(readAppTerminals(stateDir)["mb-app-one"]).toEqual({ title: "claude", command: "claude --resume x", cwd: "/work", createdAt: "2026-10-15T10:00:00.000Z" });
    forgetAppTerminal(stateDir, "mb-app-one");
    expect(Object.keys(readAppTerminals(stateDir))).toEqual(["mb-app-two"]);
  });

  test("a missing or corrupt record file reads as empty", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    expect(readAppTerminals(stateDir)).toEqual({});
    await writeFile(`${stateDir}/app-terminals.json`, "{not json");
    expect(readAppTerminals(stateDir)).toEqual({});
  });
});

describe("terminal list --app", () => {
  test("lists the app's sessions with the title and command recorded at creation", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    const id = randomUUID();
    const session = await newSession(server, id, cwd);
    recordAppTerminal(stateDir, session, { title: "claude", command: "claude --resume x", cwd, createdAt: "2026-10-15T10:00:00.000Z" });
    const [entry, ...others] = await listed(stateDir, server);
    expect(others).toEqual([]);
    expect(entry).toMatchObject({ id, sessionName: session, title: "claude", command: "claude --resume x", alive: true, createdAt: "2026-10-15T10:00:00.000Z" });
    expect(typeof entry?.cwd).toBe("string");
  });

  test("ignores sessions the app did not create", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    await tmux(server, "new-session", "-d", "-s", "mb-claude-abcd1234", "-c", cwd, "sleep 300");
    expect(await listed(stateDir, server)).toEqual([]);
  });

  test("a session without a record still lists, with the tmux creation time", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    const id = randomUUID();
    await newSession(server, id, cwd);
    const [entry] = await listed(stateDir, server);
    expect(entry).toMatchObject({ id, alive: true, title: "tmux", command: "" });
    expect(Number.isNaN(Date.parse(String(entry?.createdAt)))).toBe(false);
  });

  test("a gone terminal that ran a conversation of ours is listed as not alive", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const server = privateServer();
    const id = randomUUID();
    recordAppTerminal(stateDir, `mb-app-${id}`, { title: "claude", command: "claude --resume r1", cwd: "/work", createdAt: "2026-10-15T10:00:00.000Z" });
    await writeRegistry(stateDir, { "claude:r1": entry("app-terminal", `${server}:mb-app-${id}`) });
    expect(await listed(stateDir, server)).toEqual([expect.objectContaining({ id, alive: false, title: "claude" })]);
  });

  test("a gone terminal that held no conversation is not listed, and its record and entry go", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const server = privateServer();
    const shell = randomUUID();
    const bare = randomUUID();
    recordAppTerminal(stateDir, `mb-app-${shell}`, { title: "zsh", command: "", cwd: "/work", createdAt: "2026-10-15T10:00:00.000Z" });
    recordAppTerminal(stateDir, `mb-app-${bare}`, { title: "zsh", command: "", cwd: "/work", createdAt: "2026-10-15T10:00:00.000Z" });
    await writeRegistry(stateDir, { [`terminal:${shell}`]: entry("app-terminal", `${server}:mb-app-${shell}`) });
    expect(await listed(stateDir, server)).toEqual([]);
    expect(readAppTerminals(stateDir)).toEqual({});
    expect(await readRegistry(stateDir)).toEqual({});
  });

  test("a chat's terminal-mode TUI is the chat's, not a terminal of its own", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    const tui = await newSession(server, randomUUID(), cwd);
    const shellId = randomUUID();
    await newSession(server, shellId, cwd);
    await writeRegistry(stateDir, { "claude:s1": entry("app-chat", `${server}:${tui}`, "chat-1") });
    expect((await listed(stateDir, server)).map((item) => item.id)).toEqual([shellId]);
  });

  test("no tmux server running is an empty list, not an error", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    expect(await listed(stateDir, privateServer())).toEqual([]);
  });

  test("terminal list --app is reachable through the terminal list verb", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const result = await executeTerminalList(["--app", "--server", privateServer(), "--json"], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result).toEqual(ok("[]\n"));
  });

  test("only ever addresses the named server", async () => {
    const calls: string[][] = [];
    const fake: ProcessAdapter = {
      async run(command, args) { calls.push([command, ...args]); return failed("no server running"); },
      async startDetached() { return failed("unused"); },
      invocationCount() { return calls.length; },
    };
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    await executeAppTerminalList(["--server", "private-x", "--json"], { MEGABRAIN_STATE_DIR: stateDir }, fake);
    await executeAppTerminalClose(["abc", "--server", "private-x"], { MEGABRAIN_STATE_DIR: stateDir }, fake);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.slice(0, 3)).toEqual(["tmux", "-L", "private-x"]);
  });
});

describe("terminal close --app", () => {
  test("kills the tmux session and forgets the record", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    const keep = randomUUID();
    const drop = randomUUID();
    await newSession(server, keep, cwd);
    const dropSession = await newSession(server, drop, cwd);
    recordAppTerminal(stateDir, dropSession, { title: "zsh", command: "", cwd, createdAt: "2026-10-15T10:00:00.000Z" });
    const result = await executeAppTerminalClose([drop, "--server", server], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result.kind).toBe("ok");
    expect(await sessionNames(server)).toEqual([`mb-app-${keep}`]);
    expect(readAppTerminals(stateDir)[dropSession]).toBeUndefined();
    expect((await listed(stateDir, server)).map((entry) => entry.id)).toEqual([keep]);
  });

  test("drops the terminal's conversation, and a chat that used it only loses the alias", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    const shell = randomUUID();
    const tui = randomUUID();
    await newSession(server, shell, cwd);
    await newSession(server, tui, cwd);
    await writeRegistry(stateDir, {
      [`terminal:${shell}`]: entry("app-terminal", `${server}:mb-app-${shell}`),
      "claude:s1": entry("app-chat", `${server}:mb-app-${tui}`, "chat-1"),
    });
    expect((await executeAppTerminalClose([shell, "--server", server], { MEGABRAIN_STATE_DIR: stateDir }, process)).kind).toBe("ok");
    expect((await executeAppTerminalClose([tui, "--server", server], { MEGABRAIN_STATE_DIR: stateDir }, process)).kind).toBe("ok");
    const registry = await readRegistry(stateDir);
    expect(Object.keys(registry)).toEqual(["claude:s1"]);
    expect(registry["claude:s1"]).toMatchObject({ owner: "app-chat", aliases: { tmux: null } });
  });

  test("closing a terminal whose session already ended still clears its record", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const server = privateServer();
    const id = randomUUID();
    recordAppTerminal(stateDir, `mb-app-${id}`, { title: "zsh", command: "", cwd: "/work", createdAt: "2026-10-15T10:00:00.000Z" });
    const result = await executeAppTerminalClose([id, "--server", server], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result.kind).toBe("ok");
    expect(readAppTerminals(stateDir)).toEqual({});
  });

  test("an id that is neither a session nor a record is an error", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const result = await executeAppTerminalClose([randomUUID(), "--server", privateServer()], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result.kind).toBe("failed");
  });

  test("refuses ids that are not a plain terminal id", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    for (const bad of ["", "a:b", "../x", "a b"]) {
      const result = await executeAppTerminalClose([bad, "--server", privateServer()], { MEGABRAIN_STATE_DIR: stateDir }, process);
      expect(result.kind).toBe("failed");
    }
  });

  test("terminal close --app is reachable through the lifecycle verb", async () => {
    const stateDir = await mkdtemp(`${tmpdir()}/megabrain-app-state-`);
    const cwd = await mkdtemp(`${tmpdir()}/megabrain-app-cwd-`);
    const server = privateServer();
    const id = randomUUID();
    await newSession(server, id, cwd);
    const result = await executeTerminalLifecycle(["close", "--app", id, "--server", server], { MEGABRAIN_STATE_DIR: stateDir }, process);
    expect(result.kind).toBe("ok");
    expect(await sessionNames(server)).toEqual([]);
  });
});
