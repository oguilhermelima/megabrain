import { openDatabase } from "../db/db.js";
import { listNativeSessions, replaceNativeSessions } from "../db/queries/native-sessions.js";
import { failed, ok, type Result } from "../core/result.js";
import type { NativeSession } from "../core/native-session.js";
import type { QueueEnvironment } from "../cli/commands/queue-write.js";

type Update<T> = Readonly<{ sessions: readonly NativeSession[]; value: T }>;

type ProcessLock = Readonly<{ tail: Promise<void>; release(): void }>;
const processLocks = new Map<string, ProcessLock>();

async function acquireProcessLock(path: string): Promise<() => void> {
  const previous = processLocks.get(path)?.tail ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  const lock: ProcessLock = { tail: previous.then(() => current), release: () => releaseCurrent?.() };
  processLocks.set(path, lock);
  await previous;
  return () => {
    lock.release();
    if (processLocks.get(path) === lock) processLocks.delete(path);
  };
}

export type NativeSessionStore = Readonly<{
  readonly available: boolean;
  readonly path: string | undefined;
  update<T>(operation: (sessions: readonly NativeSession[]) => Promise<Update<T>>): Promise<Result<T>>;
}>;

export function createNativeSessionStore(environment: QueueEnvironment): NativeSessionStore {
  const database = openDatabase(environment);
  if (database === undefined) {
    return {
      available: false,
      path: undefined,
      async update<T>() {
        return failed("native session store has no resolvable state directory") as Result<T>;
      },
    };
  }

  return {
    available: true,
    path: database.path,
    async update<T>(operation: (sessions: readonly NativeSession[]) => Promise<Update<T>>) {
      const releaseProcessLock = await acquireProcessLock(database.path);
      try {
        database.db.run("BEGIN IMMEDIATE");
        try {
          const update = await operation(listNativeSessions(database));
          replaceNativeSessions(database, update.sessions);
          database.db.run("COMMIT");
          return ok(update.value);
        } catch (cause: unknown) {
          try { database.db.run("ROLLBACK"); } catch { /* preserve the update failure */ }
          throw cause;
        }
      } catch (cause: unknown) {
        return failed(`could not update native session store: ${cause instanceof Error ? cause.message : "unknown error"}`);
      } finally {
        releaseProcessLock();
      }
    },
  };
}
