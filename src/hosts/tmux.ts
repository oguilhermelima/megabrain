import { type ProcessAdapter } from "../adapters/proc.js";
import { mkdir, rm, stat } from "node:fs/promises";
import { failed, ok, unknown, type Result } from "../core/result.js";

export type TmuxSendEnvironment = Readonly<Record<string, string | undefined>>;

export type TmuxProvider = Readonly<{
  readonly id: string;
  readonly sessionForPane: (pane: string, process: ProcessAdapter) => Promise<Result<string>>;
  readonly paneCurrentPath?: (pane: string, process: ProcessAdapter) => Promise<Result<string>>;
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
  paneCurrentPath: async (pane, process) => {
    const result = await process.run("tmux", ["display-message", "-p", "-t", pane, "#{pane_current_path}"]);
    if (result.kind !== "ok") return unavailable(`working directory for pane ${pane}`);
    const path = result.value.stdout.trim();
    return path.length > 0 ? ok(path) : unavailable(`working directory for pane ${pane}`);
  },
  sessionExists: async (session, process) => {
    const result = await process.run("tmux", ["has-session", "-t", session]);
    if (result.kind === "ok") return ok(true);
    const detail = result.kind === "failed" ? result.error : "";
    return /can't find session|session not found|no such session/i.test(detail)
      ? ok(false)
      : unavailable(`existence of session ${session}`);
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
  command: string | undefined,
  process: ProcessAdapter,
  reuseExisting = true,
): Promise<Result<void>> {
  const args = ["new-session", "-d", ...(reuseExisting ? ["-A"] : []), "-s", session, "-c", worktreePath];
  // Omitting the trailing command lets tmux start its configured default-shell (which follows
  // $SHELL) instead of hardcoding one; a caller that wants a specific command still can.
  if (command !== undefined) args.push(command);
  const result = await process.run("tmux", args);
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

export async function splitTmuxPane(session: string, targetPane: string, worktreePath: string, process: ProcessAdapter): Promise<Result<string>> {
  const result = await process.run("tmux", ["split-window", "-d", "-h", "-t", targetPane, "-c", worktreePath, "-P", "-F", "#{pane_id}"]);
  if (result.kind !== "ok") return failed(result.error, result.exitCode);
  const pane = result.value.stdout.trim();
  return pane.length > 0 ? ok(pane) : failed(`tmux split for session ${session} returned no pane`);
}

type TmuxPaneLayout = Readonly<{
  readonly pane: string;
  readonly window: string;
  readonly windowIndex: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly windowWidth: number;
}>;

function parsePaneLayouts(output: string): readonly TmuxPaneLayout[] {
  const panes: TmuxPaneLayout[] = [];
  for (const line of output.split("\n")) {
    const [pane, window, windowIndex, left, top, width, windowWidth] = line.split("\t");
    const numbers = [windowIndex, left, top, width, windowWidth].map(Number);
    if (pane === undefined || pane === "" || window === undefined || numbers.some((value) => !Number.isFinite(value))) continue;
    panes.push({ pane, window, windowIndex: numbers[0]!, left: numbers[1]!, top: numbers[2]!, width: numbers[3]!, windowWidth: numbers[4]! });
  }
  return panes;
}

export async function splitTmuxWorktreePane(
  session: string,
  worktreePath: string,
  process: ProcessAdapter,
  callerPane?: string,
): Promise<Result<string>> {
  const format = "#{pane_id}\t#{window_id}\t#{window_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{window_width}";
  const listed = await process.run("tmux", ["list-panes", "-a", "-t", session, "-F", format]);
  if (listed.kind !== "ok") return failed(listed.error, listed.exitCode);
  const panes = parsePaneLayouts(listed.value.stdout);
  const caller = callerPane === undefined ? undefined : panes.find((pane) => pane.pane === callerPane);
  const windows = [...new Set(panes.map((pane) => pane.window))]
    .map((window) => panes.filter((pane) => pane.window === window))
    .sort((first, second) => second[0]!.windowIndex - first[0]!.windowIndex);
  const selected = caller === undefined ? windows[0] : panes.filter((pane) => pane.window === caller.window);
  if (selected === undefined || selected.length === 0 || selected.length >= 4) {
    const result = await process.run("tmux", ["new-window", "-d", "-t", session, "-c", worktreePath, "-P", "-F", "#{pane_id}"]);
    if (result.kind !== "ok") return failed(result.error, result.exitCode);
    const pane = result.value.stdout.trim();
    return pane.length > 0 ? ok(pane) : failed(`tmux new window for session ${session} returned no pane`);
  }

  const main = caller ?? [...selected].sort((first, second) => first.left - second.left || first.top - second.top)[0]!;
  const rightmost = selected
    .filter((pane) => pane.pane !== main.pane && pane.left > main.left)
    .sort((first, second) => second.left - first.left || second.top - first.top)[0];
  const splitArgs = rightmost === undefined
    ? ["split-window", "-d", "-h", "-p", "50", "-t", main.pane, "-c", worktreePath, "-P", "-F", "#{pane_id}"]
    : ["split-window", "-d", "-v", "-t", rightmost.pane, "-c", worktreePath, "-P", "-F", "#{pane_id}"];
  const split = await process.run("tmux", splitArgs);
  if (split.kind !== "ok") return failed(split.error, split.exitCode);
  const pane = split.value.stdout.trim();
  if (pane === "") return failed(`tmux split for session ${session} returned no pane`);
  const mainWidth = Math.floor(main.windowWidth / 2);
  const resized = await process.run("tmux", ["resize-pane", "-t", main.pane, "-x", String(mainWidth)]);
  if (resized.kind !== "ok") return failed(resized.error, resized.exitCode);
  return ok(pane);
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

// clearStrayInput mirrors the shell's megabrain_tmux_send_agent "command" branch (last standing
// at lib/module-tmux-runtime.sh, commit 9d24366^): a raw C-u immediately before the text, sent
// only when typing the initial launch command line into a freshly created/split pane, which can
// still hold startup noise or a stray keystroke from the shell that just started there. The
// shell's own reasoning for never doing this anywhere else: "C-u in an agent composer is not a
// line kill" — every other caller here types into an already-running agent's composer (the
// prompt payload, a reply, a nudge), where an unreviewed control key is a live risk (an Escape
// interrupts a working Codex turn) rather than a harmless line-kill. Callers must opt in
// explicitly per call site; there is no default that could silently reach the wrong one.
export async function sendTmuxPair(
  root: string,
  pane: string,
  text: string,
  key: string,
  environment: TmuxSendEnvironment,
  process: ProcessAdapter,
  clearStrayInput = false,
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
    if (clearStrayInput) {
      const cleared = await getTmux().sendKey(pane, "C-u", process);
      if (cleared.kind !== "ok") return cleared;
    }
    const sentText = await getTmux().sendText(pane, text, process);
    if (sentText.kind !== "ok") return sentText;
    return await getTmux().sendKey(pane, key, process);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
