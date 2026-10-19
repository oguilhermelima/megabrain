import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The desktop app opens its tmux terminals as sessions named mb-app-<id> on the megabrain-app
// server. tmux knows the session, not what it was opened for, so the app records the title and
// command here at creation, keyed by session name.

export const APP_SESSION_PREFIX = "mb-app-";

export type AppTerminalRecord = Readonly<{
  title: string;
  command: string;
  cwd: string;
  createdAt: string;
}>;
export type AppTerminalRecords = Readonly<Record<string, AppTerminalRecord>>;

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function recordsFile(stateDir: string): string {
  return join(stateDir, "app-terminals.json");
}

export function readAppTerminals(stateDir: string): AppTerminalRecords {
  try {
    const value = JSON.parse(
      readFileSync(recordsFile(stateDir), "utf8"),
    ) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as AppTerminalRecords)
      : {};
  } catch {
    return {};
  }
}

function writeAppTerminals(
  stateDir: string,
  records: AppTerminalRecords,
): void {
  const file = recordsFile(stateDir);
  mkdirSync(stateDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
}

function withAppTerminalLock<T>(stateDir: string, update: () => T): T {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = `${recordsFile(stateDir)}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (cause: unknown) {
      if (typeof cause !== "object" || cause === null || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error("app-terminals.json is locked by another writer");
      sleep(10);
    }
  }
  try { return update(); }
  finally { rmSync(lock, { recursive: true, force: true }); }
}

export function recordAppTerminal(
  stateDir: string,
  sessionName: string,
  record: AppTerminalRecord,
): void {
  withAppTerminalLock(stateDir, () => {
    writeAppTerminals(stateDir, { ...readAppTerminals(stateDir), [sessionName]: record });
  });
}

export function forgetAppTerminal(stateDir: string, sessionName: string): void {
  withAppTerminalLock(stateDir, () => {
    const { [sessionName]: _removed, ...rest } = readAppTerminals(stateDir);
    writeAppTerminals(stateDir, rest);
  });
}
