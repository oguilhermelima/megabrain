import type { ProcessAdapter } from "../adapters/proc.js";
import { getHost } from "../hosts/index.js";

type TerminalScope = Readonly<{ host?: unknown; terminalId?: unknown; workspaceId?: unknown }>;

function agentCommand(agent: string, command: string): boolean {
  if (/^(?:-?(?:zsh|bash|sh|fish))(?:\s|$)/i.test(command)) return false;
  return new RegExp(`(?:^|[\\s/])${agent === "agy" ? "agy" : agent}(?:\\s|$)`, "i").test(command);
}

async function orcaForegroundGroup(scope: TerminalScope, pid: number, agent: string, process: ProcessAdapter): Promise<boolean | undefined> {
  const terminalId = typeof scope.terminalId === "string" ? scope.terminalId : "";
  if (terminalId === "") return undefined;
  const provider = getHost("orca");
  const call = provider?.list({ workspaceId: typeof scope.workspaceId === "string" ? scope.workspaceId : null });
  if (call?.kind !== "ok") return undefined;
  const listed = await process.run(call.value.command, call.value.args);
  if (listed.kind !== "ok") return undefined;
  let root: unknown;
  try { root = JSON.parse(listed.value.stdout) as unknown; } catch { return undefined; }
  const value = typeof root === "object" && root !== null ? root as Record<string, unknown> : {};
  const result = typeof value.result === "object" && value.result !== null ? value.result as Record<string, unknown> : {};
  const terminals = Array.isArray(root) ? root : Array.isArray(value.terminals) ? value.terminals : result.terminals;
  if (!Array.isArray(terminals)) return undefined;
  const terminal = terminals.find((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).handle === terminalId) as Record<string, unknown> | undefined;
  const rootPid = Number(terminal?.pid);
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return undefined;
  const tree = await process.run("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,command="]);
  if (tree.kind !== "ok") return undefined;
  const rows = new Map<number, { parent: number; group: number; foreground: number; command: string }>();
  for (const line of tree.value.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    rows.set(Number(match[1]), { parent: Number(match[2]), group: Number(match[3]), foreground: Number(match[4]), command: match[5] ?? "" });
  }
  const rootRow = rows.get(rootPid);
  const agentRow = rows.get(pid);
  if (rootRow === undefined || agentRow === undefined || !agentCommand(agent, agentRow.command) || rootRow.foreground <= 0 || agentRow.group !== rootRow.foreground) return false;
  const seen = new Set<number>();
  let current = pid;
  while (!seen.has(current)) {
    if (current === rootPid) return true;
    seen.add(current);
    const row = rows.get(current);
    if (row === undefined) return false;
    current = row.parent;
  }
  return false;
}

/** True only when the recorded receiver is alive and belongs to the terminal's foreground group. */
export async function agentOwnsForegroundProcess(agent: string, pid: number, process: ProcessAdapter, terminal?: TerminalScope): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !["claude", "codex", "grok", "agy"].includes(agent)) return false;
  if (terminal?.host === "orca") {
    const foreground = await orcaForegroundGroup(terminal, pid, agent, process);
    if (foreground !== undefined) return foreground;
  }
  const result = await process.run("ps", ["-ww", "-p", String(pid), "-o", "pid=,pgid=,tpgid=,args="]);
  if (result.kind !== "ok") return false;
  const line = result.value.stdout.trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if (match === null || Number(match[1]) !== pid || match[2] !== match[3]) return false;
  const command = match[4]!.trim();
  return agentCommand(agent, command);
}
