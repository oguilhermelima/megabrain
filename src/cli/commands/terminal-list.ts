import { readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { formatTerminalList, processStatus, type HostTerminal, type TerminalRecord } from "../../core/terminal-list.js";
import { resolveStateDirectory } from "../../core/state.js";
import { getHost } from "../../hosts/index.js";

export type TerminalListEnvironment = Readonly<Record<string, string | undefined>>;

function jsonValue(output: string): unknown {
  try { return JSON.parse(output) as unknown; } catch { return undefined; }
}

function records(value: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  if (typeof value !== "object" || value === null) return [];
  const object = value as Record<string, unknown>;
  for (const key of ["terminals", "sessions", "result"]) {
    const nested = object[key];
    if (Array.isArray(nested)) return records(nested);
    if (typeof nested === "object" && nested !== null) {
      const found = records(nested);
      if (found.length > 0) return found;
    }
  }
  return [];
}

function idOf(record: Record<string, unknown>): string {
  for (const key of ["terminalId", "handle", "terminalHandle", "sessionId", "id"]) if (typeof record[key] === "string") return record[key] as string;
  return "";
}

function numberOf(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) if (typeof record[key] === "number" && Number.isInteger(record[key])) return record[key] as number;
  return null;
}

function hostTerminal(record: Record<string, unknown>): HostTerminal {
  return {
    pid: numberOf(record, ["pid"]),
    rootPid: numberOf(record, ["rootPid"]),
    processId: numberOf(record, ["processId"]),
    status: typeof record.status === "string" ? record.status : undefined,
    state: typeof record.state === "string" ? record.state : undefined,
    exited: typeof record.exited === "boolean" ? record.exited : undefined,
  };
}

function terminalRecord(value: unknown): TerminalRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.terminalId !== "string" || typeof record.host !== "string" || typeof record.worktree !== "string" || typeof record.command !== "string" || typeof record.createdAt !== "string") return undefined;
  return {
    terminalId: record.terminalId, host: record.host, workspaceId: typeof record.workspaceId === "string" ? record.workspaceId : null,
    worktree: record.worktree, title: typeof record.title === "string" ? record.title : null, command: record.command,
    createdAt: record.createdAt, pid: numberOf(record, ["pid"]), rootPid: numberOf(record, ["rootPid"]), port: numberOf(record, ["port"]),
    status: typeof record.status === "string" ? record.status : "active",
  };
}

async function hostRecords(process: ProcessAdapter, record: TerminalRecord): Promise<{ readonly valid: boolean; readonly terminal?: HostTerminal }> {
  const call = getHost(record.host)?.list({ workspaceId: record.workspaceId });
  if (call === undefined || call.kind !== "ok") return { valid: false };
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind !== "ok") return { valid: false };
  const parsed = jsonValue(result.value.stdout);
  if (parsed === undefined) return { valid: false };
  const found = records(parsed).find((item) => idOf(item) === record.terminalId);
  return { valid: true, terminal: found === undefined ? undefined : hostTerminal(found) };
}

async function selector(process: ProcessAdapter, value: string): Promise<Result<string>> {
  try {
    const selected = await realpath(value);
    const result = await process.run("git", ["-C", value, "rev-parse", "--show-toplevel"]);
    if (result.kind !== "ok") return failed(`worktree path is not a Git directory: ${value}`);
    const root = await realpath(result.value.stdout.trim());
    if (selected !== root) return failed(`worktree selector points to subdirectory: ${selected}; pass the worktree root ${root} and put cd ${selected} in the command`);
    return ok(root);
  } catch { return failed(`worktree path is not a Git directory: ${value}`); }
}

export async function executeTerminalList(args: readonly string[], environment: TerminalListEnvironment, process: ProcessAdapter): Promise<Result<string>> {
  let worktree: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--worktree") worktree = args[++index];
    else if (arg === "-h" || arg === "--help") return ok("Usage: megabrain terminal list [--worktree <path>] [--json]\n");
    else return failed(`unknown terminal list option: ${arg}`, 2);
  }
  const filter = worktree === undefined ? undefined : await selector(process, worktree);
  if (filter !== undefined && filter.kind !== "ok") return filter;
  const directory = environment.MEGABRAIN_TERMINAL_DIR ?? join(resolveStateDirectory(environment), "terminals");
  let names: string[];
  try { names = await readdir(directory); } catch { names = []; }
  const entries: TerminalRecord[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    let parsed: unknown;
    try { parsed = jsonValue(await readFile(join(directory, name), "utf8")); } catch { continue; }
    const record = terminalRecord(parsed);
    if (record === undefined || (filter !== undefined && record.worktree !== filter.value)) continue;
    const host = await hostRecords(process, record);
    let processAlive = true;
    const hostState = host.terminal?.status ?? host.terminal?.state;
    if (host.terminal !== undefined && hostState === undefined && record.rootPid !== null) {
      processAlive = (await process.run("kill", ["-0", String(record.rootPid)])).kind === "ok";
    }
    entries.push({ ...record, status: processStatus(record, host.terminal, host.valid, processAlive) });
  }
  return ok(formatTerminalList(entries, json));
}
