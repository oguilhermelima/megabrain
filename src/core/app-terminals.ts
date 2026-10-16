import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

export function recordAppTerminal(
  stateDir: string,
  sessionName: string,
  record: AppTerminalRecord,
): void {
  writeAppTerminals(stateDir, {
    ...readAppTerminals(stateDir),
    [sessionName]: record,
  });
}

export function forgetAppTerminal(stateDir: string, sessionName: string): void {
  const { [sessionName]: _removed, ...rest } = readAppTerminals(stateDir);
  writeAppTerminals(stateDir, rest);
}
