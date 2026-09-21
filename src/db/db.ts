import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import nativeSessionsMigration from "./schema/001-native-sessions.sql" with { type: "text" };
import { importNativeSessions } from "./queries/native-sessions.js";
import { resolveStateDirectory, type StateEnvironment } from "../core/state.js";

const BUSY_TIMEOUT_MILLISECONDS = 5_000;

type Migration = Readonly<{ version: number; sql: string }>;

const migrations: readonly Migration[] = [
  { version: 1, sql: nativeSessionsMigration },
];

export type DatabaseHandle = Readonly<{
  readonly path: string;
  readonly db: Database;
  close(): void;
}>;

function migrate(db: Database): void {
  db.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MILLISECONDS}`);
  db.run("PRAGMA journal_mode = WAL");
  db.run("BEGIN IMMEDIATE");
  try {
    db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const applied = new Set(db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((row) => row.version));
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
  let db: Database | undefined;
  try {
    mkdirSync(stateDirectory, { recursive: true });
    db = new Database(path);
    migrate(db);
    const handle: DatabaseHandle = { path, db, close: () => db?.close() };
    importNativeSessions(handle, resolve(stateDirectory, "native-sessions.json"));
    return handle;
  } catch {
    db?.close();
    return undefined;
  }
}
