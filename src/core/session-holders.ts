import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import { readAppPanes, readProcessTable, type ProcessTable } from "./session-origin.js";

// An agent session must have one live process at a time: two TUIs, or a TUI and the chat's own agent, on
// one session write the same log and answer different turns. These are the processes holding a session now.

export type SessionHolder = Readonly<{ pid: number; tmuxSession: string | null; cwd: string | null }>;

const AGENTS = new Set(["claude", "codex"]);
const RUNTIMES = new Set(["node", "bun"]);

/** The session an agent's command line resumes: `claude --resume <id>`, `codex resume <id>`, run directly or by node. */
export function resumedSessionOf(command: string): Readonly<{ agent: string; id: string }> | null {
  const words = command.split(/\s+/).filter((word) => word !== "");
  const program = RUNTIMES.has(basename(words[0] ?? "")) ? 1 : 0;
  const agent = basename(words[program] ?? "");
  if (!AGENTS.has(agent)) return null;
  const at = words.findIndex((word, index) => index > program && (word === "--resume" || (agent === "codex" && word === "resume")));
  const id = at === -1 ? undefined : words[at + 1];
  return id === undefined || id.startsWith("-") ? null : { agent, id };
}

/** Claude registers every interactive process under ~/.claude/sessions/<pid>.json with the session it is on. */
async function claudeRegistered(home: string, sessionId: string, table: ProcessTable): Promise<number[]> {
  const directory = join(home, ".claude", "sessions");
  let names: string[];
  try { names = await readdir(directory); } catch { return []; }
  const pids: number[] = [];
  for (const name of names.filter((entry) => /^\d+\.json$/.test(entry))) {
    try {
      const entry = JSON.parse(await readFile(join(directory, name), "utf8")) as Record<string, unknown>;
      const pid = Number(name.slice(0, -".json".length));
      if (entry.pid === pid && entry.sessionId === sessionId && table.has(pid)) pids.push(pid);
    } catch { /* unreadable entry: the next one */ }
  }
  return pids;
}

/** The working directory of each process, where the system tells it: /proc on Linux, lsof elsewhere. */
async function processCwds(pids: readonly number[], processes: ProcessAdapter): Promise<ReadonlyMap<number, string>> {
  const cwds = new Map<number, string>();
  if (process.platform === "linux") {
    for (const pid of pids) try { cwds.set(pid, await readlink(`/proc/${pid}/cwd`)); } catch { /* gone or not ours to read */ }
    return cwds;
  }
  const listed = await processes.run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"]);
  if (listed.kind !== "ok") return cwds;
  let pid = 0;
  for (const line of listed.value.stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/** The app tmux session a process runs in: the one whose pane process is it or one of its ancestors. */
function tmuxSessionOf(table: ProcessTable, panes: ReadonlyMap<number, string>, pid: number): string | null {
  const seen = new Set<number>();
  for (let current: number | undefined = pid; current !== undefined && current > 1 && !seen.has(current); current = table.get(current)?.ppid) {
    const session = panes.get(current);
    if (session !== undefined) return session;
    seen.add(current);
  }
  return null;
}

/**
 * Every live process on the session, with the app tmux session it runs in, if any. `exclude` names processes the
 * caller owns; `panes` adds pane processes the caller already knows (pane pid to session) to the server's own listing.
 * Given `cwd`, a Claude running in another directory does not count: Claude keeps a session's log under its
 * project directory, so one resumed elsewhere never writes this session's log. A cwd that cannot be read counts.
 */
export async function liveSessionHolders(agent: string, sessionId: string, options: Readonly<{ home: string; processes: ProcessAdapter; exclude?: ReadonlySet<number>; panes?: ReadonlyMap<number, string>; cwd?: string }>): Promise<SessionHolder[]> {
  const table = await readProcessTable(options.processes);
  const pids = new Set<number>();
  for (const [pid, entry] of table) {
    const resumed = resumedSessionOf(entry.command);
    if (resumed?.agent === agent && resumed.id === sessionId) pids.add(pid);
  }
  if (agent === "claude") for (const pid of await claudeRegistered(options.home, sessionId, table)) pids.add(pid);
  for (const pid of options.exclude ?? []) pids.delete(pid);
  // A process whose parent also holds the session is that holder's own child (a wrapper's agent), not a second one.
  for (const pid of [...pids]) if (pids.has(table.get(pid)?.ppid ?? -1)) pids.delete(pid);
  const cwds = pids.size === 0 ? new Map<number, string>() : await processCwds([...pids], options.processes);
  if (agent === "claude" && options.cwd !== undefined) {
    const wanted = await realpath(options.cwd).catch(() => options.cwd);
    for (const [pid, cwd] of cwds) if (cwd !== wanted && cwd !== options.cwd) pids.delete(pid);
  }
  if (pids.size === 0) return [];
  const panes = new Map([...await readAppPanes(options.processes), ...options.panes ?? []]);
  return [...pids].sort((left, right) => left - right).map((pid) => ({ pid, tmuxSession: tmuxSessionOf(table, panes, pid), cwd: cwds.get(pid) ?? null }));
}
