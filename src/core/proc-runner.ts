import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { failed, ok, type Result } from "./result.js";
import { checkTerminalFlag, openViewer, viewerLine } from "../cli/commands/terminal-open.js";

export type ProcStart = Readonly<{ name: string; worktree: string; cwd: string; port?: number; env: Record<string, string>; terminal?: string; command: string[]; shell?: string; json: boolean }>;
export type ProcLogOptions = Readonly<{ tail?: number; since?: string; grep?: string; errors?: boolean; full?: boolean }>;
export type ProcRecord = ProcStart & Readonly<{ owner: string; session: string; pid: number; startedAt: string; state: "running" | "exited"; exitCode?: number }>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const ERROR_LINE = /\b(error|exception|fatal|panic)\b|\bat\s+[^ ]+\s*\(|\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\s+[^\s]+/i;
const MAX_LOG = 10 * 1024 * 1024;
const LOG_FILES = 3;

export function isProcErrorLine(line: string): boolean { return ERROR_LINE.test(line); }
function timestamp(line: string): number { const match = /^(\S+)\s/.exec(line); const value = match?.[1] ? Date.parse(match[1]) : NaN; return Number.isFinite(value) ? value : 0; }
function sinceMillis(value: string): number | undefined {
  const relative = /^(\d+)(s|m|h|d)$/.exec(value);
  if (relative?.[1] && relative[2]) return Date.now() - Number(relative[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[relative[2] as "s" | "m" | "h" | "d"]);
  const date = Date.parse(value); return Number.isFinite(date) ? date : undefined;
}
export function filterProcLogLines(lines: readonly string[], options: ProcLogOptions): string[] {
  const cutoff = options.since === undefined ? undefined : sinceMillis(options.since);
  let selected = lines.filter((line) => (options.grep === undefined || new RegExp(options.grep, "i").test(line)) &&
    (cutoff === undefined || timestamp(line) >= cutoff) && (!options.errors || isProcErrorLine(line)));
  if (!options.full && options.tail !== undefined) selected = selected.slice(-options.tail);
  return selected;
}

export function parseProcStartArguments(args: readonly string[]): Result<ProcStart> {
  const parsed: { name?: string; worktree?: string; cwd?: string; port?: number; env: Record<string, string>; terminal?: string; command?: string[]; shell?: string; json: boolean } = { env: {}, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--") { parsed.command = args.slice(i + 1); break; }
    if (arg === "--json") parsed.json = true;
    else if (["--name", "--worktree", "--cwd", "--port", "--env", "--terminal", "--shell"].includes(arg)) {
      const value = args[++i]; if (value === undefined || value === "" || value.startsWith("--")) return failed(`${arg} requires a value`, 2);
      if (arg === "--name") parsed.name = value;
      else if (arg === "--worktree") parsed.worktree = value;
      else if (arg === "--cwd") parsed.cwd = value;
      else if (arg === "--terminal") parsed.terminal = value;
      else if (arg === "--shell") parsed.shell = value;
      else if (arg === "--port") { const n = Number(value); if (!Number.isInteger(n) || n < 1 || n > 65535) return failed("--port must be between 1 and 65535", 2); parsed.port = n; }
      else { const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value); if (!match?.[1] || match[2] === undefined) return failed("--env requires KEY=VALUE", 2); parsed.env[match[1]] = match[2]; }
    } else return failed(`unknown proc start option: ${arg}`, 2);
  }
  if (!parsed.name || !NAME.test(parsed.name)) return failed("proc start requires a valid --name", 2);
  if (parsed.terminal !== undefined) { const terminal = checkTerminalFlag(parsed.terminal); if (terminal.kind !== "ok") return terminal; }
  if (!parsed.command?.length && parsed.shell === undefined) return failed("proc start requires -- <command and arguments>", 2);
  if (parsed.shell !== undefined && parsed.command?.length) return failed("use either --shell or -- command, not both", 2);
  const worktree = resolve(parsed.worktree ?? process.cwd());
  return ok({ name: parsed.name, worktree, cwd: resolve(parsed.cwd ?? worktree), ...(parsed.port === undefined ? {} : { port: parsed.port }), env: parsed.env, ...(parsed.terminal === undefined ? {} : { terminal: parsed.terminal }), command: parsed.command ?? [], ...(parsed.shell === undefined ? {} : { shell: parsed.shell }), json: parsed.json });
}

function root(environment: Readonly<Record<string, string | undefined>>): string { return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? homedir(), ".megabrain"), "procs"); }
function owner(environment: Readonly<Record<string, string | undefined>>): string { return environment.MEGABRAIN_SESSION_ID ?? environment.MEGABRAIN_TERMINAL_ID ?? environment.MEGABRAIN_DISPATCH_ID ?? `pid:${process.ppid}`; }
function tmuxArgs(environment: Readonly<Record<string, string | undefined>>, args: readonly string[]): string[] { const socket = environment.MEGABRAIN_TMUX_SOCKET; return [...(socket ? ["-S", socket] : []), ...args]; }
function key(worktree: string): string { return createHash("sha256").update(worktree).digest("hex").slice(0, 16); }
function recordPath(env: Readonly<Record<string, string | undefined>>, worktree: string, name: string): string { return join(root(env), key(worktree), `${name}.json`); }
function logDir(env: Readonly<Record<string, string | undefined>>, record: ProcRecord): string { return join(root(env), key(record.worktree), record.name); }
function sessionName(record: Pick<ProcRecord, "worktree" | "name">): string { return `mb-proc-${key(record.worktree)}-${record.name}`; }
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function commandFor(record: ProcRecord, state: string): string {
  const script = `const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');const c=JSON.parse(Buffer.from(process.argv[1],'base64').toString());const d=c.dir;fs.mkdirSync(d,{recursive:true});let f=path.join(d,'proc.log');const child=cp.spawn(c.cmd[0],c.cmd.slice(1),{cwd:c.cwd,env:{...process.env,...c.env},stdio:['ignore','pipe','pipe']});let pending='';function out(x){pending+=x.toString();let a=pending.split(/\\r?\\n/);pending=a.pop()||'';for(const line of a)write(line)}function write(line){let b=Buffer.byteLength(line+'\\n');try{if(fs.existsSync(f)&&fs.statSync(f).size+b>${MAX_LOG}){for(let i=${LOG_FILES - 1};i>=1;i--){let from=f+'.'+i,to=f+'.'+(i+1);if(fs.existsSync(from)){if(i+1>=${LOG_FILES})fs.unlinkSync(from);else fs.renameSync(from,to)}}if(fs.existsSync(f))fs.renameSync(f,f+'.1')}}catch{}fs.appendFileSync(f,new Date().toISOString()+' '+line+'\\n')}child.stdout.on('data',out);child.stderr.on('data',out);child.on('close',code=>{if(pending)write(pending);write('process exited with code '+(code??1));fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({...c.record,state:'exited',exitCode:code??1},null,2)+'\\n')});`;
  const stateRoot = dirname(dirname(state));
  const payload = Buffer.from(JSON.stringify({ cmd: record.shell === undefined ? record.command : ["/bin/sh", "-lc", record.shell], cwd: record.cwd, env: record.env, dir: join(stateRoot, key(record.worktree), record.name), record, state })).toString("base64");
  return `node -e ${quote(script)} ${quote(payload)}`;
}

async function readRecord(path: string): Promise<ProcRecord | undefined> { try { return JSON.parse(await readFile(path, "utf8")) as ProcRecord; } catch { return undefined; } }
async function writeRecord(path: string, record: ProcRecord): Promise<void> { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }); }
async function portOwner(process: ProcessAdapter, port: number): Promise<string | undefined> {
  const result = await process.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  if (result.kind !== "ok") return undefined;
  const pid = /^p(\d+)$/m.exec(result.value.stdout)?.[1]; const cmd = /^c(.+)$/m.exec(result.value.stdout)?.[1]; return pid ? `pid ${pid}${cmd ? ` (${cmd})` : ""}` : undefined;
}
async function owns(record: ProcRecord, environment: Readonly<Record<string, string | undefined>>, force: boolean): Promise<boolean> { return force || record.owner === owner(environment); }

export async function executeProc(args: readonly string[], environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) {
    const { usageText } = await import("./usage.js");
    const helpKey = args[0] === "start" ? "proc-start" : args[0] === "logs" ? "proc-logs" : args[0] === "list" ? "proc-list" : args[0] === "status" ? "proc-status" : args[0] === "stop" ? "proc-stop" : args[0] === "restart" ? "proc-restart" : "proc";
    return ok(usageText(helpKey));
  }
  const [verb, ...rest] = args;
  if (verb === "start") return startProc(rest, environment, process);
  if (verb === "logs") return procLogs(rest, environment, process);
  if (verb === "list") return procList(rest, environment, process);
  if (["status", "stop", "restart"].includes(verb ?? "")) return procAction(verb!, rest, environment, process);
  return failed("proc requires start|list|status|stop|restart|logs", 2);
}

async function startProc(args: readonly string[], environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<string>> {
  const parsed = parseProcStartArguments(args); if (parsed.kind !== "ok") return parsed;
  const spec = parsed.value; const path = recordPath(environment, spec.worktree, spec.name); await mkdir(dirname(path), { recursive: true });
  const lock = `${path}.lock`; try { await mkdir(lock); } catch { return failed(`proc ${spec.name} is being changed; try again`); }
  try {
    const old = await readRecord(path);
    if (old?.state === "running") {
      const live = await process.run("tmux", tmuxArgs(environment, ["has-session", "-t", old.session]));
      if (live.kind === "ok") return failed(`proc ${spec.name} is already running`);
    }
    if (spec.port !== undefined) { const taken = await portOwner(process, spec.port); if (taken) return failed(`port ${spec.port} is already in use by ${taken}`); }
    const session = sessionName({ worktree: spec.worktree, name: spec.name });
    let record: ProcRecord = { ...spec, owner: owner(environment), session, pid: 0, startedAt: new Date().toISOString(), state: "running" };
    await mkdir(logDir(environment, record), { recursive: true });
    const command = commandFor(record, path);
    const started = await process.run("tmux", tmuxArgs(environment, ["new-session", "-d", "-s", session, "-c", spec.cwd, command]));
    if (started.kind !== "ok") return failed(started.error);
    const pane = await process.run("tmux", tmuxArgs(environment, ["display-message", "-p", "-t", `${session}:0.0`, "#{pane_pid}"]));
    record = { ...record, pid: pane.kind === "ok" ? Number(pane.value.stdout.trim()) : 0 };
    await writeRecord(path, record);
    if (spec.port !== undefined) {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) { if (await portOwner(process, spec.port)) return startedOutput(spec, record, environment, process); await new Promise((resolve) => setTimeout(resolve, 100)); }
      await stopRecord(record, process, environment); return failed(`proc ${spec.name} did not listen on port ${spec.port} within 30s`);
    }
    return startedOutput(spec, record, environment, process);
  } finally { const { rm } = await import("node:fs/promises"); await rm(lock, { recursive: true, force: true }); }
}

async function startedOutput(spec: ProcStart, record: ProcRecord, environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<string>> {
  const viewer = spec.terminal === undefined ? undefined : await openViewer({ session: record.session, flag: spec.terminal, automatic: true, env: environment, process });
  return ok(spec.json ? `${JSON.stringify({ ...record, viewer: viewer ?? null }, null, 2)}\n` : `started ${spec.name} (pid ${record.pid}${spec.port ? `, port ${spec.port}` : ""})\n${viewer ? viewerLine(viewer) : ""}`);
}

async function procPath(args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<{ path: string; record: ProcRecord } | undefined> {
  const name = args[0]; if (!name || !NAME.test(name)) return undefined;
  let worktree = resolve(env.MEGABRAIN_WORKTREE ?? process.cwd());
  const index = args.indexOf("--worktree"); if (index >= 0 && args[index + 1]) worktree = resolve(args[index + 1]!);
  const path = recordPath(env, worktree, name); const record = await readRecord(path); return record ? { path, record } : undefined;
}
async function procList(args: readonly string[], env: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<string>> {
  const json = args.includes("--json"); if (args.some((x) => x !== "--json")) return failed("proc list accepts [--json]", 2);
  const rows: ProcRecord[] = []; const dirs = await readdir(root(env), { withFileTypes: true }).catch(() => []);
  for (const d of dirs.filter((x) => x.isDirectory())) for (const f of await readdir(join(root(env), d.name)).catch(() => [])) if (f.endsWith(".json")) { let r = await readRecord(join(root(env), d.name, f)); if (!r) continue; if (r.state === "running" && (await process.run("tmux", tmuxArgs(env, ["has-session", "-t", r.session]))).kind !== "ok") r = { ...r, state: "exited" }; rows.push(r); }
  return ok(json ? `${JSON.stringify(rows, null, 2)}\n` : `${rows.map((r) => `${r.name}\t${r.state}\t${r.pid}\t${r.worktree}`).join("\n")}${rows.length ? "\n" : ""}`);
}
async function procAction(verb: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<string>> {
  const force = args.includes("--force"), json = args.includes("--json"); const found = await procPath(args.filter((x) => !x.startsWith("--")), env); if (!found) return failed(`proc not found: ${args[0] ?? ""}`);
  const { path } = found; let record = found.record;
  if (!(await owns(record, env, force))) return failed(`proc ${record.name} is owned by another caller; use --force`);
  if (verb === "status") {
    const live = await process.run("tmux", tmuxArgs(env, ["has-session", "-t", record.session])); if (live.kind !== "ok") record = { ...record, state: "exited" };
    const resources = record.pid > 1 ? await process.run("ps", ["-p", String(record.pid), "-o", "rss=,%cpu="]) : undefined;
    const elapsed = Math.max(0, Math.floor((Date.now() - Date.parse(record.startedAt)) / 1000)); const listen = record.port === undefined ? undefined : await portOwner(process, record.port);
    const result = { ...record, uptimeSeconds: elapsed, listening: record.port === undefined ? undefined : listen !== undefined, resources: resources?.kind === "ok" ? resources.value.stdout.trim() : undefined };
    return ok(json ? `${JSON.stringify(result, null, 2)}\n` : `${record.name}: ${record.state}, pid ${record.pid}, uptime ${elapsed}s${record.port ? `, port ${record.port} ${listen ? "listening" : "not listening"}` : ""}${result.resources ? `, RSS/CPU ${result.resources}` : ""}${record.exitCode === undefined ? "" : `, exit ${record.exitCode}`}\n`);
  }
  if (verb === "stop") { await stopRecord(record, process, env); return ok(`stopped ${record.name}\n`); }
  const stopped = await stopRecord(record, process, env); if (stopped.kind !== "ok") return stopped;
  const startArgs = ["--name", record.name, "--worktree", record.worktree, "--cwd", record.cwd, ...(record.port ? ["--port", String(record.port)] : []), ...Object.entries(record.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]), ...(record.terminal ? ["--terminal", record.terminal] : []), ...(record.shell ? ["--shell", record.shell] : []), "--", ...record.command];
  return startProc(startArgs, env, process);
}
async function stopRecord(record: ProcRecord, process: ProcessAdapter, env: Readonly<Record<string, string | undefined>>): Promise<Result<void>> {
  if (record.pid > 1) {
    const table = await process.run("ps", ["-A", "-o", "pid=,ppid="]);
    if (table.kind === "ok") {
      const parents = new Map<number, number>();
      for (const line of table.value.stdout.trim().split(/\r?\n/)) { const [pid, ppid] = line.trim().split(/\s+/).map(Number); if (Number.isFinite(pid) && Number.isFinite(ppid)) parents.set(pid!, ppid!); }
      const tree = new Set([record.pid]); let changed = true;
      while (changed) { changed = false; for (const [pid, ppid] of parents) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); changed = true; } }
      for (const pid of [...tree].sort((a, b) => a === record.pid ? -1 : b === record.pid ? 1 : b - a)) await process.run("kill", ["-TERM", String(pid)]);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const after = await process.run("ps", ["-A", "-o", "pid=,ppid="]);
      if (after.kind === "ok") {
        const remaining = new Set<number>(); const rows = after.value.stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number));
        for (const [pid, ppid] of rows) if (Number.isFinite(pid) && (tree.has(pid!) || tree.has(ppid!))) remaining.add(pid!);
        for (const pid of remaining) await process.run("kill", ["-KILL", String(pid)]);
      }
    }
  }
  const result = await process.run("tmux", tmuxArgs(env, ["kill-session", "-t", record.session]));
  return result.kind === "ok" ? ok(undefined) : failed(result.error);
}
async function procLogs(args: readonly string[], env: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<Result<string>> {
  const name = args[0]; const found = await procPath(args, env); if (!name || !found) return failed(`proc not found: ${name ?? ""}`);
  const options: { tail?: number; since?: string; grep?: string; errors?: boolean; full?: boolean } = {}; let json = false;
  for (let i = 1; i < args.length; i += 1) { const arg = args[i] ?? ""; if (arg === "--errors" || arg === "--full" || arg === "--follow" || arg === "--json") { if (arg === "--errors") options.errors = true; if (arg === "--full") options.full = true; if (arg === "--json") json = true; } else if (["--tail", "--since", "--grep"].includes(arg)) { const value = args[++i]; if (!value) return failed(`${arg} requires a value`, 2); if (arg === "--tail") { const n = Number(value); if (!Number.isInteger(n) || n < 0) return failed("--tail must be a non-negative integer", 2); options.tail = n; } else if (arg === "--since") options.since = value; else options.grep = value; } else return failed(`unknown proc logs option: ${arg}`, 2); }
  if (options.since !== undefined && sinceMillis(options.since) === undefined) return failed("--since must be a duration such as 5m or an ISO date", 2);
  if (options.grep !== undefined) { try { new RegExp(options.grep); } catch { return failed("--grep requires a valid regular expression", 2); } }
  const dir = logDir(env, found.record); const collect = async (): Promise<string[]> => {
    const files = (await readdir(dir).catch(() => [])).filter((f) => f === "proc.log" || /^proc\.log\.\d+$/.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
    const lines: string[] = []; for (const file of files) { const content = await readFile(join(dir, file), "utf8").catch(() => ""); lines.push(...content.split(/\r?\n/).filter(Boolean)); }
    return filterProcLogLines(lines, options);
  };
  if (args.includes("--follow")) {
    let prior = new Set<string>(); let output = "";
    while ((await process.run("tmux", tmuxArgs(env, ["has-session", "-t", found.record.session]))).kind === "ok") {
      const lines = await collect(); const next = lines.filter((line) => !prior.has(line));
      if (next.length) { const chunk = `${next.join("\n")}\n`; output += chunk; globalThis.process.stdout.write(chunk); prior = new Set(lines); }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return ok(output);
  }
  const lines = await collect(); return ok(json ? `${JSON.stringify({ name, lines }, null, 2)}\n` : `${lines.join("\n")}${lines.length ? "\n" : ""}`);
}
