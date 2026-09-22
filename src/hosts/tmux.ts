import { type ProcessAdapter } from "../adapters/proc.js";
import { mkdir, rm, stat } from "node:fs/promises";
import { failed, ok, unknown, type Result } from "../core/result.js";

export type TmuxSendEnvironment = Readonly<Record<string, string | undefined>>;

export type TmuxProvider = Readonly<{
  readonly id: string;
  readonly sessionForPane: (pane: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly sessionExists: (session: string, process: ProcessAdapter) => Promise<Result<boolean>>;
  readonly panesForSession: (session: string, process: ProcessAdapter) => Promise<Result<readonly string[]>>;
  readonly panePid: (pane: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly capturePane: (pane: string, lines: number, process: ProcessAdapter) => Promise<Result<string>>;
  readonly sendText: (pane: string, text: string, process: ProcessAdapter) => Promise<Result<void>>;
  readonly sendKey: (pane: string, key: string, process: ProcessAdapter) => Promise<Result<void>>;
  readonly killPane: (pane: string, process: ProcessAdapter) => Promise<Result<void>>;
  readonly killSession: (session: string, process: ProcessAdapter) => Promise<Result<void>>;
  readonly listSessions: (process: ProcessAdapter, format?: string) => Promise<Result<readonly string[]>>;
  readonly globalOption: (option: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly sessionOption: (session: string, option: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly sourceFile: (path: string, process: ProcessAdapter) => Promise<Result<void>>;
  readonly showEnvironment: (session: string, variable: string, process: ProcessAdapter) => Promise<Result<string>>;
}>;

function unavailable(query: string): Result<never> {
  return unknown(`tmux ${query} could not be determined`);
}

async function runAction(args: readonly string[], process: ProcessAdapter): Promise<Result<void>> {
  const result = await process.run("tmux", args);
  return result.kind === "ok" ? ok(undefined) : failed(result.error);
}

async function query(args: readonly string[], description: string, process: ProcessAdapter): Promise<Result<string>> {
  const result = await process.run("tmux", args);
  return result.kind === "ok" ? ok(result.value.stdout) : unavailable(description);
}

const provider: TmuxProvider = {
  id: "tmux",
  sessionForPane: async (pane, process) => {
    const result = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"]);
    if (result.kind !== "ok") return unavailable(`session for pane ${pane}`);
    const session = result.value.stdout.trim();
    return session.length > 0 ? ok(session) : unavailable(`session for pane ${pane}`);
  },
  sessionExists: async (session, process) => {
    const result = await process.run("tmux", ["has-session", "-t", session]);
    return result.kind === "ok" ? ok(true) : unavailable(`existence of session ${session}`);
  },
  panesForSession: async (session, process) => {
    const result = await process.run("tmux", ["list-panes", "-t", session, "-F", "#{pane_id}"]);
    if (result.kind !== "ok") return unavailable(`panes for session ${session}`);
    return ok(result.value.stdout.split("\n").filter((pane) => pane.length > 0));
  },
  panePid: async (pane, process) => {
    const result = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{pane_pid}"]);
    if (result.kind !== "ok") return unavailable(`PID for pane ${pane}`);
    const pid = result.value.stdout.trim();
    return pid.length > 0 ? ok(pid) : unavailable(`PID for pane ${pane}`);
  },
  capturePane: async (pane, lines, process) => {
    const result = await process.run("tmux", ["capture-pane", "-p", "-t", pane, "-S", `-${lines}`]);
    return result.kind === "ok" ? ok(result.value.stdout) : unavailable(`capture of pane ${pane}`);
  },
  sendText: async (pane, text, process) => {
    const result = await process.run("tmux", ["send-keys", "-t", pane, "-l", text]);
    return result.kind === "ok" ? ok(undefined) : failed(result.error);
  },
  sendKey: async (pane, key, process) => {
    const result = await process.run("tmux", ["send-keys", "-t", pane, key]);
    return result.kind === "ok" ? ok(undefined) : failed(result.error);
  },
  killPane: async (pane, process) => runAction(["kill-pane", "-t", pane], process),
  killSession: async (session, process) => runAction(["kill-session", "-t", session], process),
  listSessions: async (process, format) => {
    const result = await query(format === undefined ? ["list-sessions"] : ["list-sessions", "-F", format], "sessions", process);
    return result.kind === "ok" ? ok(result.value.split("\n").filter((session) => session.length > 0)) : result;
  },
  globalOption: async (option, process) => query(["show-options", "-gqv", option], `global option ${option}`, process),
  sessionOption: async (session, option, process) => query(["show-options", "-t", session, "-v", option], `session option ${option} for session ${session}`, process),
  sourceFile: async (path, process) => runAction(["source-file", path], process),
  showEnvironment: async (session, variable, process) => query(["show-environment", "-t", session, variable], `environment ${variable} for session ${session}`, process),
};

const registry = new Map<string, TmuxProvider>([[provider.id, provider]]);

export function registerTmux(value: TmuxProvider): void {
  registry.set(value.id, { ...provider, ...value });
}

export function unregisterTmux(id: string): void {
  registry.delete(id);
}

export function getTmux(): TmuxProvider {
  return registry.get(provider.id) ?? provider;
}

export type TmuxSessionWaitOptions = Readonly<{
  readonly attempts?: number;
  readonly waitMs?: number;
}>;

export async function createTmuxSession(
  session: string,
  worktreePath: string,
  command: string,
  process: ProcessAdapter,
): Promise<Result<void>> {
  const result = await process.run("tmux", ["new-session", "-d", "-A", "-s", session, "-c", worktreePath, command]);
  return result.kind === "ok" ? ok(undefined) : failed(result.error, result.exitCode);
}

export async function splitTmuxWindow(
  session: string,
  worktreePath: string,
  process: ProcessAdapter,
): Promise<Result<string>> {
  const result = await process.run("tmux", ["split-window", "-d", "-t", session, "-c", worktreePath, "-P", "-F", "#{pane_id}"]);
  if (result.kind !== "ok") return failed(result.error, result.exitCode);
  const pane = result.value.stdout.trim();
  return pane.length > 0 ? ok(pane) : failed(`tmux split for session ${session} returned no pane`);
}

export async function waitForTmuxSession(
  session: string,
  process: ProcessAdapter,
  options: TmuxSessionWaitOptions = {},
): Promise<Result<void>> {
  const attempts = Math.max(1, options.attempts ?? 600);
  const waitMs = Math.max(0, options.waitMs ?? 100);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const exists = await getTmux().sessionExists(session, process);
    if (exists.kind === "ok") return ok(undefined);
    if (attempt < attempts && waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return failed(`tmux session ${session} did not become available`);
}

function lockPath(root: string, pane: string): string {
  return `${root}/locks/tmux/${encodeURIComponent(pane)}.lock`;
}

async function acquireLock(path: string, environment: TmuxSendEnvironment): Promise<Result<void>> {
  const waitSeconds = Number(environment.MEGABRAIN_LOCK_WAIT_SECONDS ?? "15");
  const staleSeconds = Number(environment.MEGABRAIN_LOCK_STALE_SECONDS ?? "30");
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  while (true) {
    try {
      await mkdir(path);
      return ok(undefined);
    } catch {
      try {
        const age = (Date.now() - (await stat(path)).mtimeMs) / 1000;
        if (age >= staleSeconds) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) return failed(`mailbox lock is held by another writer: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export async function sendTmuxPair(
  root: string,
  pane: string,
  text: string,
  key: string,
  environment: TmuxSendEnvironment,
  process: ProcessAdapter,
): Promise<Result<void>> {
  const lock = lockPath(root, pane);
  try {
    await mkdir(`${root}/locks/tmux`, { recursive: true });
  } catch {
    return failed(`could not prepare tmux send lock: ${lock}`);
  }
  const acquired = await acquireLock(lock, environment);
  if (acquired.kind !== "ok") return acquired;
  try {
    const sentText = await getTmux().sendText(pane, text, process);
    if (sentText.kind !== "ok") return sentText;
    return await getTmux().sendKey(pane, key, process);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
