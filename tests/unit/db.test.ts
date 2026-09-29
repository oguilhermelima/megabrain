import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { route } from "../../src/cli/router.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { createNativeSessionStore } from "../../src/adapters/native-session-store.js";
import { latestSchemaVersion, openDatabase, readSnapshot, withWrite, type DatabaseHandle } from "../../src/db/db.js";
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
  if (handle.kind !== "ok") throw new Error(handle.error);
  return handle.value;
}

function rawDatabase(directory: string): Database {
  return new Database(join(directory, "megabrain.db"));
}

const processAdapter = { run: async () => ({ kind: "ok", value: { stdout: "", stderr: "", exitCode: 0 } }) } as ProcessAdapter;

const firstSession: NativeSession = { udid: "one", bundleId: "com.example.app", sessionId: "first" };
const secondSession: NativeSession = { udid: "two", bundleId: "com.example.app", sessionId: "second" };

describe("SQLite database", () => {
  test("fresh databases use the required pragmas and initialize their identity and version", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      try {
        expect(handle.db.query<{ journal_mode: string }>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
        expect(handle.db.query<{ synchronous: number }>("PRAGMA synchronous").get()?.synchronous).toBe(1);
        expect(handle.db.query<{ foreign_keys: number }>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
        expect(handle.db.query<{ application_id: number }>("PRAGMA application_id").get()?.application_id).toBeGreaterThan(0);
        expect(handle.db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(latestSchemaVersion);
      } finally {
        handle.close();
      }
    });
  });

  test("refuses a foreign application id and a schema newer than this binary", async () => {
    await withStateDirectory(async (directory) => {
      const raw = rawDatabase(directory);
      raw.exec("PRAGMA application_id = 123456");
      raw.close();
      const foreign = openDatabase({ MEGABRAIN_STATE_DIR: directory });
      expect(foreign.kind).toBe("failed");
      if (foreign.kind === "failed") expect(foreign.error).toContain("application_id");
    });
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      handle.close();
      const raw = rawDatabase(directory);
      raw.exec("PRAGMA user_version = 77");
      raw.close();
      const newer = openDatabase({ MEGABRAIN_STATE_DIR: directory });
      expect(newer.kind).toBe("failed");
      if (newer.kind === "failed") {
        expect(newer.error).toContain("77");
        expect(newer.error).toContain(String(latestSchemaVersion));
        expect(newer.error).toContain("upgrade megabrain");
      }
    });
  });

  test("open, pragma and migration errors return a step-specific failure", async () => {
    await withStateDirectory(async (directory) => {
      const file = join(directory, "megabrain.db");
      await writeFile(file, "not a sqlite database");
      const result = openDatabase({ MEGABRAIN_STATE_DIR: directory });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toMatch(/open|pragma/i);
    });
    await withStateDirectory(async (directory) => {
      const raw = rawDatabase(directory);
      raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      raw.exec("CREATE TABLE native_sessions (invalid TEXT)");
      raw.exec("INSERT INTO schema_migrations VALUES (0, 'test')");
      raw.close();
      const result = openDatabase({ MEGABRAIN_STATE_DIR: directory });
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toContain("migrate");
    });
  });

  test("backs up an existing database before a pending migration and not a fresh database", async () => {
    await withStateDirectory(async (directory) => {
      const fresh = database(directory);
      fresh.close();
      expect((await readdir(join(directory, "backups")).catch(() => [])).length).toBe(0);
    });
    await withStateDirectory(async (directory) => {
      const raw = rawDatabase(directory);
      raw.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      raw.exec("INSERT INTO schema_migrations VALUES (0, 'baseline')");
      raw.close();
      const migrated = database(directory);
      migrated.close();
      const backups = await readdir(join(directory, "backups"));
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatch(/megabrain-.*-v0\.db/);
    });
  });

  test("backup rotation retains only the newest seven files", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      handle.close();
      const backupDirectory = join(directory, "backups");
      await mkdir(backupDirectory, { recursive: true });
      for (let index = 0; index < 9; index += 1) {
        const stamp = `20260929T00000${index}Z`;
        await writeFile(join(backupDirectory, `megabrain-${stamp}-v1.db`), "old backup");
      }
      const opened = database(directory);
      const result = await import("../../src/db/db.js").then(({ backupDatabase }) => backupDatabase(opened));
      expect(result.kind).toBe("ok");
      expect(await readdir(backupDirectory)).toHaveLength(7);
      opened.close();
    });
  });

  test("withWrite commits, rolls back on throw, rejects thenables and nesting", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      try {
        handle.db.run("CREATE TABLE counter (value INTEGER NOT NULL)");
        handle.db.run("INSERT INTO counter VALUES (0)");
        expect(withWrite(handle, (db) => { db.run("UPDATE counter SET value = value + 1"); })).toEqual({ kind: "ok", value: undefined });
        expect(withWrite(handle, (db) => { db.run("UPDATE counter SET value = value + 1"); throw new Error("rollback me"); }).kind).toBe("failed");
        const asyncResult = withWrite(handle, (() => Promise.resolve("late")) as () => unknown);
        expect(asyncResult.kind).toBe("failed");
        expect(asyncResult.kind === "failed" ? asyncResult.error : "").toContain("synchronous");
        const nested = withWrite(handle, () => withWrite(handle, () => "inner"));
        expect(nested.kind).toBe("failed");
        expect(handle.db.query<{ value: number }>("SELECT value FROM counter").get()?.value).toBe(1);
      } finally {
        handle.close();
      }
    });
  });

  test("withWrite serializes 4,000 writes across eight OS processes", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      handle.db.run("CREATE TABLE stress_counter (value INTEGER NOT NULL)");
      handle.db.run("INSERT INTO stress_counter VALUES (0)");
      handle.db.run("CREATE TABLE stress_rows (id INTEGER PRIMARY KEY)");
      handle.close();
      const moduleUrl = new URL("../../src/db/db.ts", import.meta.url).href;
      const script = `const { openDatabase, withWrite } = await import(${JSON.stringify(moduleUrl)}); const result = openDatabase({ MEGABRAIN_STATE_DIR: process.argv[1] }); if (result.kind !== "ok") throw new Error(result.error); for (let i = 0; i < 500; i++) { const written = withWrite(result.value, db => { db.run("UPDATE stress_counter SET value = value + 1"); db.run("INSERT INTO stress_rows DEFAULT VALUES"); }); if (written.kind !== "ok") throw new Error(written.error); } result.value.close();`;
      const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, "-e", script, directory], { stdout: "pipe", stderr: "pipe" }));
      const exits = await Promise.all(children.map(async (child) => ({ code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
      expect(exits.every(({ code }) => code === 0)).toBe(true);
      expect(exits.filter(({ stderr }) => /busy/i.test(stderr))).toHaveLength(0);
      const verified = database(directory);
      try {
        expect(verified.db.query<{ value: number }>("SELECT value FROM stress_counter").get()?.value).toBe(4000);
        expect(verified.db.query<{ count: number }>("SELECT count(*) AS count FROM stress_rows").get()?.count).toBe(4000);
      } finally {
        verified.close();
      }
    });
  }, 120_000);

  test("withWrite reports a clean busy timeout", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      handle.close();
      const blocker = rawDatabase(directory);
      const childScript = `const { openDatabase, withWrite } = await import(${JSON.stringify(new URL("../../src/db/db.ts", import.meta.url).href)}); const result = openDatabase({ MEGABRAIN_STATE_DIR: process.argv[1] }); if (result.kind !== "ok") throw new Error(result.error); const write = withWrite(result.value, db => db.run("CREATE TABLE never_written (id INTEGER)")); console.log(JSON.stringify(write)); result.value.close();`;
      const delayedScript = childScript.replace("const write = withWrite", 'console.log("ready"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); const write = withWrite');
      const child = Bun.spawn([process.execPath, "-e", delayedScript, directory], { env: { ...process.env, MEGABRAIN_DB_BUSY_SECONDS: "0.05" }, stdout: "pipe", stderr: "pipe" });
      const reader = child.stdout.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain("ready");
      blocker.exec("BEGIN IMMEDIATE");
      const outputChunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        outputChunks.push(chunk.value);
      }
      const output = new TextDecoder().decode(Buffer.concat(outputChunks));
      await child.exited;
      setTimeout(() => blocker.exec("ROLLBACK"), 1_000);
      await new Promise((resolve) => setTimeout(resolve, 1_010));
      blocker.close();
      expect(output).toContain("busy");
    });
  });

  test("readSnapshot retains a consistent view while another handle commits", async () => {
    await withStateDirectory(async (directory) => {
      const first = database(directory);
      first.db.run("CREATE TABLE snapshot_values (value INTEGER NOT NULL)");
      first.db.run("INSERT INTO snapshot_values VALUES (1)");
      const second = database(directory);
      try {
        const snapshot = readSnapshot(first, (db) => {
          const before = db.query<{ value: number }>("SELECT value FROM snapshot_values").get()?.value;
          const committed = withWrite(second, (writer) => writer.run("UPDATE snapshot_values SET value = 2"));
          const after = db.query<{ value: number }>("SELECT value FROM snapshot_values").get()?.value;
          return { before, after, committed: committed.kind };
        });
        expect(snapshot).toEqual({ kind: "ok", value: { before: 1, after: 1, committed: "ok" } });
        expect(second.db.query<{ value: number }>("SELECT value FROM snapshot_values").get()?.value).toBe(2);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  test("db check reports clean and foreign-key-corrupt databases; backup is reopenable", async () => {
    await withStateDirectory(async (directory) => {
      const handle = database(directory);
      try {
        handle.db.run("CREATE TABLE parents (id INTEGER PRIMARY KEY)");
        handle.db.run("CREATE TABLE children (parent_id INTEGER REFERENCES parents(id))");
      } finally {
        handle.close();
      }
      const clean = await route(["db", "check", "--json"], { environment: { MEGABRAIN_STATE_DIR: directory }, processAdapter });
      expect(clean.kind).toBe("ok");
      if (clean.kind === "ok") expect(clean.value).toContain("ok");
      const raw = rawDatabase(directory);
      raw.exec("PRAGMA foreign_keys = OFF; INSERT INTO children VALUES (99)");
      raw.close();
      const corrupt = await route(["db", "check", "--json"], { environment: { MEGABRAIN_STATE_DIR: directory }, processAdapter });
      expect(corrupt.kind).toBe("ok");
      if (corrupt.kind === "ok") {
        const report = JSON.parse(corrupt.value) as { foreignKeyViolations: unknown[]; clean: boolean };
        expect(report.foreignKeyViolations).toHaveLength(1);
        expect(report.clean).toBe(false);
        expect(corrupt.exitCode).toBe(1);
      }
      const backupResult = await route(["db", "backup", "--json"], { environment: { MEGABRAIN_STATE_DIR: directory }, processAdapter });
      expect(backupResult.kind).toBe("ok");
      const backupPath = backupResult.kind === "ok" ? (JSON.parse(backupResult.value) as { path: string }).path : "";
      const backup = new Database(backupPath);
      expect(backup.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      backup.close();
    });
  });

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
      const result = store.update((sessions) => ({ sessions: [...sessions, firstSession], value: "written" }));
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
        first.update((sessions) => ({ sessions: [...sessions, firstSession], value: undefined })),
        second.update((sessions) => ({ sessions: [...sessions, secondSession], value: undefined })),
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
      expect(store.update((sessions) => ({ sessions, value: undefined }))).toEqual({
        kind: "failed",
        error: "native session store has no resolvable state directory",
        exitCode: 1,
      });
    });
  });
});
