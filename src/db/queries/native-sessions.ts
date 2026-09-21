import { readFileSync } from "node:fs";
import { parseNativeSessions, type NativeSession } from "../../core/native-session.js";
import type { DatabaseHandle } from "../db.js";

const IMPORT_MARKER = "json-import-v1";

type NativeSessionRow = Readonly<{
  readonly udid: string;
  readonly bundle_id: string;
  readonly session_id: string;
}>;

function insert(db: DatabaseHandle, session: NativeSession): void {
  db.db.run(
    "INSERT INTO native_sessions (udid, bundle_id, session_id) VALUES (?, ?, ?) ON CONFLICT (udid, bundle_id) DO UPDATE SET session_id = excluded.session_id",
    [session.udid, session.bundleId, session.sessionId],
  );
}

export function listNativeSessions(db: DatabaseHandle): NativeSession[] {
  return db.db.query<NativeSessionRow, []>("SELECT udid, bundle_id, session_id FROM native_sessions ORDER BY rowid").all().map((row) => ({
    udid: row.udid,
    bundleId: row.bundle_id,
    sessionId: row.session_id,
  }));
}

export function addNativeSession(db: DatabaseHandle, session: NativeSession): void {
  insert(db, session);
}

export function replaceNativeSessions(db: DatabaseHandle, sessions: readonly NativeSession[]): void {
  db.db.run("DELETE FROM native_sessions");
  for (const session of sessions) insert(db, session);
}

export function importNativeSessions(db: DatabaseHandle, jsonPath: string): void {
  db.db.run("BEGIN IMMEDIATE");
  try {
    const marker = db.db.query<{ value: string }, [string]>("SELECT value FROM native_sessions_meta WHERE key = ?").get(IMPORT_MARKER);
    if (marker === null) {
      if (listNativeSessions(db).length === 0) {
        try {
          const value: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
          for (const session of parseNativeSessions(value)) insert(db, session);
        } catch {
          // A missing or invalid backup does not prevent the database from opening.
        }
      }
      db.db.run("INSERT INTO native_sessions_meta (key, value) VALUES (?, ?)", [IMPORT_MARKER, new Date().toISOString()]);
    }
    db.db.run("COMMIT");
  } catch (cause: unknown) {
    try { db.db.run("ROLLBACK"); } catch { /* preserve the import failure */ }
    throw cause;
  }
}
