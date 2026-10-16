import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { APP_SESSION_PREFIX, readAppTerminals } from "./app-terminals.js";
import { readProcRecords } from "./proc-runner.js";
import { failed, ok, type Result } from "./result.js";
import { OWNED_TMUX_SERVER } from "./session-ownership.js";

type Environment = Readonly<Record<string, string | undefined>>;

/** What the port verbs touch outside themselves, so tests can run them against a fake machine. */
export type PortSystem = Readonly<{
  process: ProcessAdapter;
  environment: Environment;
  uid: number;
  /** This process: it and its ancestors are never stopped. */
  self: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  canBind: (port: number) => Promise<boolean>;
  signal: (pid: number, signal: NodeJS.Signals | 0) => void;
}>;

export type PortManaged =
  | Readonly<{ kind: "proc"; name: string; worktree: string }>
  | Readonly<{ kind: "app-terminal"; session: string; title: string }>;

export type PortListener = Readonly<{
  pid: number;
  command: string;
  args: string;
  cwd: string | null;
  startedAt: string | null;
  /** The git checkout the listener runs in, when it runs in one. */
  place: Readonly<{ root: string; project: string; branch: string | null }> | null;
  managed: PortManaged | null;
}>;

type Row = Readonly<{ pid: number; ppid: number; uid: number; elapsedMs: number; tty: string | null; args: string }>;

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "login"]);
const TERM_GRACE_MS = 5000;
const KILL_GRACE_MS = 2000;
const POLL_MS = 100;

export function canBind(port: number): Promise<boolean> {
  const attempt = (host: string) => new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", (cause: NodeJS.ErrnoException) => resolve(cause.code !== "EADDRINUSE" && cause.code !== "EACCES"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
  // Loopback first: a server bound there alone does not stop a wildcard bind on every system.
  return attempt("127.0.0.1").then((free) => (free ? attempt("::") : false));
}

export function systemPorts(environment: Environment, processAdapter: ProcessAdapter): PortSystem {
  return {
    process: processAdapter,
    environment,
    uid: process.getuid?.() ?? -1,
    self: process.pid,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    canBind,
    signal: (pid, signal) => { process.kill(pid, signal); },
  };
}

function elapsed(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (match === null) return 0;
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

async function processTable(system: PortSystem): Promise<Map<number, Row>> {
  const result = await system.process.run("ps", ["-axo", "pid=,ppid=,pgid=,uid=,etime=,tty=,args="], { env: { LC_ALL: "C" } });
  const rows = new Map<number, Row>();
  if (result.kind !== "ok") return rows;
  for (const line of result.value.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, uid, etime, tty, args] = match;
    rows.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), uid: Number(uid), elapsedMs: elapsed(etime!), tty: /^\?+$|^-$/.test(tty!) ? null : tty!, args: args!.trim() });
  }
  return rows;
}

/** The pids listening on TCP `port`, with lsof's short command name for each. */
async function listening(port: number, system: PortSystem): Promise<Result<Array<{ pid: number; command: string }>>> {
  const result = await system.process.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
  // lsof exits 1 with no output when nothing matches.
  if (result.kind !== "ok") return result.error.includes("executable not found") ? failed("lsof is required to find port listeners") : ok([]);
  const found: Array<{ pid: number; command: string }> = [];
  let current: { pid: number; command: string } | undefined;
  for (const line of result.value.stdout.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = found.find((item) => item.pid === pid);
      if (current === undefined) { current = { pid, command: "" }; found.push(current); }
    } else if (line.startsWith("c") && current !== undefined && current.command === "") current.command = line.slice(1);
  }
  return ok(found);
}

function lineage(rows: Map<number, Row>, pid: number): number[] {
  const chain: number[] = [];
  for (let row = rows.get(pid); row !== undefined && !chain.includes(row.pid); row = rows.get(row.ppid)) chain.push(row.pid);
  return chain;
}

async function cwdOf(pid: number, system: PortSystem): Promise<string | null> {
  const result = await system.process.run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  return result.kind === "ok" ? /^n(.+)$/m.exec(result.value.stdout)?.[1] ?? null : null;
}

async function placeOf(cwd: string, system: PortSystem): Promise<PortListener["place"]> {
  const paths = await system.process.run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  if (paths.kind !== "ok") return null;
  const [root, common] = paths.value.stdout.trim().split("\n");
  if (root === undefined || root === "") return null;
  const branch = await system.process.run("git", ["-C", cwd, "branch", "--show-current"]);
  const name = branch.kind === "ok" ? branch.value.stdout.trim() : "";
  return { root, project: common !== undefined && basename(common) === ".git" ? basename(dirname(common)) : basename(root), branch: name === "" ? null : name };
}

function stateDirectory(environment: Environment): string {
  return environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? homedir(), ".megabrain");
}

async function managedBy(chain: readonly number[], system: PortSystem): Promise<PortManaged | null> {
  const proc = (await readProcRecords(system.environment)).find((record) => record.state === "running" && chain.includes(record.pid));
  if (proc !== undefined) return { kind: "proc", name: proc.name, worktree: proc.worktree };
  const panes = await system.process.run("tmux", ["-L", OWNED_TMUX_SERVER, "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"]);
  if (panes.kind !== "ok") return null;
  for (const line of panes.value.stdout.split("\n")) {
    const [session, pane] = line.split("\t");
    if (session === undefined || !session.startsWith(APP_SESSION_PREFIX) || !chain.includes(Number(pane))) continue;
    return { kind: "app-terminal", session, title: readAppTerminals(stateDirectory(system.environment))[session]?.title ?? session };
  }
  return null;
}

export async function portWho(port: number, system: PortSystem): Promise<Result<{ port: number; listeners: PortListener[] }>> {
  const found = await listening(port, system);
  if (found.kind !== "ok") return found;
  if (found.value.length === 0) return ok({ port, listeners: [] });
  const rows = await processTable(system);
  const listeners: PortListener[] = [];
  for (const { pid, command } of found.value) {
    const row = rows.get(pid);
    const cwd = await cwdOf(pid, system);
    listeners.push({
      pid,
      command,
      args: row?.args ?? command,
      cwd,
      startedAt: row === undefined ? null : new Date(system.now() - row.elapsedMs).toISOString(),
      place: cwd === null ? null : await placeOf(cwd, system),
      managed: await managedBy(lineage(rows, pid), system),
    });
  }
  return ok({ port, listeners });
}

async function listeningPorts(system: PortSystem): Promise<Set<number>> {
  const result = await system.process.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"]);
  const ports = new Set<number>();
  if (result.kind !== "ok") return ports;
  for (const line of result.value.stdout.split("\n")) {
    const port = /^n.*:(\d+)$/.exec(line)?.[1];
    if (port !== undefined) ports.add(Number(port));
  }
  return ports;
}

/** The first port from `from` up that nothing listens on and that binds. */
export async function portFree(from: number, system: PortSystem): Promise<Result<{ port: number }>> {
  const busy = await listeningPorts(system);
  for (let port = from; port < 65536; port += 1) {
    if (!busy.has(port) && await system.canBind(port)) return ok({ port });
  }
  return failed(`no free port from ${from}`);
}

const command = (row: Row) => basename(row.args.split(/\s+/)[0] ?? "").replace(/^-/, "");

// An interactive shell is where the person typed the command; a shell running a script (-c) is
// part of what they ran.
const interactiveShell = (row: Row) => SHELLS.has(command(row)) && !row.args.split(/\s+/).slice(1).some((arg) => /^-[a-z]*c[a-z]*$/.test(arg));

/**
 * The top of what the person started: up from the listener through parents on the same terminal,
 * stopping before an interactive shell, a process without a terminal (a tmux server, the app,
 * launchd), another user's process, or megabrain's own line. A watcher such as turbo or pnpm sits
 * on that line, so stopping from the top keeps it from starting the server again.
 */
function topOf(rows: Map<number, Row>, listener: Row, system: PortSystem, protectedPids: ReadonlySet<number>): Row {
  let top = listener;
  for (let parent = rows.get(top.ppid); parent !== undefined; parent = rows.get(top.ppid)) {
    if (parent.pid <= 1 || parent.uid !== system.uid || listener.tty === null || parent.tty !== listener.tty || protectedPids.has(parent.pid) || interactiveShell(parent)) break;
    top = parent;
  }
  return top;
}

function subtree(rows: Map<number, Row>, top: number): number[] {
  const order: number[] = [];
  const visit = (pid: number) => {
    if (order.includes(pid)) return;
    order.push(pid);
    for (const row of rows.values()) if (row.ppid === pid) visit(row.pid);
  };
  visit(top);
  return order;
}

function alive(pid: number, system: PortSystem): boolean {
  try { system.signal(pid, 0); return true; } catch { return false; }
}

async function waitFree(port: number, system: PortSystem, ms: number): Promise<boolean> {
  const deadline = system.now() + ms;
  for (;;) {
    const found = await listening(port, system);
    if (found.kind === "ok" && found.value.length === 0) return true;
    if (system.now() >= deadline) return false;
    await system.sleep(POLL_MS);
  }
}

/** Stops what listens on `port`, from the top of its tree, refusing anything not the caller's own. */
export async function portKill(port: number, system: PortSystem): Promise<Result<{ port: number; top: number; stopped: number[]; freed: boolean }>> {
  const found = await listening(port, system);
  if (found.kind !== "ok") return found;
  if (found.value.length === 0) return failed(`nothing is listening on port ${port}`);
  const rows = await processTable(system);
  const protectedPids = new Set(lineage(rows, system.self));
  const targets: number[] = [];
  let top: number | undefined;
  for (const { pid, command: name } of found.value) {
    const row = rows.get(pid);
    if (row === undefined) continue;
    if (row.uid !== system.uid) return failed(`port ${port} is held by pid ${pid} (${name}), which belongs to another user; megabrain stops only your own processes`);
    if (protectedPids.has(pid)) return failed(`port ${port} is held by pid ${pid} (${name}), which megabrain itself runs under; stop it yourself`);
    const head = topOf(rows, row, system, protectedPids);
    top ??= head.pid;
    for (const member of subtree(rows, head.pid)) {
      const memberRow = rows.get(member);
      if (memberRow !== undefined && memberRow.uid === system.uid && !protectedPids.has(member) && !targets.includes(member)) targets.push(member);
    }
  }
  if (top === undefined) return failed(`port ${port} is held by a process that has already exited; try again`);
  // Parent first, so a watcher is gone before its child's exit could make it start another.
  for (const pid of targets) { try { system.signal(pid, "SIGTERM"); } catch { /* already gone */ } }
  let freed = await waitFree(port, system, TERM_GRACE_MS);
  if (!freed) {
    for (const pid of targets) if (alive(pid, system)) { try { system.signal(pid, "SIGKILL"); } catch { /* already gone */ } }
    freed = await waitFree(port, system, KILL_GRACE_MS);
  }
  if (!freed) return failed(`port ${port} is still in use after stopping pid ${targets.join(", ")}`);
  return ok({ port, top, stopped: targets, freed });
}
