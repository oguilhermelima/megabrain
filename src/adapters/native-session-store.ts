import { dirname, resolve } from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { acquireLock, atomicJson, type QueueEnvironment } from "../cli/commands/queue-write.js";
import { resolveStateDirectory } from "../core/state.js";
import { failed, ok, type Result } from "../core/result.js";
import { parseNativeSessions, type NativeSession } from "../core/native-session.js";

type Update<T> = Readonly<{ sessions: readonly NativeSession[]; value: T }>;
type JsonRecord = Record<string, unknown>;

export type NativeSessionStore = Readonly<{
  readonly available: boolean;
  readonly path: string | undefined;
  update<T>(operation: (sessions: readonly NativeSession[]) => Promise<Update<T>>): Promise<Result<T>>;
}>;

async function readSessions(path: string): Promise<NativeSession[]> {
  try {
    return parseNativeSessions(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return [];
  }
}

export function createNativeSessionStore(environment: QueueEnvironment): NativeSessionStore {
  const configuredStateDirectory = environment.MEGABRAIN_STATE_DIR ?? environment.HOME;
  const path = configuredStateDirectory === undefined || configuredStateDirectory === "" ? undefined : resolve(resolveStateDirectory(environment), "native-sessions.json");
  const lockPath = path === undefined ? undefined : `${path}.lock`;
  return {
    available: path !== undefined,
    path,
    async update<T>(operation: (sessions: readonly NativeSession[]) => Promise<Update<T>>) {
      if (path === undefined || lockPath === undefined) return failed("native session store has no resolvable state directory");
      try {
        await mkdir(dirname(path), { recursive: true });
        const lock = await acquireLock(lockPath, environment);
        if (lock.kind !== "ok") return lock;
        try {
          const update = await operation(await readSessions(path));
          await atomicJson(path, { version: 1, sessions: update.sessions } as JsonRecord);
          return ok(update.value);
        } finally {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch (cause: unknown) {
        return failed(`could not update native session store: ${cause instanceof Error ? cause.message : "unknown error"}`);
      }
    },
  };
}
