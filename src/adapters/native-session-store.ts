import { join, resolve } from "node:path";
import { failed, ok, type Result } from "../core/result.js";
import { resolveChildStateDirectory } from "../core/state.js";
import type { NativeSession, NativeSessionKey } from "../core/native-session.js";
import type { QueueEnvironment } from "../cli/commands/queue-write.js";
import { openDatabaseReadOnly, readSnapshot } from "../db/db.js";
import { listNativeSessions } from "../db/queries/native-sessions.js";
import { callStateOwner } from "../db/state-owner.js";

export type NativeSessionStore = Readonly<{
  readonly available: boolean;
  readonly path: string | undefined;
  readonly error?: string;
  read(): Result<readonly NativeSession[]>;
  upsertIfCurrent(session: NativeSession, expectedSessionId: string | null): Promise<Result<boolean>>;
  removeIfCurrent(key: NativeSessionKey, sessionId: string): Promise<Result<boolean>>;
}>;

function unavailable(error?: string): NativeSessionStore {
  const message = error ?? "native session store has no resolvable state directory";
  return {
    available: false,
    path: undefined,
    ...(error === undefined ? {} : { error }),
    read: () => failed(message),
    upsertIfCurrent: async () => failed(message),
    removeIfCurrent: async () => failed(message),
  };
}

export function createNativeSessionStore(environment: QueueEnvironment): NativeSessionStore {
  let stateDir: string;
  try {
    if ((environment.MEGABRAIN_DISPATCH_STATE_DIR ?? environment.MEGABRAIN_STATE_DIR ?? environment.HOME ?? "") === "") return unavailable();
    stateDir = resolve(resolveChildStateDirectory(environment));
  } catch (cause: unknown) {
    return unavailable(cause instanceof Error ? cause.message : String(cause));
  }
  return {
    available: true,
    path: join(stateDir, "megabrain.db"),
    read() {
      const opened = openDatabaseReadOnly({ MEGABRAIN_STATE_DIR: stateDir, HOME: environment.HOME });
      if (opened.kind !== "ok") return opened;
      try { return readSnapshot(opened.value, () => listNativeSessions(opened.value)) as Result<readonly NativeSession[]>; }
      finally { opened.value.close(); }
    },
    async upsertIfCurrent(session, expectedSessionId) {
      try {
        return { kind: "ok", value: await callStateOwner(stateDir, { operation: "native-session-upsert", session, expectedSessionId }) as boolean };
      } catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
    },
    async removeIfCurrent(key, sessionId) {
      try {
        return { kind: "ok", value: await callStateOwner(stateDir, { operation: "native-session-remove", key, sessionId }) as boolean };
      } catch (cause: unknown) { return failed(cause instanceof Error ? cause.message : String(cause)); }
    },
  };
}
