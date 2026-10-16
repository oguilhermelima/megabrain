import type { ProcessAdapter } from "../adapters/proc.js";
import { OWNED_TMUX_SERVER, type OwnedSessions } from "./session-ownership.js";

export type SessionOrigin = "megabrain" | "external";
export type ProcessTable = ReadonlyMap<number, Readonly<{ ppid: number; command: string }>>;

const APP_BINARY = /megabrain-desktop/;
const APP_TMUX_SERVER = new RegExp(`(?:^|[\\s/])tmux\\s(?:.*\\s)?-L\\s*${OWNED_TMUX_SERVER}(?:\\s|$)`);

// One `ps` call: every process with its parent, parsed once per run.
export async function readProcessTable(processAdapter: ProcessAdapter): Promise<ProcessTable> {
  const table = new Map<number, { ppid: number; command: string }>();
  const output = await processAdapter.run("ps", ["-axo", "pid=,ppid=,command="]);
  if (output.kind !== "ok") return table;
  for (const line of output.value.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match !== null) table.set(Number(match[1]), { ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return table;
}

// True when the process, or any ancestor, is the desktop app or the tmux server the app owns.
export function descendsFromMegabrain(table: ProcessTable, pid: number | null | undefined): boolean {
  const seen = new Set<number>();
  let current = pid ?? undefined;
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current);
    const entry = table.get(current);
    if (entry === undefined) return false;
    if (APP_BINARY.test(entry.command) || APP_TMUX_SERVER.test(entry.command)) return true;
    current = entry.ppid;
  }
  return false;
}

export type OriginEvidence = Readonly<{ key: string; processId?: number | undefined; dispatchPid?: number | null | undefined; owned: OwnedSessions; nativeChats: ReadonlySet<string>; table: ProcessTable }>;

export function sessionOrigin(evidence: OriginEvidence): SessionOrigin {
  if (evidence.owned[evidence.key] !== undefined || evidence.nativeChats.has(evidence.key)) return "megabrain";
  return descendsFromMegabrain(evidence.table, evidence.processId) || descendsFromMegabrain(evidence.table, evidence.dispatchPid) ? "megabrain" : "external";
}
