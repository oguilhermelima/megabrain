import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolveTerminalSelector, type TerminalLifecycleRecord } from "../../core/terminal-lifecycle.js";
import { resolveStateDirectory } from "../../core/state.js";
import { getHost, type HostCommand } from "../../hosts/index.js";

type Environment = Readonly<Record<string, string | undefined>>;
type JsonObject = { readonly [key: string]: unknown };
type Host = "superset" | "orca" | "unknown";

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null;
const stateDir = (env: Environment) => env.MEGABRAIN_TERMINAL_DIR ?? join(resolveStateDirectory(env), "terminals");

function parsed(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }

function firstString(value: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = string(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function nested(value: JsonObject, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const part of path) {
    if (!isObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstNumber(value: JsonObject, paths: readonly (readonly string[])[]): number | null {
  for (const path of paths) {
    const found = number(nested(value, path));
    if (found !== null) return found;
  }
  return null;
}

function hostId(value: JsonObject): string | undefined {
  const direct = firstString(value, ["terminalId", "sessionId", "handle", "id"]);
  if (direct !== undefined) return direct;
  for (const path of [["result"], ["terminal"], ["result", "terminal"]] as const) {
    const child = nested(value, path);
    if (isObject(child)) {
      const found = hostId(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function safeTerminalId(value: string): boolean { return value.length > 0 && !/[\\/\n]/.test(value); }

function recordFrom(value: unknown): TerminalLifecycleRecord | undefined {
  if (!isObject(value)) return undefined;
  const terminalId = string(value.terminalId);
  const host = string(value.host);
  const worktree = string(value.worktree);
  const command = string(value.command);
  const createdAt = string(value.createdAt);
  if (terminalId === undefined || host === undefined || worktree === undefined || command === undefined || createdAt === undefined) return undefined;
  return {
    terminalId,
    host,
    workspaceId: string(value.workspaceId) ?? null,
    worktree,
    title: string(value.title) ?? null,
    command,
    createdAt,
    pid: number(value.pid),
    rootPid: number(value.rootPid),
    port: number(value.port),
  };
}

async function records(env: Environment): Promise<TerminalLifecycleRecord[]> {
  const directory = stateDir(env);
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const result: TerminalLifecycleRecord[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    try {
      const record = recordFrom(parsed(await readFile(join(directory, name), "utf8")));
      if (record !== undefined) result.push(record);
    } catch { /* A concurrent close may remove a record after readdir. */ }
  }
  return result;
}

function host(env: Environment): Host {
  if (env.MEGABRAIN_SESSION_HOST === "superset" || env.SUPERSET_TERMINAL_ID !== undefined || env.SUPERSET_WORKSPACE_ID !== undefined) return "superset";
  if (env.MEGABRAIN_SESSION_HOST === "orca" || env.ORCA_TERMINAL_HANDLE !== undefined) return "orca";
  return "unknown";
}

function hostCommand(recordHost: string, operation: string, record: { readonly workspaceId: string | null; readonly terminalId?: string }): HostCommand | undefined {
  const provider = getHost(recordHost);
  if (provider === undefined || (record.terminalId === undefined && operation !== "list")) return undefined;
  const input = { workspaceId: record.workspaceId, terminalId: record.terminalId ?? "" };
  const result = operation === "list" ? provider.list({ workspaceId: record.workspaceId }) : operation === "read" ? provider.read(input) : operation === "close" ? provider.close(input) : undefined;
  return result?.kind === "ok" ? result.value : undefined;
}

function hostEntries(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isObject);
  if (!isObject(value)) return [];
  for (const key of ["terminals", "sessions", "result"]) {
    const found = hostEntries(value[key]);
    if (found.length > 0) return found;
  }
  return [];
}

async function hostList(process: ProcessAdapter, record: TerminalLifecycleRecord): Promise<JsonObject[] | undefined> {
  const call = hostCommand(record.host, "list", record);
  if (call === undefined) return undefined;
  const result = await process.run(call.command, call.args);
  if (result.kind !== "ok") return undefined;
  const value = parsed(result.value.stdout);
  return value === undefined ? undefined : hostEntries(value);
}

async function worktree(process: ProcessAdapter, value: string | undefined, currentDirectory: string): Promise<Result<string>> {
  const selected = resolve(value ?? currentDirectory);
  const result = await process.run("git", ["-C", selected, "rev-parse", "--show-toplevel"]);
  if (result.kind !== "ok") return failed(`worktree path is not a Git directory: ${value ?? currentDirectory}`);
  const root = resolve(result.value.stdout.trim());
  if (value !== undefined) {
    try {
      const selectedReal = await realpath(selected);
      const rootReal = await realpath(root);
      if (selectedReal !== rootReal) return failed(`worktree selector points to subdirectory: ${selectedReal}; pass the worktree root ${rootReal} and put cd ${selectedReal} in the command`);
      return ok(rootReal);
    } catch { return failed(`worktree path is not a Git directory: ${value}`); }
  }
  return ok(root);
}

async function workspaceId(process: ProcessAdapter, worktreePath: string): Promise<string | undefined> {
  const call = getHost("superset")?.workspaces();
  if (call === undefined || call.kind !== "ok") return undefined;
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind !== "ok") return undefined;
  const value = parsed(result.value.stdout);
  const workspaces = hostEntries(isObject(value) ? (value.workspaces ?? value.result) : value);
  for (const item of workspaces) {
    const path = string(item.worktreePath) ?? string(item.path) ?? (isObject(item.worktree) ? string(item.worktree.path) : undefined);
    const branch = string(item.branch) ?? (isObject(item.git) ? string(item.git.branch) : undefined);
    const branchName = branch?.replace(/^refs\/heads\//, "");
    const name = string(item.name);
    if (path === worktreePath || branchName === worktreePath || name === worktreePath) return string(item.id) ?? string(item.workspaceId) ?? (isObject(item.workspace) ? string(item.workspace.id) : undefined);
  }
  return undefined;
}

async function save(env: Environment, record: TerminalLifecycleRecord): Promise<void> {
  await mkdir(stateDir(env), { recursive: true });
  await writeFile(join(stateDir(env), `${record.terminalId}.json`), `${JSON.stringify({ ...record, status: "active" })}\n`);
}

function output(value: unknown, json: boolean): string { return json ? `${JSON.stringify(value, null, 2)}\n` : `${String(value)}\n`; }

function help(operation: string): string {
  if (operation === "create") return "Usage: megabrain terminal create [--worktree <path>] [--command <cmd>] [--title <text>] [--port <port>] [--json]\nWithout --command, use the worktree .superset/config.json run script.\nSuperset tabs are not titled; only Orca tabs are.\n";
  if (operation === "close") return "Usage: megabrain terminal close <selector> [--json]\n";
  return "Usage: megabrain terminal restart <selector> [--command <cmd>] [--wait-port <port>] [--timeout <seconds>] [--json]\n";
}

function shellQuote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }
function launchCommand(command: string): { readonly command: string; readonly marker: string } {
  const token = randomUUID().replace(/-/g, "");
  const marker = `MEGABRAIN_TERMINAL_PID_${token}`;
  return { marker, command: `printf '${marker}=%s\\n' "$$"; exec sh -c ${shellQuote(command)}` };
}

function runCommands(value: unknown): string | undefined {
  if (!isObject(value) || !Array.isArray(value.run)) return undefined;
  const commands = value.run.filter((item): item is string => typeof item === "string" && item.length > 0);
  return commands.length > 0 ? commands.join(" && ") : undefined;
}

async function commandFromConfig(worktreePath: string): Promise<string | undefined> {
  try { return runCommands(parsed(await readFile(join(worktreePath, ".superset", "config.json"), "utf8"))); } catch { return undefined; }
}

function selectorValue(selector: string): string { return selector.slice(selector.indexOf(":") + 1); }

async function listenerPid(process: ProcessAdapter, port: string | number): Promise<string | undefined> {
  const result = await process.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  if (result.kind !== "ok") return undefined;
  const pid = result.value.stdout.trim().split(/\s+/)[0];
  return pid === "" ? undefined : pid;
}

async function portIsListening(process: ProcessAdapter, port: string): Promise<boolean> { return (await listenerPid(process, port)) !== undefined; }

async function normalizedSelector(process: ProcessAdapter, selector: string, currentDirectory: string): Promise<Result<string>> {
  if (!selector.startsWith("worktree:")) return ok(selector);
  const value = selector.slice("worktree:".length);
  if (value === "") return ok(selector);
  const root = await worktree(process, value, currentDirectory);
  return root.kind === "ok" ? ok(`worktree:${root.value}`) : root;
}

async function pidParent(process: ProcessAdapter, pid: string): Promise<string | undefined> {
  const result = await process.run("ps", ["-o", "ppid=", "-p", pid]);
  if (result.kind !== "ok") return undefined;
  const parent = result.value.stdout.trim();
  return /^[0-9]+$/.test(parent) ? parent : undefined;
}

async function belongsToTree(process: ProcessAdapter, root: string, target: string): Promise<boolean> {
  if (root === target) return true;
  let current = target;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const parent = await pidParent(process, current);
    if (parent === undefined || parent === "0" || parent === "1") return false;
    if (parent === root) return true;
    current = parent;
  }
  return false;
}

async function killTree(process: ProcessAdapter, pid: string): Promise<string[] | undefined> {
  const childrenResult = await process.run("pgrep", ["-P", pid]);
  const children = childrenResult.kind === "ok" ? childrenResult.value.stdout.trim().split(/\s+/).filter((item) => item !== "") : [];
  const killed = await process.run("kill", ["-TERM", pid]);
  if (killed.kind !== "ok") return undefined;
  const result = [pid];
  for (const child of children) {
    const childTree = await killTree(process, child);
    if (childTree === undefined) return undefined;
    result.push(...childTree);
  }
  return result;
}

async function waitForPort(process: ProcessAdapter, port: string | number, desired: "free" | "listening", timeout: number): Promise<boolean> {
  const started = Date.now();
  while (true) {
    const listening = await portIsListening(process, String(port));
    if ((desired === "free" && !listening) || (desired === "listening" && listening)) return true;
    if (Date.now() - started >= timeout * 1000) return false;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function identityFromHost(process: ProcessAdapter, recordHost: Host, workspace: string | null, terminalId: string, marker: string, timeoutMs: number): Promise<number | undefined> {
  const provider = getHost(recordHost);
  const call = provider?.read({ workspaceId: workspace, terminalId });
  if (call?.kind !== "ok") return undefined;
  const attempts = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await process.run(call.value.command, call.value.args);
    if (result.kind === "ok") {
      const match = result.value.stdout.match(new RegExp(`${marker}=([0-9]+)`));
      if (match?.[1] !== undefined) return Number(match[1]);
    }
    if (attempt + 1 < attempts) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return undefined;
}

async function createHost(process: ProcessAdapter, recordHost: Host, workspace: string | null, worktreePath: string, title: string | null, command: string): Promise<Result<{ readonly value: JsonObject; readonly launch: string; readonly stdout: string }>> {
  const launched = launchCommand(command);
  const call = getHost(recordHost)?.create({ workspaceId: workspace, worktreePath, title, command: launched.command });
  if (call === undefined || call.kind !== "ok") return failed(recordHost === "superset" ? "no Superset workspace is registered for the target; run megabrain worktree adopt first" : "cannot create terminal from unknown orchestration host");
  const result = await process.run(call.value.command, call.value.args);
  if (result.kind !== "ok") return result;
  const value = parsed(result.value.stdout);
  if (!isObject(value)) return failed(`${recordHost} terminal create returned no terminal identity`);
  return ok({ value, launch: launched.marker, stdout: result.value.stdout });
}

function jsonNumber(value: JsonObject, paths: readonly (readonly string[])[]): number | null { return firstNumber(value, paths); }

async function recreate(process: ProcessAdapter, record: TerminalLifecycleRecord, command: string): Promise<Result<{ readonly record: TerminalLifecycleRecord; readonly launchId: string }>> {
  const recordHost: Host = record.host === "superset" || record.host === "orca" ? record.host : "unknown";
  const created = await createHost(process, recordHost, record.workspaceId, record.worktree, record.title, command);
  if (created.kind !== "ok") return created;
  const id = getHost(recordHost)?.terminalIdentity(created.value.value);
  if (id === undefined || !safeTerminalId(id)) return failed(`${record.host} terminal recreate returned no terminal identity`);
  const pidFromResponse = jsonNumber(created.value.value, [["pid"], ["processId"], ["terminal", "pid"], ["result", "terminal", "pid"], ["result", "pid"]]);
  const pid = pidFromResponse ?? await identityFromHost(process, recordHost, record.workspaceId, id, created.value.launch, 10000);
  if (pid === undefined) {
    const close = hostCommand(recordHost, "close", { workspaceId: record.workspaceId, terminalId: id });
    if (close !== undefined) await process.run(close.command, close.args);
    return failed(`${record.host} terminal recreate did not publish a process identity`);
  }
  const replacement: TerminalLifecycleRecord = {
    ...record,
    terminalId: id,
    command,
    createdAt: new Date().toISOString(),
    pid,
    rootPid: jsonNumber(created.value.value, [["rootPid"], ["processRootPid"], ["terminal", "rootPid"], ["result", "terminal", "rootPid"], ["result", "rootPid"]]) ?? pid,
    port: jsonNumber(created.value.value, [["port"], ["terminal", "port"], ["result", "terminal", "port"], ["result", "port"]]) ?? record.port,
  };
  return ok({ record: replacement, launchId: id });
}

export async function executeTerminalLifecycle(args: readonly string[], env: Environment, process: ProcessAdapter): Promise<Result<string>> {
  const operation = args[0];
  const rest = args.slice(1);
  let json = false;
  let selector: string | undefined;
  let command: string | undefined;
  let title: string | null = null;
  let worktreePath: string | undefined;
  let port: number | null = null;
  let waitPort: string | undefined;
  let timeout = 30;
  if (rest.includes("-h") || rest.includes("--help")) return ok(help(operation ?? ""));
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--json") json = true;
    else if (["--command", "--title", "--worktree", "--port", "--wait-port", "--timeout"].includes(arg)) {
      const value = rest[++index];
      if (value === undefined) return failed(`${arg} requires a value`, 2);
      if (arg === "--command") command = value;
      else if (arg === "--title") title = value;
      else if (arg === "--worktree") worktreePath = value;
      else if (arg === "--wait-port") waitPort = value;
      else if (arg === "--timeout") timeout = Number(value);
      else if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return failed("terminal create port must be between 1 and 65535", 2);
      if (arg === "--port") port = Number(value);
    } else if (!arg.startsWith("-") && selector === undefined) selector = arg;
    else return failed(`unknown terminal ${operation} option: ${arg}`, 2);
  }
  if (operation === "restart" && (!Number.isInteger(timeout) || timeout < 0)) return failed("terminal restart timeout must be a non-negative number of seconds", 2);
  if (operation === "restart" && waitPort !== undefined && !/^[0-9]+$/.test(waitPort)) return failed("terminal restart wait port must be numeric", 2);
  const currentDirectory = env.PWD ?? ".";
  if (operation === "create") {
    const path = await worktree(process, worktreePath, currentDirectory);
    if (path.kind !== "ok") return path;
    const currentHost = host(env);
    const workspace = currentHost === "superset" ? await workspaceId(process, path.value) : null;
    if (currentHost === "superset" && workspace === undefined) return failed(`no Superset workspace is registered for ${path.value}; run megabrain worktree adopt ${path.value} first`);
    const resolvedCommand = command ?? await commandFromConfig(path.value);
    if (resolvedCommand === undefined) return failed(`no --command given and no .superset/config.json run script found in ${path.value}`, 2);
    const created = await createHost(process, currentHost, workspace ?? null, path.value, title, resolvedCommand);
    if (created.kind !== "ok") return created;
    const id = getHost(currentHost)?.terminalIdentity(created.value.value);
    if (id === undefined || !safeTerminalId(id)) return failed(`${currentHost} terminal create returned no terminal identity`);
    const pidFromResponse = jsonNumber(created.value.value, [["pid"], ["processId"], ["terminal", "pid"], ["result", "terminal", "pid"]]);
    const pid = pidFromResponse ?? await identityFromHost(process, currentHost, workspace ?? null, id, created.value.launch, 10000);
    if (pid === undefined) {
      const close = hostCommand(currentHost, "close", { workspaceId: workspace ?? null, terminalId: id });
      if (close !== undefined) await process.run(close.command, close.args);
      return failed(`${currentHost} terminal create did not publish a process identity`);
    }
    const record: TerminalLifecycleRecord = { terminalId: id, host: currentHost, workspaceId: workspace ?? null, worktree: path.value, title, command: resolvedCommand, createdAt: new Date().toISOString(), pid, rootPid: jsonNumber(created.value.value, [["rootPid"], ["processRootPid"], ["terminal", "rootPid"], ["result", "rootPid"]]) ?? pid, port: port ?? jsonNumber(created.value.value, [["port"], ["terminal", "port"], ["result", "port"]]) };
    await save(env, record);
    return ok(json ? output({ host: currentHost, worktree: path.value, title, terminalId: id, pid: record.pid, rootPid: record.rootPid, port: record.port }, true) : created.value.stdout);
  }
  const all = await records(env);
  if (selector === undefined) return failed(`terminal ${operation} requires a selector`, 2);
  const normalized = await normalizedSelector(process, selector, currentDirectory);
  if (normalized.kind !== "ok") return normalized;
  const record = resolveTerminalSelector(all, normalized.value);
  if (record === undefined) {
    if (operation === "restart" && selector.startsWith("port:")) {
      const selectedPort = selectorValue(selector);
      return failed(await portIsListening(process, selectedPort) ? `terminal selector could not be resolved: ${selector} (listener was not created by megabrain)` : `port ${selectedPort} is not listening`);
    }
    return failed(operation === "restart" ? `terminal selector could not be resolved: ${selector}` : "terminal selector could not be resolved");
  }
  if (operation === "close") {
    const call = hostCommand(record.host, "close", record);
    if (call === undefined) return failed(`could not verify host terminal ${record.terminalId} before close`);
    const listed = await hostList(process, record);
    if (listed === undefined) return failed(`could not verify host terminal ${record.terminalId} before close`);
    if (!listed.some((item) => hostId(item) === record.terminalId)) {
      await rm(join(stateDir(env), `${record.terminalId}.json`), { force: true });
      return ok(json ? output({ selector, terminalId: record.terminalId, status: "stale", recordRemoved: true, message: "host no longer knows this terminal" }, true) : `selector: ${selector}\nterminal: ${record.terminalId}\nstatus: stale\nrecord removed: true\nhost no longer knows this terminal\n`, 1);
    }
    const result = await process.run(call.command, call.args);
    if (result.kind !== "ok") return failed(`could not close host terminal ${record.terminalId}; record retained`);
    try { await rm(join(stateDir(env), `${record.terminalId}.json`), { force: true }); } catch { return failed(`host terminal ${record.terminalId} closed but its record could not be removed`); }
    const identity = record.rootPid !== null || record.pid !== null ? "recorded" : "unavailable";
    return ok(json ? output({ selector, terminalId: record.terminalId, status: "closed", identity, recordRemoved: true }, true) : `selector: ${selector}\nterminal: ${record.terminalId}\nstatus: closed\nidentity: ${identity}\nrecord removed: true\n`);
  }
  if (operation !== "restart") return failed(`unknown terminal operation: ${operation}`, 2);
  const root = record.rootPid ?? record.pid;
  if (root === null) return failed(`terminal ${selectorValue(selector)} has no recorded process identity; refusing to kill an unowned process`);
  const targetPort = selector.startsWith("port:") ? selectorValue(selector) : record.port;
  const targetPid = targetPort === null ? String(root) : await listenerPid(process, targetPort);
  if (selector.startsWith("port:") && targetPid === undefined) return failed(`port ${selectorValue(selector)} is not listening`);
  if (targetPid !== undefined && !(await belongsToTree(process, String(root), targetPid))) return failed(`terminal ${selectorValue(selector)} process tree is not owned by megabrain; refusing to kill it`);
  const killedTree = await killTree(process, String(root));
  if (killedTree === undefined) return failed(`could not stop terminal process tree rooted at ${root}`);
  if (targetPort !== null && !(await waitForPort(process, targetPort, "free", timeout))) return failed(`timed out waiting for port ${targetPort} to become free`);
  const replacement = await recreate(process, record, command ?? record.command);
  if (replacement.kind !== "ok") return replacement;
  await save(env, replacement.value.record);
  if (replacement.value.record.terminalId !== record.terminalId) await rm(join(stateDir(env), `${record.terminalId}.json`), { force: true });
  const waitedPort = waitPort;
  if (waitedPort !== undefined && !(await waitForPort(process, waitedPort, "listening", timeout))) return failed(`timed out waiting for port ${waitedPort} to listen again`);
  const reportedPort = waitedPort ?? targetPort;
  return ok(json
    ? output({ selector, killedPid: root, killedTree, recreated: true, recreatedTerminalId: replacement.value.record.terminalId, port: reportedPort === null ? null : Number(reportedPort), listeningAfterMs: 0 }, true)
    : `selector: ${selector}\nkilled pid: ${root}\nrecreated terminal: ${replacement.value.record.terminalId}\n${waitedPort === undefined ? "" : `port ${waitedPort} listening after 0ms\n`}`);
}
