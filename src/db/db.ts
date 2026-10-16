import { chmodSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import nativeSessionsMigration from "./schema/001-native-sessions.sql" with { type: "text" };
import dispatchCoreMigration from "./schema/002-dispatch-core.sql" with { type: "text" };
import stateFacadeMigration from "./schema/003-waiters-outbox-detail.sql" with { type: "text" };
import cutoverSettingsMigration from "./schema/004-cutover-settings.sql" with { type: "text" };
import nativeDeliveryMigration from "./schema/005-native-delivery.sql" with { type: "text" };
import chatNamesMigration from "./schema/006-chat-names.sql" with { type: "text" };
import chatNameSourceMigration from "./schema/007-chat-name-source.sql" with { type: "text" };
import worktreesMigration from "./schema/008-worktrees.sql" with { type: "text" };
import stackParentMigration from "./schema/009-stack-parent.sql" with { type: "text" };
import resourceSamplesMigration from "./schema/010-resource-samples.sql" with { type: "text" };
import queueCancellationMigration from "./schema/011-queue-cancellation.sql" with { type: "text" };
import admissionQueueMigration from "./schema/012-admission-queue.sql" with { type: "text" };
import deliveryChannelsMigration from "./schema/013-delivery-channels.sql" with { type: "text" };
import repositoriesMigration from "./schema/014-repositories.sql" with { type: "text" };
import repositoryPullRequestsMigration from "./schema/015-repository-pull-requests.sql" with { type: "text" };
import hiddenItemsMigration from "./schema/016-hidden-items.sql" with { type: "text" };
import { importNativeSessions } from "./queries/native-sessions.js";
import { failed, ok, type Result } from "../core/result.js";
import { resolveStateDirectory, type StateEnvironment } from "../core/state.js";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_BUSY_SECONDS = 30;
const APPLICATION_ID = 0x4d424431; // ASCII "MBD1", reserved for the megabrain database.

type Migration = Readonly<{ version: number; sql: string; foreignKeysOff?: boolean }>;
type SqlValue = string | number | bigint | null | Uint8Array;
export type RunResult = Readonly<{ changes: number; lastInsertRowid: number | bigint }>;
export type DatabaseAdapter = Readonly<{
  run(sql: string, parameters?: readonly SqlValue[]): RunResult;
  exec(sql: string): void;
  query<T>(sql: string): Readonly<{
    all(...parameters: SqlValue[]): T[];
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

function openRuntimeDatabase(path: string, readOnly = false): DatabaseAdapter {
  const require = createRequire(import.meta.url);
  if (process.versions.bun !== undefined) {
    const { Database } = require("bun:sqlite") as { readonly Database: new (path: string, options?: Readonly<{ readonly?: boolean }>) => BunDatabase };
    const database = readOnly ? new Database(path, { readonly: true }) : new Database(path);
    return {
      run: (sql, parameters) => database.query(sql).run(...(parameters ?? [])),
      exec: (sql) => database.exec(sql),
      query: <T>(sql: string) => {
        const statement = database.query(sql);
        return {
          all: (...parameters: SqlValue[]) => statement.all(...parameters) as T[],
          get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null,
          run: (...parameters: SqlValue[]) => statement.run(...parameters),
        };
      },
      close: () => database.close(),
    };
  }

  const originalEmitWarning = process.emitWarning;
  let sqlite: { readonly DatabaseSync: new (path: string, options?: Readonly<{ readOnly?: boolean }>) => NodeDatabase };
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
  const database = readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  return {
    run: (sql, parameters) => database.prepare(sql).run(...(parameters ?? [])),
    exec: (sql) => database.exec(sql),
    query: <T>(sql: string) => {
      const statement = database.prepare(sql);
      return {
        all: (...parameters: SqlValue[]) => statement.all(...parameters) as T[],
        get: (...parameters: SqlValue[]) => (statement.get(...parameters) as T | null | undefined) ?? null,
        run: (...parameters: SqlValue[]) => statement.run(...parameters),
      };
    },
    close: () => database.close(),
  };
}

const migrations: readonly Migration[] = [
  { version: 1, sql: nativeSessionsMigration },
  { version: 2, sql: dispatchCoreMigration },
  { version: 3, sql: stateFacadeMigration },
  { version: 4, sql: cutoverSettingsMigration },
  { version: 5, sql: nativeDeliveryMigration },
  { version: 6, sql: chatNamesMigration },
  { version: 7, sql: chatNameSourceMigration },
  { version: 8, sql: worktreesMigration },
  { version: 9, sql: stackParentMigration },
  { version: 10, sql: resourceSamplesMigration },
  { version: 11, sql: queueCancellationMigration },
  { version: 12, sql: admissionQueueMigration, foreignKeysOff: true },
  { version: 13, sql: deliveryChannelsMigration },
  { version: 14, sql: repositoriesMigration },
  { version: 15, sql: repositoryPullRequestsMigration },
  { version: 16, sql: hiddenItemsMigration },
];
export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;

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
export type Synchronous<T> = (db: DatabaseAdapter) => NotThenable<T>;
const activeTransactions = new WeakSet<DatabaseHandle>();

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function failAt(step: string, cause: unknown): never {
  throw new Error(`${step} failed: ${errorMessage(cause)}`, { cause });
}

const numericPragmas = {
  application_id: "PRAGMA application_id",
  user_version: "PRAGMA user_version",
} as const;

function pragmaNumber(db: DatabaseAdapter, name: keyof typeof numericPragmas): number {
  const row = db.query<Record<string, number>>(numericPragmas[name]).get();
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`PRAGMA ${name} returned an invalid value`);
  return value;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function backupToDirectory(db: DatabaseAdapter, stateDirectory: string, version: number, binaryVersion?: string): Result<string> {
  const backupDirectory = resolve(stateDirectory, "backups");
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  const path = resolve(backupDirectory, `megabrain-${timestamp}${binaryVersion === undefined ? "" : `-b${binaryVersion}`}-v${version}.db`);
  try {
    mkdirSync(backupDirectory, { recursive: true });
    db.exec(`VACUUM INTO ${quoteSqlString(path)}`);
    chmodSync(path, 0o600);
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

export function vacuumDatabaseFile(sourcePath: string, targetPath: string): Result<string> {
  let source: DatabaseAdapter | undefined;
  const sourceWal = `${sourcePath}-wal`;
  const sourceShm = `${sourcePath}-shm`;
  const hadSourceWal = existsSync(sourceWal);
  const hadSourceShm = existsSync(sourceShm);
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    source = openRuntimeDatabase(sourcePath, true);
    source.exec(`VACUUM INTO ${quoteSqlString(targetPath)}`);
    chmodSync(targetPath, 0o600);
    return ok(targetPath);
  } catch (cause: unknown) {
    try { unlinkSync(targetPath); } catch { /* target may not have been created */ }
    return failed(`database snapshot failed: ${errorMessage(cause)}`);
  } finally {
    try { source?.close(); } catch { /* preserve the snapshot result */ }
    if (!hadSourceWal) try { unlinkSync(sourceWal); } catch { /* no sidecar was created */ }
    if (!hadSourceShm) try { unlinkSync(sourceShm); } catch { /* no sidecar was created */ }
  }
}

function secureDatabaseFiles(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) chmodSync(file, 0o600);
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

export interface BuildIdentity {
  readonly executablePath: string;
  readonly version: string;
  /** Consent to migrate the default state from a build that is not the installed one. */
  readonly allowMigration?: boolean;
}

function defaultBuild(): BuildIdentity {
  return { executablePath: process.execPath, version: packageJson.version, allowMigration: process.env.MEGABRAIN_ALLOW_MIGRATION === "1" };
}

// WHY: the installed binary and a packaged app own the default state and upgrade it. A run from
// source and an unpackaged sidecar (a development or test build) do not, and a schema they raise
// locks out the installed binary, which cannot downgrade.
function unownedBuildKind(executablePath: string): string | undefined {
  const name = basename(executablePath);
  if (name === "bun" || name === "node") return "source run";
  if (name.startsWith("megabrain-cli") && !executablePath.includes(".app/Contents/MacOS/")) return "development sidecar";
  return undefined;
}

function newerSchemaMessage(db: DatabaseAdapter, path: string, found: string, kind: string): string {
  const backups = resolve(dirname(path), "backups");
  let recorded: { backup_path: string; binary_version: string; binary_path: string } | null = null;
  try {
    recorded = db.query<{ backup_path: string; binary_version: string; binary_path: string }>(
      "SELECT backup_path, binary_version, binary_path FROM migration_backups WHERE from_version <= ? ORDER BY id DESC LIMIT 1",
    ).get(latestSchemaVersion);
  } catch { /* a database no binary recorded a backup for */ }
  const base = `database ${kind} ${found} is newer than this binary supports (${latestSchemaVersion})`;
  if (recorded === null) return `${base}; upgrade megabrain, or restore the newest megabrain-*-v${latestSchemaVersion}.db backup in ${backups} over ${path} while no megabrain process runs`;
  return `${base}; it was migrated by megabrain ${recorded.binary_version} (${recorded.binary_path}). Upgrade megabrain to ${recorded.binary_version} or newer, or restore ${recorded.backup_path} over ${path} while no megabrain process runs`;
}

function migrate(db: DatabaseAdapter, path: string, build: BuildIdentity, defaultState: boolean): void {
  let recordedBackup: { path: string; from: number } | undefined;
  try {
    const migrationTable = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (migrationTable !== null) {
      const applied = db.query<{ version: number }>("SELECT version FROM schema_migrations").all();
      const appliedVersions = new Set(applied.map((row) => row.version));
      const pending = migrations.some((migration) => !appliedVersions.has(migration.version));
      if (pending && applied.length > 0) {
        const version = Math.max(...applied.map((row) => row.version));
        const kind = unownedBuildKind(build.executablePath);
        if (defaultState && kind !== undefined && build.allowMigration !== true) {
          throw new Error(`this ${kind} (${build.executablePath}) would migrate ${path} from schema ${version} to ${latestSchemaVersion}, which locks out the installed megabrain; set MEGABRAIN_ALLOW_MIGRATION=1 to allow it, or point MEGABRAIN_STATE_DIR at a scratch directory`);
        }
        const backup = backupToDirectory(db, dirname(path), version, build.version);
        if (backup.kind !== "ok") throw new Error(backup.error);
        recordedBackup = { path: backup.value, from: version };
      }
    }
    const appliedBefore = new Set(migrationTable === null ? [] : db.query<{ version: number }>("SELECT version FROM schema_migrations").all().map((row) => row.version));
    const pending = migrations.filter((migration) => !appliedBefore.has(migration.version));
    const foreignKeysOff = pending.some((migration) => migration.foreignKeysOff === true);
    if (foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF");
    db.run("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const applied = new Set(db.query<{ version: number }>("SELECT version FROM schema_migrations").all().map((row) => row.version));
      for (const migration of migrations) {
        if (applied.has(migration.version)) continue;
        db.exec(migration.sql);
        db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [migration.version, new Date().toISOString()]);
      }
      if (foreignKeysOff) {
        const violations = db.query<{ table: string; rowid: number; parent: string; fkid: number }>("PRAGMA foreign_key_check").all();
        if (violations.length > 0) throw new Error(`foreign_key_check found ${violations.length} violation(s)`);
      }
      if (recordedBackup !== undefined) {
        db.exec("CREATE TABLE IF NOT EXISTS migration_backups (id INTEGER PRIMARY KEY AUTOINCREMENT, backup_path TEXT NOT NULL, from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, binary_version TEXT NOT NULL, binary_path TEXT NOT NULL, created_at TEXT NOT NULL)");
        db.run("INSERT INTO migration_backups (backup_path, from_version, to_version, binary_version, binary_path, created_at) VALUES (?, ?, ?, ?, ?, ?)", [recordedBackup.path, recordedBackup.from, latestSchemaVersion, build.version, build.executablePath, new Date().toISOString()]);
      }
      db.exec(`PRAGMA user_version = ${latestSchemaVersion}`);
      db.run("COMMIT");
      if (foreignKeysOff) db.exec("PRAGMA foreign_keys = ON");
    } catch (cause: unknown) {
      try { db.run("ROLLBACK"); } catch { /* preserve the migration failure */ }
      if (foreignKeysOff) { try { db.exec("PRAGMA foreign_keys = ON"); } catch { /* preserve the migration failure */ } }
      throw cause;
    }
  } catch (cause: unknown) {
    failAt("migrate", cause);
  }
}

function configureConnection(db: DatabaseAdapter, path: string): void {
  try { db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`); }
  catch (cause: unknown) { failAt("pragma busy_timeout", cause); }
  const journalDeadline = Date.now() + busySeconds() * 1000;
  let journalAttempt = 0;
  while (true) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (cause: unknown) {
      if (!isBusy(cause)) failAt("pragma journal_mode", cause);
      const remaining = journalDeadline - Date.now();
      if (remaining <= 0) failAt("pragma journal_mode", new Error(`database is busy after ${busySeconds()} seconds`, { cause }));
      sleep(retryDelay(journalAttempt++, remaining));
    }
  }
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
    if (actual > latestSchemaVersion) throw new Error(newerSchemaMessage(db, path, String(actual), "user_version"));
    const hasMigrationTable = db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() !== null;
    if (hasMigrationTable) {
      const applied = db.query<{ version: number }>("SELECT max(version) AS version FROM schema_migrations").get()?.version ?? 0;
      if (applied > latestSchemaVersion) throw new Error(newerSchemaMessage(db, path, String(applied), "migration version"));
    }
  } catch (cause: unknown) { failAt("version guard user_version", cause); }
}

export function openDatabase(environment: StateEnvironment, build: BuildIdentity = defaultBuild()): Result<DatabaseHandle> {
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
    configureConnection(db, path);
    migrate(db, path, build, environment.MEGABRAIN_STATE_DIR === undefined || environment.MEGABRAIN_STATE_DIR === "");
    secureDatabaseFiles(path);
    const handle: DatabaseHandle = { path, db, close: () => db?.close() };
    try {
      importNativeSessions(handle, resolve(configuredStateDirectory, "native-sessions.json"));
      secureDatabaseFiles(path);
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
