import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ChatStore, type Chat } from "../../src/chat/store.js";
import { appendMessage, createDispatch, stateDatabase } from "../../src/adapters/state-db.js";
import { buildOrchestrationGraph, followOrchestrationGraph } from "../../src/cli/commands/orchestrate-graph.js";

const temporary: string[] = [];
const session = "claude:root-session";
const chatId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-18T12:00:00.000Z";

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "megabrain-graph-test-"));
  temporary.push(path);
  return path;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup() {
  const root = await tempDir();
  const opened = stateDatabase({ MEGABRAIN_STATE_DIR: root });
  if (opened.kind !== "ok") throw new Error(opened.error);
  const database = opened.value;
  const coordinator: Chat = { id: chatId, agent: "claude", model: "claude-sonnet-4-5", effort: "high", cwd: root, title: "Graph coordinator", state: "working", mode: "chat", agentSessionId: "root-session", createdAt: now, lastActivityAt: now };
  const chats = new ChatStore(root);
  await chats.put(coordinator);
  return { root, database, chats, environment: { MEGABRAIN_STATE_DIR: root, HOME: root } };
}

function dispatch(database: ReturnType<typeof stateDatabase> extends { kind: "ok"; value: infer D } ? D : never, id: string, fields: Record<string, unknown> = {}) {
  const result = createDispatch(database, {
    dispatchId: id, parentHost: "local", parentSessionId: "caller", parentAgent: "claude",
    parentAgentSessionId: "root-session", agent: "codex", agentSessionId: id === "lane-a" ? "child-a" : "child-b", state: "running", createdAt: now, updatedAt: now,
    ...fields,
  });
  if (result.kind !== "ok") throw new Error(result.error);
}

describe("orchestrate graph", () => {
  test("builds a tree from a coordinator session", async () => {
    const { database, environment } = await setup();
    dispatch(database, "lane-a", { label: "A" });
    const graph = await buildOrchestrationGraph({ session }, environment);
    expect(graph.focus).toBe("session:" + session);
    expect(graph.root).toBe(graph.focus);
    expect(graph.nodes.map(({ id }) => id)).toEqual([graph.focus, "lane-a"]);
    expect(graph.nodes[1]?.parent).toBe(graph.root);
  });

  test("walks up from a lane and includes its siblings", async () => {
    const { database, environment } = await setup();
    dispatch(database, "lane-a"); dispatch(database, "lane-b");
    const graph = await buildOrchestrationGraph({ session: "codex:child-a" }, environment);
    expect(graph.focus).toBe("lane-a");
    expect(graph.root).toBe("session:" + session);
    expect(graph.nodes.map(({ id }) => id)).toContain("lane-b");
  });

  test("resolves an app chat id to its coordinator session", async () => {
    const { database, environment } = await setup();
    dispatch(database, "lane-a");
    const graph = await buildOrchestrationGraph({ chat: chatId }, environment);
    expect(graph.focus).toBe("session:" + session);
    expect(graph.nodes[0]?.chatId).toBe(chatId);
    expect(graph.nodes[0]?.label).toBe("Graph coordinator");
  });

  test("returns one coordinator node when a chat has no dispatches", async () => {
    const { environment } = await setup();
    const graph = await buildOrchestrationGraph({ chat: chatId }, environment);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]?.kind).toBe("coordinator");
    expect(graph.nodes[0]?.parent).toBeNull();
  });

  test("marks a latest child ask unanswered until a parent reply exists", async () => {
    const { database, environment } = await setup();
    dispatch(database, "lane-a");
    appendMessage(database, "lane-a", { from: "child", type: "ask", text: "Need a decision", createdAt: now });
    let graph = await buildOrchestrationGraph({ session }, environment);
    expect(graph.nodes.find(({ id }) => id === "lane-a")?.unanswered).toBe(true);
    appendMessage(database, "lane-a", { from: "parent", type: "reply", text: "Proceed", createdAt: now });
    graph = await buildOrchestrationGraph({ session }, environment);
    expect(graph.nodes.find(({ id }) => id === "lane-a")?.unanswered).toBe(false);
  });

  test("keeps a missing worktree readable with a null commit count", async () => {
    const { database, environment } = await setup();
    dispatch(database, "lane-a", { worktreePath: join(await tempDir(), "gone"), branch: "feature" });
    const graph = await buildOrchestrationGraph({ session }, environment);
    expect(graph.nodes.find(({ id }) => id === "lane-a")?.commits).toBeNull();
  });

  test("follow yields a fresh snapshot after a message is appended", async () => {
    const { database, environment } = await setup();
    dispatch(database, "lane-a");
    const controller = new AbortController();
    const iterator = followOrchestrationGraph({ session }, environment, { signal: controller.signal, intervalMs: 10 });
    const first = await iterator.next();
    appendMessage(database, "lane-a", { from: "child", type: "received", text: "new message", createdAt: now });
    const second = await iterator.next();
    controller.abort();
    await iterator.return(undefined);
    expect(first.value?.nodes[1]?.last?.text).not.toBe("new message");
    expect(second.value?.nodes[1]?.last?.text).toBe("new message");
  });

  test("follow exits when its calling process disappears", async () => {
    const { root } = await setup();
    const pidFile = join(root, "graph.pid");
    const launcher = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.env.MB_GRAPH_BINARY, ["orchestrate", "graph", "--session", "claude:root-session", "--follow", "--json"], { stdio: "ignore", env: process.env });',
      'writeFileSync(process.env.MB_GRAPH_PID_FILE, String(child.pid));',
      'child.unref();',
    ].join(" ");
    const parent = spawn(process.execPath, ["-e", launcher], {
      stdio: "ignore",
      env: { ...process.env, MEGABRAIN_STATE_DIR: root, HOME: root, MB_GRAPH_BINARY: join(process.cwd(), ".build", "megabrain"), MB_GRAPH_PID_FILE: pidFile },
    });
    await new Promise<void>((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", (code) => code === 0 ? resolve() : reject(new Error(`graph launcher exited with ${code}`)));
    });
    const pid = Number(await readFile(pidFile, "utf8"));
    const deadline = Date.now() + 2_500;
    let exited = false;
    while (!exited && Date.now() < deadline) {
      try { process.kill(pid, 0); }
      catch (cause: unknown) { exited = cause instanceof Error && "code" in cause && cause.code === "ESRCH"; }
      if (!exited) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!exited) { try { process.kill(pid, "SIGTERM"); } catch { /* already exited */ } }
    expect(exited).toBe(true);
  });
});
