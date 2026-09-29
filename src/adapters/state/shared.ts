import { resolve } from "node:path";
import { failed, type Result } from "../../core/result.js";
import { resolveStateDirectory, type StateEnvironment } from "../../core/state.js";
import { resolveDispatchId } from "../../core/dispatch-paths.js";
import { openDatabase, readSnapshot, withWrite, type DatabaseHandle } from "../../db/db.js";

const handles = new Map<string, DatabaseHandle>();

export function stateDatabase(environment: StateEnvironment): Result<DatabaseHandle> {
  let directory: string;
  try {
    const configured = environment.MEGABRAIN_STATE_DIR ?? environment.HOME;
    if (configured === undefined || configured === "") return failed("resolve failed: no state directory is configured");
    directory = resolve(resolveStateDirectory(environment));
  } catch (cause: unknown) {
    return failed(`resolve failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const cached = handles.get(directory);
  if (cached !== undefined) return { kind: "ok", value: cached };
  const opened = openDatabase({ MEGABRAIN_STATE_DIR: directory, HOME: environment.HOME });
  if (opened.kind === "ok") handles.set(directory, opened.value);
  return opened;
}

export function transcriptPath(environment: StateEnvironment, dispatchId: string): Result<string> {
  if (resolveDispatchId(dispatchId).kind === "invalid") return failed("dispatchId must contain only letters, digits, dots, underscores, or hyphens");
  try {
    const configured = environment.MEGABRAIN_STATE_DIR ?? environment.HOME;
    if (configured === undefined || configured === "") return failed("resolve failed: no state directory is configured");
    return { kind: "ok", value: resolve(resolveStateDirectory(environment), "transcripts", `${dispatchId}.txt`) };
  } catch (cause: unknown) {
    return failed(`resolve failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

type NotThenable<T> = T extends PromiseLike<unknown> ? never : T;

export function read<T>(handle: DatabaseHandle, operation: (handle: DatabaseHandle) => NotThenable<T>): Result<T> {
  const result = readSnapshot(handle, () => operation(handle));
  return result as Result<T>;
}

export function write<T>(handle: DatabaseHandle, operation: (handle: DatabaseHandle) => NotThenable<T>): Result<T> {
  return withWrite(handle, () => operation(handle)) as Result<T>;
}
