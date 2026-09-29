import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import nativeSessionsMigration from "./schema/001-native-sessions.sql" with { type: "text" };
import { importNativeSessions } from "./queries/native-sessions.js";
import { failed, ok, type Result } from "../core/result.js";
import { resolveStateDirectory, type StateEnvironment } from "../core/state.js";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_BUSY_SECONDS = 30;
const APPLICATION_ID = 0x4d424431; // ASCII "MBD1", reserved for the megabrain database.

type Migration = Readonly<{ version: number; sql: string }>;
type SqlValue = string | number | bigint | null | Uint8Array;
export type RunResult = Readonly<{ changes: number; lastInsertRowid: number | bigint }>;
export type DatabaseAdapter = Readonly<{
  run(sql: string, parameters?: readonly SqlValue[]): RunResult;
  exec(sql: string): void;
  query<T>(sql: string): Readonly<{
    all(): T[];
    get(...parameters: SqlValue[]): T | null;
    run(...parameters: SqlValue[]): RunResult;
  }>;
  close(): void;
}>;

type BunStatement = Readonly<{
  all(...parameters: SqlValue[]): unknown[];
  get(...parameters: SqlValue[]): unknown;
  run(...parameters: SqlValue[]): RunResult;
}>;
type BunDatabase = Readonly<{
  query(sql: string): BunStatement;
  exec(sql: string): void;
  close(): void;
}>;
type NodeStatement = Readonly<{
  all(...parameters: SqlValue[]): unknown[];
  get(...parameters: SqlValue[]): unknown;
  run(...parameters: SqlValue[]): RunResult;
}>;
type NodeDatabase = Readonly<{
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  close(): void;
}>;

const SQLITE_WARNING = "SQLite is an experimental feature and might change at any time";

function openRuntimeDatabase(path: string): DatabaseAdapter {
  const require = createRequire(import.meta.url);
  if (process.versions.bun !== undefined) {
    const { Database } = require("bun:sqlite") as { readonly Database: new (path: string) => BunDatabase };
    const database = new Database(path);
    return {
      run: (sql, parameters) => database.query(sql).run(...(parameters ?? [])),
      exec: (sql) => database.exec(sql),
      query: <T>(sql: string) => {
        const statement = database.query(sql);
        return {
          all: () => statement.all() as T[],
          get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null,
          run: (...parameters: SqlValue[]) => statement.run(...parameters),
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
    run: (sql, parameters) => database.prepare(sql).run(...(parameters ?? [])),
    exec: (sql) => database.exec(sql),
    query: <T>(sql: string) => {
      const statement = database.prepare(sql);
      return {
        all: () => statement.all() as T[],
        get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null,
        run: (...parameters: SqlValue[]) => statement.run(...parameters),
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

export type DatabaseIntegrityReport = Readonly<{
  path: string;
  userVersion: number;
  quickCheck: readonly string[];
  foreignKeyViolations: readonly Record<string, unknown>[];
  clean: boolean;
}>;

type NotThenable<T> = T extends PromiseLike<unknown> ? never : T;
type Synchronous<T> = (db: DatabaseAdapter) => NotThenable<T>;
const activeTransactions = new WeakSet<DatabaseHandle>();

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failAt(step: string, cause: unknown): never {
  throw new Error(`${step} failed: ${errorMessage(cause)}`, { cause });
}

function pragmaNumber(db: DatabaseAdapter, name: string): number {
  const row = db.query<Record<string, number>>(`PRAGMA ${name}`).get();
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`PRAGMA ${name} returned an invalid value`);
  return value;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupToDirectory(db: DatabaseAdapter, stateDirectory: string, version: number): Result<string> {
  const backupDirectory = resolve(stateDirectory, "backups");
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const path = resolve(backupDirectory, `megabrain-${timestamp}-v${version}.db`);
  try {
    mkdirSync(backupDirectory, { recursive: true });
    db.exec(`VACUUM INTO ${quoteSqlString(path)}`);
    const backups = readdirSync(backupDirectory)
      .filter((name) => /^megabrain-.*-v\d+\.db$/.test(name))
      .sort((left, right) => right.localeCompare(left));
    for (const old of backups.slice(7)) unlinkSync(resolve(backupDirectory, old));
    return ok(path);
  } catch (cause: unknown) {
    return failed(`backup failed: ${errorMessage(cause)}`);
  }
}

export function backupDatabase(handle: DatabaseHandle): Result<string> {
  try {
    return backupToDirectory(handle.db, dirname(handle.path), pragmaNumber(handle.db, "user_version"));
  } catch (cause: unknown) {
    return failed(`backup failed: ${errorMessage(cause)}`);
  }
}

export function inspectDatabase(environment: StateEnvironment): Result<DatabaseIntegrityReport | undefined> {
  let path: string;
  try {
    const configured = environment.MEGABRAIN_STATE_DIR ?? environment.HOME;
    if (configured === undefined || configured === "") return failed("resolve failed: no state directory is configured");
    path = resolve(resolveStateDirectory(environment), "megabrain.db");
  } catch (cause: unknown) {
    return failed(`resolve failed: ${errorMessage(cause)}`);
  }
  if (!existsSync(path)) return ok(undefined);
  let db: DatabaseAdapter | undefined;
  try {
    db = openRuntimeDatabase(path);
    const quickCheck = db.query<{ quick_check: string }>("PRAGMA quick_check").all().map((row) => row.quick_check);
    const foreignKeyViolations = db.query<Record<string, unknown>>("PRAGMA foreign_key_check").all();
    const userVersion = pragmaNumber(db, "user_version");
    return ok({ path, userVersion, quickCheck, foreignKeyViolations, clean: quickCheck.length === 1 && quickCheck[0] === "ok" && foreignKeyViolations.length === 0 });
  } catch (cause: unknown) {
    return failed(`database check failed: ${errorMessage(cause)}`);
  } finally {
    try { db?.close(); } catch { /* preserve the integrity result */ }
  }
}

function migrate(db: DatabaseAdapter, path: string): void {
  try {
    const migrationTable = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (migrationTable !== null) {
      const applied = db.query<{ version: number }>("SELECT version FROM schema_migrations").all();
      const appliedVersions = new Set(applied.map((row) => row.version));
      const pending = migrations.some((migration) => !appliedVersions.has(migration.version));
      if (pending && applied.length > 0) {
        const version = Math.max(...applied.map((row) => row.version));
        const backup = backupToDirectory(db, dirname(path), version);
        if (backup.kind !== "ok") throw new Error(backup.error);
      }
    }
    db.run("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const applied = new Set(db.query<{ version: number }>("SELECT version FROM schema_migrations").all().map((row) => row.version));
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        db.exec(migration.sql);
        db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [migration.version, new Date().toISOString()]);
      }
      const highest = migrations.at(-1)?.version ?? 0;
      db.exec(`PRAGMA user_version = ${highest}`);
      db.run("COMMIT");
    } catch (cause: unknown) {
      try { db.run("ROLLBACK"); } catch { /* preserve the migration failure */ }
      throw cause;
    }
  } catch (cause: unknown) {
    failAt("migrate", cause);
  }
}

function configureConnection(db: DatabaseAdapter): void {
  try { db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`); }
  catch (cause: unknown) { failAt("pragma busy_timeout", cause); }
  try { db.exec("PRAGMA journal_mode = WAL"); }
  catch (cause: unknown) { failAt("pragma journal_mode", cause); }
  try { db.exec("PRAGMA synchronous = NORMAL"); }
  catch (cause: unknown) { failAt("pragma synchronous", cause); }
  try { db.exec("PRAGMA foreign_keys = ON"); }
  catch (cause: unknown) { failAt("pragma foreign_keys", cause); }

  try {
    const applicationId = pragmaNumber(db, "application_id");
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
      throw new Error(`database application_id ${applicationId} belongs to another application (expected ${APPLICATION_ID})`);
    }
    if (applicationId === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
  } catch (cause: unknown) { failAt("version guard application_id", cause); }

  try {
    const actual = pragmaNumber(db, "user_version");
    const highest = migrations.at(-1)?.version ?? 0;
    if (actual > highest) throw new Error(`database user_version ${actual} is newer than this binary supports (${highest}); upgrade megabrain`);
    const hasMigrationTable = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() !== null;
    if (hasMigrationTable) {
      const applied = db.query<{ version: number }>("SELECT max(version) AS version FROM schema_migrations").get()?.version ?? 0;
      if (applied > highest) throw new Error(`database migration version ${applied} is newer than this binary supports (${highest}); upgrade megabrain`);
    }
  } catch (cause: unknown) { failAt("version guard user_version", cause); }
}

export function openDatabase(environment: StateEnvironment): Result<DatabaseHandle> {
  let configuredStateDirectory: string;
  try {
    const configured = environment.MEGABRAIN_STATE_DIR ?? environment.HOME;
    if (configured === undefined || configured === "") return failed("resolve failed: no state directory is configured");
    configuredStateDirectory = resolve(resolveStateDirectory(environment));
  } catch (cause: unknown) {
    return failed(`resolve failed: ${errorMessage(cause)}`);
  }

  const path = resolve(configuredStateDirectory, "megabrain.db");
  let db: DatabaseAdapter | undefined;
  try {
    mkdirSync(configuredStateDirectory, { recursive: true });
  } catch (cause: unknown) {
    return failed(`resolve failed: ${errorMessage(cause)}`);
  }
  try {
    db = openRuntimeDatabase(path);
  } catch (cause: unknown) {
    return failed(`open failed: ${errorMessage(cause)}`);
  }

  try {
    configureConnection(db);
    migrate(db, path);
    const handle: DatabaseHandle = { path, db, close: () => db?.close() };
    try {
      importNativeSessions(handle, resolve(configuredStateDirectory, "native-sessions.json"));
    } catch (cause: unknown) { failAt("import", cause); }
    return ok(handle);
  } catch (cause: unknown) {
    try { db.close(); } catch { /* preserve the open failure */ }
    return failed(errorMessage(cause));
  }
}

function isBusy(cause: unknown): boolean {
  const message = errorMessage(cause).toLowerCase();
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code).toUpperCase() : "";
  return code.includes("SQLITE_BUSY") || code.includes("SQLITE_LOCKED") || /database is (?:locked|busy)|sqlite_busy|sqlite_locked/.test(message);
}

function busySeconds(): number {
  const value = process.env.MEGABRAIN_DB_BUSY_SECONDS;
  if (value === undefined) return DEFAULT_BUSY_SECONDS;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_BUSY_SECONDS;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryDelay(attempt: number, remaining: number): number {
  const exponential = Math.min(250, 10 * (2 ** Math.min(attempt, 5)));
  const jittered = Math.floor(exponential * (0.5 + Math.random()));
  return Math.max(0, Math.min(jittered, remaining));
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" && value !== null || typeof value === "function") && "then" in value;
}

function transaction<T>(handle: DatabaseHandle, begin: "IMMEDIATE" | "DEFERRED", fn: (db: DatabaseAdapter) => T): Result<T> {
  if (activeTransactions.has(handle)) throw new Error("nested database transactions on the same handle are not allowed");
  activeTransactions.add(handle);
  const budget = busySeconds() * 1000;
  const deadline = Date.now() + budget;
  let attempt = 0;
  try {
    while (true) {
      try {
        const remaining = Math.max(0, deadline - Date.now());
        handle.db.exec(`PRAGMA busy_timeout = ${Math.min(BUSY_TIMEOUT_MILLISECONDS, remaining)}`);
        handle.db.run(begin === "IMMEDIATE" ? "BEGIN IMMEDIATE" : "BEGIN");
      } catch (cause: unknown) {
        if (!isBusy(cause)) return failed(`${begin === "IMMEDIATE" ? "write" : "read"} transaction begin failed: ${errorMessage(cause)}`);
        const remaining = deadline - Date.now();
        if (remaining <= 0) return failed(`database is busy after ${busySeconds()} seconds`);
        sleep(retryDelay(attempt++, remaining));
        continue;
      }

      try {
        const value = fn(handle.db);
        if (isThenable(value)) {
          try { handle.db.run("ROLLBACK"); } catch { /* preserve the synchronous-only error */ }
          return failed("database transactions must be synchronous");
        }
        while (true) {
          try {
            handle.db.run("COMMIT");
            return ok(value);
          } catch (cause: unknown) {
            if (!isBusy(cause)) {
              try { handle.db.run("ROLLBACK"); } catch { /* preserve the commit failure */ }
              return failed(`database transaction commit failed: ${errorMessage(cause)}`);
            }
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              try { handle.db.run("ROLLBACK"); } catch { /* preserve the busy failure */ }
              return failed(`database is busy after ${busySeconds()} seconds`);
            }
            sleep(retryDelay(attempt++, remaining));
          }
        }
      } catch (cause: unknown) {
        try { handle.db.run("ROLLBACK"); } catch { /* preserve the callback failure */ }
        if (isBusy(cause)) {
          const remaining = deadline - Date.now();
          if (remaining > 0) {
            sleep(retryDelay(attempt++, remaining));
            continue;
          }
          return failed(`database is busy after ${busySeconds()} seconds`);
        }
        return failed(`database transaction failed: ${errorMessage(cause)}`);
      }
    }
  } finally {
    try { handle.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`); } catch { /* keep the transaction result */ }
    activeTransactions.delete(handle);
  }
}

export function withWrite<T>(handle: DatabaseHandle, fn: Synchronous<T>): Result<T> {
  return transaction(handle, "IMMEDIATE", fn as (db: DatabaseAdapter) => T);
}

export function readSnapshot<T>(handle: DatabaseHandle, fn: Synchronous<T>): Result<T> {
  return transaction(handle, "DEFERRED", fn as (db: DatabaseAdapter) => T);
}
