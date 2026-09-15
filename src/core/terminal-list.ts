export type TerminalStatus = "alive" | "dead" | "stale" | "unknown";
export type TerminalRecord = {
  readonly terminalId: string;
  readonly host: string;
  readonly workspaceId: string | null;
  readonly worktree: string;
  readonly title: string | null;
  readonly command: string;
  readonly createdAt: string;
  readonly pid: number | null;
  readonly rootPid: number | null;
  readonly port: number | null;
  readonly status: string;
};
export type HostTerminal = { readonly pid: number | null; readonly rootPid?: number | null; readonly processId?: number | null; readonly status?: string; readonly state?: string; readonly exited?: boolean };

export function processStatus(record: TerminalRecord, host: HostTerminal | undefined, hostResponseValid: boolean, processAlive = true): TerminalStatus {
  if (!hostResponseValid) return "unknown";
  if (host === undefined) return "stale";
  const recordedPid = record.rootPid ?? record.pid;
  const hostPid = host.rootPid ?? host.pid ?? host.processId ?? null;
  if (recordedPid === null || hostPid === null || recordedPid !== hostPid) return "unknown";
  if (host.exited === true || ["exited", "dead", "stopped", "terminated"].includes(host.status ?? host.state ?? "")) return "dead";
  if (["active", "alive", "running"].includes(host.status ?? host.state ?? "")) return "alive";
  return processAlive ? "alive" : "dead";
}

export function formatTerminalList(entries: readonly TerminalRecord[], json: boolean): string {
  if (json) return `${JSON.stringify(entries, null, 2)}\n`;
  return entries.map((entry) => [entry.terminalId, entry.status, entry.host, entry.worktree, entry.title ?? "-", entry.command, entry.createdAt, entry.pid ?? "-", entry.port ?? "-"].join("\t")).join("\n") + (entries.length > 0 ? "\n" : "");
}
