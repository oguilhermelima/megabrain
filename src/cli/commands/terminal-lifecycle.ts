import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveTerminalSelector, type TerminalLifecycleRecord } from "../../core/terminal-lifecycle.js";
import { resolveStateDirectory } from "../../core/state.js";

type Environment = Readonly<Record<string, string | undefined>>;
const stateDir = (env: Environment) => env.MEGABRAIN_TERMINAL_DIR ?? join(resolveStateDirectory(env), "terminals");
const parsed = (text: string): Record<string, unknown> | undefined => { try { const value = JSON.parse(text); return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined; } catch { return undefined; } };
const number = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
const hostId = (value: Record<string, unknown>) => [value.terminalId, value.sessionId, value.handle, value.id].find((item): item is string => typeof item === "string");
const recordFrom = (value: Record<string, unknown>): TerminalLifecycleRecord | undefined => {
  if (typeof value.terminalId !== "string" || typeof value.host !== "string" || typeof value.worktree !== "string" || typeof value.command !== "string" || typeof value.createdAt !== "string") return undefined;
  return { terminalId: value.terminalId, host: value.host, workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : null, worktree: value.worktree, title: typeof value.title === "string" ? value.title : null, command: value.command, createdAt: value.createdAt, pid: number(value.pid), rootPid: number(value.rootPid), port: number(value.port) };
};
async function records(env: Environment): Promise<TerminalLifecycleRecord[]> {
  const directory = stateDir(env); let names: string[] = [];
  try { names = await readdir(directory); } catch { return []; }
  const result: TerminalLifecycleRecord[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) { try { const record = recordFrom(parsed(await readFile(join(directory, name), "utf8")) ?? {}); if (record) result.push(record); } catch { /* record disappeared */ } }
  return result;
}
function host(env: Environment): string { return env.SUPERSET_WORKSPACE_ID ? "superset" : env.ORCA_TERMINAL_HANDLE ? "orca" : "unknown"; }
function hostCommand(recordHost: string, operation: string, record: { workspaceId: string | null; terminalId?: string; command?: string; title?: string | null }): { command: string; args: string[] } | undefined {
  if (recordHost === "superset" && record.workspaceId) return { command: "superset", args: ["terminals", operation, ...(operation === "list" ? ["--workspace", record.workspaceId] : ["--workspace", record.workspaceId, ...(record.terminalId ? ["--terminal", record.terminalId] : []), ...(record.command ? ["--command", record.command] : [])]), "--json"] };
  if (recordHost === "orca") return { command: "orca", args: ["terminal", operation, ...(record.terminalId ? ["--terminal", record.terminalId] : []), ...(record.title ? ["--title", record.title] : []), ...(record.command ? ["--command", record.command] : []), "--json"] };
  return undefined;
}
function ids(value: unknown): Record<string, unknown>[] { if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null); if (typeof value !== "object" || value === null) return []; const obj = value as Record<string, unknown>; return ids(obj.terminals ?? obj.sessions ?? (obj.result as Record<string, unknown> | undefined)?.terminals ?? (obj.result as Record<string, unknown> | undefined)?.sessions); }
async function hostList(process: ProcessAdapter, record: TerminalLifecycleRecord): Promise<Record<string, unknown>[] | undefined> { const call = hostCommand(record.host, "list", record); if (!call) return undefined; const result = await process.run(call.command, call.args); if (result.kind !== "ok") return undefined; try { return ids(JSON.parse(result.value.stdout)); } catch { return undefined; } }
async function worktree(process: ProcessAdapter, value: string | undefined, currentDirectory = "."): Promise<Result<string>> { const path = resolve(value ?? currentDirectory); const result = await process.run("git", ["-C", path, "rev-parse", "--show-toplevel"]); return result.kind === "ok" ? ok(result.value.stdout.trim()) : failed(`worktree path is not a Git directory: ${value ?? currentDirectory}`); }
function jsonNumber(value: Record<string, unknown>, keys: string[]): number | null { for (const key of keys) { const found = key.split(".").reduce<unknown>((current, part) => typeof current === "object" && current !== null ? (current as Record<string, unknown>)[part] : undefined, value); const result = number(found); if (result) return result; } return null; }
async function save(env: Environment, record: TerminalLifecycleRecord): Promise<void> { await mkdir(stateDir(env), { recursive: true }); await writeFile(join(stateDir(env), `${record.terminalId}.json`), `${JSON.stringify({ ...record, status: "active" })}\n`); }
function output(value: unknown, json: boolean): string { return json ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`; }

async function normalizedSelector(process: ProcessAdapter, selector: string): Promise<string> {
  if (!selector.startsWith("worktree:")) return selector;
  const value = selector.slice("worktree:".length);
  if (!value) return selector;
  const root = await worktree(process, value);
  return root.kind === "ok" ? `worktree:${root.value}` : selector;
}

function selectorValue(selector: string): string { return selector.slice(selector.indexOf(":") + 1); }

async function portIsListening(process: ProcessAdapter, port: string): Promise<boolean> {
  const result = await process.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return result.kind === "ok" && result.value.stdout.trim().length > 0;
}

export async function executeTerminalLifecycle(args: readonly string[], env: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const operation = args[0]; const rest = args.slice(1); let json = false; let selector: string | undefined; let command: string | undefined; let title: string | null = null; let worktreePath: string | undefined; let port: number | null = null;
  for (let index = 0; index < rest.length; index += 1) { const arg = rest[index]; if (arg === "--json") json = true; else if (["--command", "--title", "--worktree", "--port", "--wait-port", "--timeout"].includes(arg)) { const value = rest[++index]; if (value === undefined) return failed(`${arg} requires a value`, 2); if (arg === "--command") command = value; else if (arg === "--title") title = value; else if (arg === "--worktree") worktreePath = value; else if (arg === "--port") { if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return failed("terminal create port must be between 1 and 65535", 2); port = Number(value); } } else if (!arg.startsWith("-") && selector === undefined) selector = arg; else return failed(`unknown terminal ${operation} option: ${arg}`, 2); }
  if (operation === "create") { const path = await worktree(process, worktreePath, env.PWD ?? "."); if (path.kind !== "ok") return path; const currentHost = host(env); const workspaceId = env.SUPERSET_WORKSPACE_ID ?? null; if (!command) return failed("terminal create requires --command in the TypeScript implementation", 2); const call = hostCommand(currentHost, "create", { workspaceId, command }); if (!call) return failed("cannot create terminal from unknown orchestration host"); const result = await process.run(call.command, call.args); if (result.kind !== "ok") return result; const value = parsed(result.value.stdout) ?? {}; const id = hostId(value); if (!id) return failed(`${currentHost} terminal create returned no terminal identity`); const record: TerminalLifecycleRecord = { terminalId: id, host: currentHost, workspaceId, worktree: path.value, title, command, createdAt: new Date().toISOString(), pid: jsonNumber(value, ["pid", "processId", "terminal.pid", "result.pid"]), rootPid: jsonNumber(value, ["rootPid", "processRootPid", "terminal.rootPid", "result.rootPid"]), port: jsonNumber(value, ["port", "terminal.port", "result.port"]) ?? port }; await save(env, record); return ok(output({ host: currentHost, worktree: path.value, title, terminalId: id, pid: record.pid, rootPid: record.rootPid, port: record.port }, json)); }
  const all = await records(env); if (!selector) return failed(`terminal ${operation} requires a selector`, 2);
  const resolvedSelector = await normalizedSelector(process, selector);
  const record = resolveTerminalSelector(all, resolvedSelector);
  if (!record) {
    if (operation === "restart" && selector.startsWith("port:")) {
      const port = selectorValue(selector);
      return failed(await portIsListening(process, port) ? `terminal selector could not be resolved: ${selector} (listener was not created by megabrain)` : `port ${port} is not listening`);
    }
    if (operation === "restart") return failed(`terminal selector could not be resolved: ${selector}`);
    return failed("terminal selector could not be resolved");
  }
  if (operation === "close") { const call = hostCommand(record.host, "close", record); if (!call) return failed(`could not verify host terminal ${record.terminalId} before close`); const listed = await hostList(process, record); if (!listed) return failed(`could not verify host terminal ${record.terminalId} before close`); if (!listed.some((item) => hostId(item) === record.terminalId)) { await rm(join(stateDir(env), `${record.terminalId}.json`), { force: true }); return failed("host no longer knows this terminal"); } const result = await process.run(call.command, call.args); if (result.kind !== "ok") return failed(`could not close host terminal ${record.terminalId}; record retained`); await rm(join(stateDir(env), `${record.terminalId}.json`), { force: true }); return ok(output({ selector, terminalId: record.terminalId, status: "closed", identity: record.rootPid || record.pid ? "recorded" : "unavailable", recordRemoved: true }, json)); }
  if (operation === "restart") {
    const root = record.rootPid ?? record.pid;
    if (root === null) return failed(`terminal ${selectorValue(selector)} has no recorded process identity; refusing to kill an unowned process`);
    const killed = await process.run("kill", ["-TERM", String(root)]);
    if (killed.kind !== "ok") return failed(`could not stop terminal process tree rooted at ${root}`);
    const call = hostCommand(record.host, "create", { workspaceId: record.workspaceId, title: record.title, command: command ?? record.command });
    if (!call) return failed(`cannot recreate terminal from unknown host: ${record.host}`);
    const created = await process.run(call.command, call.args);
    if (created.kind !== "ok") return created;
    const value = parsed(created.value.stdout) ?? {}; const id = hostId(value);
    if (!id) return failed(`${record.host} terminal recreate returned no terminal identity`);
    const replacement: TerminalLifecycleRecord = { ...record, terminalId: id, command: command ?? record.command, createdAt: new Date().toISOString(), pid: jsonNumber(value, ["pid", "processId", "terminal.pid", "result.pid"]), rootPid: jsonNumber(value, ["rootPid", "processRootPid", "terminal.rootPid", "result.rootPid"]), port: jsonNumber(value, ["port", "terminal.port", "result.port"]) ?? record.port };
    await save(env, replacement);
    if (id !== record.terminalId) await rm(join(stateDir(env), `${record.terminalId}.json`), { force: true });
    return ok(output({ selector, killedPid: root, killedTree: [root], recreated: true, recreatedTerminalId: id, port: replacement.port, listeningAfterMs: 0 }, json));
  }
  return failed(`unknown terminal operation: ${operation}`, 2);
}
