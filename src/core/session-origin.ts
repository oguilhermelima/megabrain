import type { ProcessAdapter } from "../adapters/proc.js";
import { OWNED_TMUX_SERVER, ownedTmuxProcess, type OwnedSessions } from "./session-ownership.js";

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

// Where the app runs a session it launched: the process its native terminal started (the PTY's
// child), or the pane process of a session on its tmux server.
export type AppHost = Readonly<{ kind: "native"; pid: number } | { kind: "tmux"; panePid: number }>;

export function appHost(table: ProcessTable, pid: number | null | undefined): AppHost | undefined {
  const seen = new Set<number>();
  let current = pid ?? undefined;
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current);
    const entry = table.get(current);
    if (entry === undefined) return undefined;
    const parent = table.get(entry.ppid)?.command ?? "";
    if (APP_BINARY.test(parent)) return { kind: "native", pid: current };
    if (APP_TMUX_SERVER.test(parent)) return { kind: "tmux", panePid: current };
    current = entry.ppid;
  }
  return undefined;
}

// The host for an unrecorded session, inferred from the process tree. Recorded sessions use their
// creator's durable host instead, so this is only a fallback for sessions opened by hand.
export function inferSessionHost(table: ProcessTable, pid: number | null | undefined): string {
  if (appHost(table, pid) !== undefined) return "megabrain";
  const seen = new Set<number>();
  for (let current = pid ?? undefined; current !== undefined && current > 1 && !seen.has(current);) {
    seen.add(current);
    const entry = table.get(current);
    if (entry === undefined) break;
    if (/orca/i.test(entry.command)) return "orca";
    if (/superset/i.test(entry.command)) return "superset";
    if (/(?:^|\/)tmux(?:\s|$)/.test(entry.command)) return "tmux";
    current = entry.ppid;
  }
  return "terminal";
}

// Pane process to session name on the app's tmux server; empty when the server is not running.
export async function readAppPanes(processAdapter: ProcessAdapter): Promise<ReadonlyMap<number, string>> {
  const panes = new Map<number, string>();
  const output = await ownedTmuxProcess(processAdapter).run("tmux", ["list-panes", "-a", "-F", "#{pane_pid} #{session_name}"]);
  if (output.kind !== "ok") return panes;
  for (const line of output.value.stdout.split("\n")) {
    const match = /^(\d+) (\S+)$/.exec(line.trim());
    if (match !== null) panes.set(Number(match[1]), match[2] ?? "");
  }
  return panes;
}

// What runs a session the app launched: its terminal's process, or its tmux session on the app's server.
export type AppTarget = Readonly<{ terminalPid: number } | { tmuxSession: string }>;

export function appTarget(host: AppHost | undefined, panes: ReadonlyMap<number, string>): AppTarget | undefined {
  if (host === undefined) return undefined;
  if (host.kind === "native") return { terminalPid: host.pid };
  const session = panes.get(host.panePid);
  return session === undefined ? undefined : { tmuxSession: session };
}

export type OriginEvidence = Readonly<{ key: string; processId?: number | undefined; dispatchPid?: number | null | undefined; owned: OwnedSessions; nativeChats: ReadonlySet<string>; table: ProcessTable }>;

export function sessionOrigin(evidence: OriginEvidence): SessionOrigin {
  if (evidence.owned[evidence.key] !== undefined || evidence.nativeChats.has(evidence.key)) return "megabrain";
  return descendsFromMegabrain(evidence.table, evidence.processId) || descendsFromMegabrain(evidence.table, evidence.dispatchPid) ? "megabrain" : "external";
}
