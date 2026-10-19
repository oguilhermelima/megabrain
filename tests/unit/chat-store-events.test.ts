import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "../../src/chat/store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("reads only chat events after a known cursor", async () => {
  const state = mkdtempSync(join(tmpdir(), "megabrain-chat-events-"));
  roots.push(state);
  const store = new ChatStore(state);
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  mkdirSync(join(state, "chats", id), { recursive: true });
  for (let index = 0; index < 100; index += 1) await store.append(id, { id: `event-${index}`, at: "2026-10-17T12:00:00.000Z", kind: "system", text: `event ${index}` });
  const path = join(state, "chats", id, "events.jsonl");
  await store.events(id);
  await store.append(id, { id: "event-100", at: "2026-10-17T12:00:00.000Z", kind: "system", text: "event 100" });
  await store.append(id, { id: "event-101", at: "2026-10-17T12:00:00.000Z", kind: "system", text: "event 101" });

  const spy = spyOn(fsPromises, "readFile");
  try {
    const rows = await store.events(id, 100);
    expect(rows.map((row) => row.cursor)).toEqual(["101", "102"]);
    expect(spy.mock.calls.filter(([file]) => file === path)).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

test("bounds per-chat event and turn caches without losing cursors", async () => {
  const state = mkdtempSync(join(tmpdir(), "megabrain-chat-cache-"));
  roots.push(state);
  const store = new ChatStore(state);
  const cached = store as unknown as { counts: Map<string, number>; turnIds: Map<string, Map<string, string>>; lastUsers: Map<string, string> };
  for (let index = 0; index < 300; index += 1) {
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`;
    mkdirSync(join(state, "chats", id), { recursive: true });
    await store.append(id, { id: `user-${index}`, at: "2026-10-17T12:00:00.000Z", kind: "user", text: "hello", turnId: `turn-${index}` });
  }
  expect(cached.counts.size).toBeLessThanOrEqual(128);
  expect(cached.turnIds.size).toBeLessThanOrEqual(128);
  expect(cached.lastUsers.size).toBeLessThanOrEqual(128);
  expect((await store.append("aaaaaaaa-aaaa-4aaa-8aaa-000000000000", { id: "next", at: "2026-10-17T12:01:00.000Z", kind: "system", text: "next" })).cursor).toBe("2");
});
