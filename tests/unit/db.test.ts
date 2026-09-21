import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNativeSessionStore } from "../../src/adapters/native-session-store.js";
import { openDatabase, type DatabaseHandle } from "../../src/db/db.js";
import { addNativeSession, listNativeSessions } from "../../src/db/queries/native-sessions.js";
import type { NativeSession } from "../../src/core/native-session.js";

async function withStateDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "megabrain-db-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function database(directory: string): DatabaseHandle {
  const handle = openDatabase({ MEGABRAIN_STATE_DIR: directory });
  if (handle === undefined) throw new Error("database did not open");
  return handle;
}

const firstSession: NativeSession = { udid: "one", bundleId: "com.example.app", sessionId: "first" };
const secondSession: NativeSession = { udid: "two", bundleId: "com.example.app", sessionId: "second" };

describe("SQLite database", () => {
  test("opening a fresh database creates the native sessions schema", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      try {
        expect(handle.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'native_sessions'").all()).toEqual([{ name: "native_sessions" }]);
        expect(listNativeSessions(handle)).toEqual([]);
      } finally {
        handle.close();
      }
    });
  });

  test("opening an already-migrated database preserves its rows", async () => {
    await withStateDirectory(async (directory) => {
      const first = database(directory);
      addNativeSession(first, firstSession);
      first.close();

      const second = database(directory);
      try {
        expect(listNativeSessions(second)).toEqual([firstSession]);
      } finally {
        second.close();
      }
    });
  });

  test("imports the JSON backup exactly once", async () => {
    await withStateDirectory(async (directory) => {
      const jsonPath = join(directory, "native-sessions.json");
      const backup = `${JSON.stringify({ version: 1, sessions: [firstSession] })}\n`;
      await writeFile(jsonPath, backup);

      const first = database(directory);
      try {
        expect(listNativeSessions(first)).toEqual([firstSession]);
        addNativeSession(first, secondSession);
      } finally {
        first.close();
      }

      const second = database(directory);
      try {
        expect(listNativeSessions(second)).toEqual([firstSession, secondSession]);
        expect(await readFile(jsonPath, "utf8")).toBe(backup);
      } finally {
        second.close();
      }
    });
  });

  test("a second independently opened handle reads a store write", async () => {
    await withStateDirectory(async (directory) => {
      const store = createNativeSessionStore({ MEGABRAIN_STATE_DIR: directory });
      expect(store.available).toBe(true);
      const result = await store.update(async (sessions) => ({ sessions: [...sessions, firstSession], value: "written" }));
      expect(result).toEqual({ kind: "ok", value: "written" });

      const second = database(directory);
      try {
        expect(listNativeSessions(second)).toEqual([firstSession]);
      } finally {
        second.close();
      }
    });
  });

  test("concurrent handles both write without losing an update", async () => {
    await withStateDirectory(async (directory) => {
      const first = createNativeSessionStore({ MEGABRAIN_STATE_DIR: directory });
      const second = createNativeSessionStore({ MEGABRAIN_STATE_DIR: directory });
      const results = await Promise.all([
        first.update(async (sessions) => ({ sessions: [...sessions, firstSession], value: undefined })),
        second.update(async (sessions) => ({ sessions: [...sessions, secondSession], value: undefined })),
      ]);
      expect(results.every((result) => result.kind === "ok")).toBe(true);

      const handle = database(directory);
      try {
        expect(listNativeSessions(handle)).toHaveLength(2);
        expect(listNativeSessions(handle)).toEqual(expect.arrayContaining([firstSession, secondSession]));
      } finally {
        handle.close();
      }
    });
  });

  test("an unresolvable state directory is unavailable without throwing", async () => {
    await withStateDirectory(async (directory) => {
      const store = createNativeSessionStore({ MEGABRAIN_STATE_DIR: "", HOME: directory });
      expect(store.available).toBe(false);
      expect(store.path).toBeUndefined();
      await expect(store.update(async (sessions) => ({ sessions, value: undefined }))).resolves.toEqual({
        kind: "failed",
        error: "native session store has no resolvable state directory",
        exitCode: 1,
      });
    });
  });
});
