import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import nativeSessionsMigration from "./schema/001-native-sessions.sql" with { type: "text" };
import { importNativeSessions } from "./queries/native-sessions.js";
import { resolveStateDirectory, type StateEnvironment } from "../core/state.js";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;

type Migration = Readonly<{ version: number; sql: string }>;

type SqlValue = string | number | bigint | null | Uint8Array;
type DatabaseAdapter = Readonly<{
  run(sql: string, parameters?: readonly SqlValue[]): void;
  query<T>(sql: string): Readonly<{
    all(): T[];
    get(...parameters: SqlValue[]): T | null;
  }>;
  close(): void;
}>;

type BunDatabase = Readonly<{
  run(sql: string, parameters?: readonly SqlValue[]): void;
  query(sql: string): Readonly<{
    all(): unknown[];
    get(...parameters: SqlValue[]): unknown;
  }>;
  close(): void;
}>;

type NodeDatabase = Readonly<{
  exec(sql: string): void;
  prepare(sql: string): Readonly<{
    all(...parameters: SqlValue[]): unknown[];
    get(...parameters: SqlValue[]): unknown;
    run(...parameters: SqlValue[]): unknown;
  }>;
  close(): void;
}>;

const SQLITE_WARNING = "SQLite is an experimental feature and might change at any time";

function openRuntimeDatabase(path: string): DatabaseAdapter {
  const require = createRequire(import.meta.url);
  if (process.versions.bun !== undefined) {
    const { Database } = require("bun:sqlite") as { readonly Database: new (path: string) => BunDatabase };
    const database = new Database(path);
    return {
      run: (sql, parameters) => {
        if (parameters === undefined) database.run(sql);
        else database.run(sql, parameters);
      },
      query: <T>(sql: string) => {
        const statement = database.query(sql);
        return {
          all: () => statement.all() as T[],
          get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null,
        };
      },
      close: () => database.close(),
    };
  }

  const originalEmitWarning = process.emitWarning;
  let sqlite: { readonly DatabaseSync: new (path: string) => NodeDatabase };
  try {
    process.emitWarning = ((warning: unknown, ...args: unknown[]): void => {
      const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : undefined;
      const options = args[0];
      const type = typeof options === "string"
        ? options
        : typeof options === "object" && options !== null && "type" in options
          ? options.type
          : undefined;
      if (type === "ExperimentalWarning" && message === SQLITE_WARNING) return;
      Reflect.apply(originalEmitWarning, process, [warning, ...args]);
    }) as typeof process.emitWarning;
    sqlite = require("node:sqlite") as typeof sqlite;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  const { DatabaseSync } = sqlite;
  const database = new DatabaseSync(path);
  return {
    run: (sql, parameters) => {
      if (parameters === undefined) database.exec(sql);
      else database.prepare(sql).run(...parameters);
    },
    query: <T>(sql: string) => {
      const statement = database.prepare(sql);
      return {
        all: () => statement.all() as T[],
        get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null,
      };
    },
    close: () => database.close(),
  };
}

const migrations: readonly Migration[] = [
  { version: 1, sql: nativeSessionsMigration },
];

export type DatabaseHandle = Readonly<{
  readonly path: string;
  readonly db: DatabaseAdapter;
  close(): void;
}>;

function migrate(db: DatabaseAdapter): void {
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(db.query<{ version: number }>("SELECT version FROM schema_migrations").all().map((row) => row.version));
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      db.run(migration.sql);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [migration.version, new Date().toISOString()]);
    }
    db.run("COMMIT");
  } catch (cause: unknown) {
    try { db.run("ROLLBACK"); } catch { /* preserve the migration failure */ }
    throw cause;
  }
}

export function openDatabase(environment: StateEnvironment): DatabaseHandle | undefined {
  const configuredStateDirectory = environment.MEGABRAIN_STATE_DIR ?? environment.HOME;
  if (configuredStateDirectory === undefined || configuredStateDirectory === "") return undefined;

  const stateDirectory = resolve(resolveStateDirectory(environment));
  const path = resolve(stateDirectory, "megabrain.db");
  let db: DatabaseAdapter | undefined;
  try {
    mkdirSync(stateDirectory, { recursive: true });
    db = openRuntimeDatabase(path);
    migrate(db);
    const handle: DatabaseHandle = { path, db, close: () => db?.close() };
    importNativeSessions(handle, resolve(stateDirectory, "native-sessions.json"));
    return handle;
  } catch {
    db?.close();
    return undefined;
  }
}
