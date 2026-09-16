export type TerminalLifecycleRecord = {
  readonly terminalId: string; readonly host: string; readonly workspaceId: string | null;
  readonly worktree: string; readonly title: string | null; readonly command: string;
  readonly createdAt: string; readonly pid: number | null; readonly rootPid: number | null; readonly port: number | null;
};

export function resolveTerminalSelector(records: readonly TerminalLifecycleRecord[], selector: string): TerminalLifecycleRecord | undefined {
  const separator = selector.indexOf(":");
  if (separator <= 0) return undefined;
  const kind = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  if (value.length === 0 || !["id", "title", "port", "worktree"].includes(kind)) return undefined;
  return records.find((record) =>
    (kind === "id" && record.terminalId === value) ||
    (kind === "title" && (record.title ?? "") === value) ||
    (kind === "port" && String(record.port ?? "") === value) ||
    (kind === "worktree" && record.worktree === value));
}
