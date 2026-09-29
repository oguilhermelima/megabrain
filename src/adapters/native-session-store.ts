import { openDatabase, readSnapshot, withWrite, type DatabaseHandle } from "../db/db.js";
import { listNativeSessions, replaceNativeSessions } from "../db/queries/native-sessions.js";
import { failed, type Result } from "../core/result.js";
import type { NativeSession } from "../core/native-session.js";
import type { QueueEnvironment } from "../cli/commands/queue-write.js";

type Update<T> = Readonly<{ sessions: readonly NativeSession[]; value: T }>;
type SynchronousValue<T> = T extends PromiseLike<unknown> ? never : T;

export type NativeSessionStore = Readonly<{
  readonly available: boolean;
  readonly path: string | undefined;
  readonly error?: string;
  read(): Result<readonly NativeSession[]>;
  update<T>(operation: (sessions: readonly NativeSession[]) => Update<T>): Result<T>;
}>;

function unavailable(error?: string): NativeSessionStore {
  const message = error ?? "native session store has no resolvable state directory";
  return {
    available: false,
    path: undefined,
    ...(error === undefined ? {} : { error }),
    read: () => failed(message),
    update: () => failed(message),
  };
}

export function createNativeSessionStore(environment: QueueEnvironment): NativeSessionStore {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") {
    const noStateDirectory = opened.error === "resolve failed: no state directory is configured";
    return unavailable(noStateDirectory ? undefined : opened.error);
  }
  const database: DatabaseHandle = opened.value;

  return {
    available: true,
    path: database.path,
    read() {
      return readSnapshot(database, () => listNativeSessions(database));
    },
    update<T>(operation: (sessions: readonly NativeSession[]) => Update<T>) {
      return withWrite(database, () => {
        const update = operation(listNativeSessions(database));
        replaceNativeSessions(database, update.sessions);
        return update.value as SynchronousValue<T>;
      });
    },
  };
}
