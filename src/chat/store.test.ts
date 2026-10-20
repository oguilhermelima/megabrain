import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./store.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("legacy mode and owner values are ignored when reading a chat", async () => {
  const state = mkdtempSync(join(tmpdir(), "megabrain-chat-store-"));
  directories.push(state);
  const store = new ChatStore(state);
  const id = "3b1f0c52-8f5e-4d1e-9a55-0d3f2b6a1e33";
  const chat = { id, agent: "claude", model: null, cwd: "/work", title: null, state: "idle", mode: "terminal", owner: "terminal", agentSessionId: null, createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: null };
  const directory = store.dir(id);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "chat.json"), JSON.stringify(chat));

  const loaded = await store.get(id);
  expect(loaded?.mode).toBe("chat");
  expect(loaded).not.toHaveProperty("owner");
});

test("writing a chat never persists legacy mode or owner values", async () => {
  const state = mkdtempSync(join(tmpdir(), "megabrain-chat-store-"));
  directories.push(state);
  const store = new ChatStore(state);
  const chat = { id: "3b1f0c52-8f5e-4d1e-9a55-0d3f2b6a1e33", agent: "claude", model: null, cwd: "/work", title: null, state: "idle", mode: "terminal", owner: "terminal", agentSessionId: null, createdAt: "2026-10-16T09:00:00.000Z", lastActivityAt: null };
  await store.put(chat as never);
  const stored = JSON.parse(readFileSync(join(store.dir(chat.id), "chat.json"), "utf8")) as Record<string, unknown>;
  expect(stored).not.toHaveProperty("mode");
  expect(stored).not.toHaveProperty("owner");
});
