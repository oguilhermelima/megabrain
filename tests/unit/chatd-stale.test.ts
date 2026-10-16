import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";
import { callChatd, ChatDaemon } from "../../src/chat/daemon.js";
import { ChatStore, type Chat } from "../../src/chat/store.js";

const directories: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const processAdapter: ProcessAdapter = {
  async run(command) { return failed(`${command} unavailable`); },
  async startDetached(command) { return failed(`${command} unexpectedly detached`); },
  invocationCount() { return 0; },
};

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "mb-chatd-"));
  directories.push(root);
  const state = join(root, "state");
  mkdirSync(join(state, "chatd"), { recursive: true, mode: 0o700 });
  return { root, state, socket: join(state, "chatd", "s"), pid: join(state, "chatd", "chatd.pid"), lock: join(state, "chatd", "start.lock") };
}

/** A real stale socket file: a process listens, then dies without unlinking. */
async function leaveStaleSocket(path: string): Promise<void> {
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => console.log("ready"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  expect(existsSync(path)).toBe(true);
}

function deadPid(): number {
  const child = spawn(process.execPath, ["-e", ""]);
  const pid = child.pid ?? 0;
  child.kill("SIGKILL");
  return pid;
}

function chat(id: string): Chat {
  return { id, agent: "claude", model: null, cwd: "/tmp", title: "t", state: "stopped", mode: "chat", agentSessionId: null, createdAt: "2026-10-15T00:00:00.000Z", lastActivityAt: null };
}

const fast = { MEGABRAIN_CHATD_CONNECT_TIMEOUT_MS: "300", MEGABRAIN_CHATD_REQUEST_TIMEOUT_MS: "400" };

async function silentServer(path: string, onConnection?: (socket: Socket) => void): Promise<void> {
  const server = createServer((socket) => { sockets.push(socket); onConnection?.(socket); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
}

describe("chatd recovers from stale state", () => {
  test("a stale pid file and socket do not block a call", async () => {
    const env = sandbox();
    await leaveStaleSocket(env.socket);
    writeFileSync(env.pid, `${deadPid()}\n`);
    const started = Date.now();
    const value = await callChatd(env.state, { operation: "list" }, { HOME: env.root, ...fast }, processAdapter);
    expect(value).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a stale socket with a dead client lock recovers without waiting", async () => {
    const env = sandbox();
    await leaveStaleSocket(env.socket);
    writeFileSync(env.pid, `${deadPid()}\n`);
    writeFileSync(env.lock, `${deadPid()}\n`);
    const started = Date.now();
    expect(await callChatd(env.state, { operation: "list" }, { HOME: env.root, ...fast }, processAdapter)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a socket file without a pid file lets a new daemon listen", async () => {
    const env = sandbox();
    await leaveStaleSocket(env.socket);
    const daemon = new ChatDaemon(env.state, { HOME: env.root });
    await daemon.start();
    await daemon.listen();
    expect(await callChatd(env.state, { operation: "list" }, { HOME: env.root, ...fast }, processAdapter)).toEqual([]);
    await daemon.close();
  });

  test("a stale pid file is removed when a new daemon starts", async () => {
    const env = sandbox();
    await leaveStaleSocket(env.socket);
    writeFileSync(env.pid, `${deadPid()}\n`);
    const daemon = new ChatDaemon(env.state, { HOME: env.root });
    await daemon.start();
    await daemon.listen();
    await daemon.close();
    expect(existsSync(env.socket)).toBe(false);
    expect(existsSync(env.pid)).toBe(false);
  });

  test("a live daemon is reused and its socket is not stolen", async () => {
    const env = sandbox();
    const live = new ChatDaemon(env.state, { HOME: env.root });
    await live.start();
    await live.listen();
    await new ChatStore(env.state).put(chat("11111111-1111-1111-1111-111111111111"));
    const second = new ChatDaemon(env.state, { HOME: env.root });
    await expect(second.listen()).rejects.toThrow(/already running/);
    const value = await callChatd(env.state, { operation: "list" }, { HOME: env.root, ...fast }, processAdapter) as Chat[];
    expect(value.map((item) => item.id)).toEqual(["11111111-1111-1111-1111-111111111111"]);
    await live.close();
  });

  test("an unresponsive daemon makes the call fail instead of hanging", async () => {
    const env = sandbox();
    await silentServer(env.socket);
    const started = Date.now();
    await expect(callChatd(env.state, { operation: "list" }, { HOME: env.root, ...fast }, processAdapter)).rejects.toThrow(/did not answer/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("chat list reads the records from disk when the daemon does not answer", async () => {
    const env = sandbox();
    await new ChatStore(env.state).put(chat("22222222-2222-2222-2222-222222222222"));
    await silentServer(env.socket);
    const started = Date.now();
    const result = await route(["chat", "list", "--json"], { environment: { HOME: env.root, MEGABRAIN_STATE_DIR: env.state, ...fast }, processAdapter });
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect((JSON.parse(result.value) as Chat[]).map((item) => item.id)).toEqual(["22222222-2222-2222-2222-222222222222"]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("follow exits with an error when the daemon dies", async () => {
    const env = sandbox();
    await new ChatStore(env.state).put(chat("33333333-3333-3333-3333-333333333333"));
    await silentServer(env.socket, (socket) => {
      socket.write(`${JSON.stringify({ cursor: "0" })}\n`);
      setTimeout(() => socket.destroy(), 100);
    });
    const lines: unknown[] = [];
    await expect(callChatd(env.state, { operation: "events", id: "33333333-3333-3333-3333-333333333333", since: 0, follow: true }, { HOME: env.root, ...fast }, processAdapter, (line) => lines.push(line))).rejects.toThrow(/chatd/);
    expect(lines.length).toBe(1);
  });

  test("follow stays open past the request timeout while the daemon lives", async () => {
    const env = sandbox();
    await silentServer(env.socket, (socket) => {
      socket.write(`${JSON.stringify({ cursor: "0" })}\n`);
      setTimeout(() => socket.write(`${JSON.stringify({ cursor: "1" })}\n`), 700);
      setTimeout(() => socket.destroy(), 900);
    });
    const lines: unknown[] = [];
    await expect(callChatd(env.state, { operation: "events", id: "33333333-3333-3333-3333-333333333333", since: 0, follow: true }, { HOME: env.root, ...fast }, processAdapter, (line) => lines.push(line))).rejects.toThrow(/chatd/);
    expect(lines.length).toBe(2);
  });
});
