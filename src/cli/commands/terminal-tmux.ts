import { randomUUID } from "node:crypto";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { getTmux } from "../../hosts/tmux.js";

// Terminals for an operator with no IDE host: a tmux window in the caller's own session, or a
// detached session of its own when the caller is not in tmux. The terminal id is
// "<session>:<pane>", the same shape a tmux caller's identity already has.

export type TmuxTerminal = Readonly<{ terminalId: string; session: string; pane: string; pid: number; attach: string }>;

const paneFormat = "#{pane_id} #{pane_pid}";

function parsePane(stdout: string): Readonly<{ pane: string; pid: number }> | undefined {
  const [pane, pid] = stdout.trim().split(/\s+/);
  const parsed = Number(pid);
  return pane !== undefined && /^%\d+$/.test(pane) && Number.isInteger(parsed) && parsed > 0 ? { pane, pid: parsed } : undefined;
}

export function splitTmuxTerminalId(terminalId: string): Readonly<{ session: string; pane: string }> | undefined {
  const separator = terminalId.lastIndexOf(":");
  return separator > 0 ? { session: terminalId.slice(0, separator), pane: terminalId.slice(separator + 1) } : undefined;
}

// `session` pins the target (a restart reuses the old terminal's session); without it the caller's
// own tmux session is used, or a fresh detached one.
export async function createTmuxTerminal(
  process: ProcessAdapter,
  environment: Readonly<Record<string, string | undefined>>,
  worktreePath: string,
  command: string,
  session?: string,
): Promise<Result<TmuxTerminal>> {
  let target = session;
  if (target === undefined && environment.TMUX !== undefined && environment.TMUX !== "" && environment.TMUX_PANE !== undefined && environment.TMUX_PANE !== "") {
    const current = await getTmux().sessionForPane(environment.TMUX_PANE, process);
    if (current.kind === "ok") target = current.value;
  }
  const reuse = target !== undefined && (await getTmux().sessionExists(target, process)).kind === "ok";
  const name = target ?? `mb-term-${randomUUID().slice(0, 8)}`;
  const args = reuse
    ? ["new-window", "-d", "-t", `${name}:`, "-c", worktreePath, "-P", "-F", paneFormat, command]
    : ["new-session", "-d", "-s", name, "-c", worktreePath, "-P", "-F", paneFormat, command];
  const result = await process.run("tmux", args);
  if (result.kind !== "ok") return failed(`could not open a tmux terminal: ${result.error}`, result.exitCode);
  const pane = parsePane(result.value.stdout);
  if (pane === undefined) return failed("could not open a tmux terminal: tmux returned no pane");
  return ok({ terminalId: `${name}:${pane.pane}`, session: name, pane: pane.pane, pid: pane.pid, attach: `tmux attach -t ${name}` });
}

// Pane id -> root pid, for every pane tmux still has, keyed by terminal id. Undefined when tmux
// cannot be asked, which callers must report as "unknown", not "gone".
export async function tmuxPanePids(process: ProcessAdapter): Promise<ReadonlyMap<string, number> | undefined> {
  const result = await process.run("tmux", ["list-panes", "-a", "-F", "#{session_name}:#{pane_id} #{pane_pid}"]);
  if (result.kind !== "ok") return undefined;
  const panes = new Map<string, number>();
  for (const line of result.value.stdout.split("\n")) {
    const [id, pid] = line.trim().split(/\s+/);
    if (id !== undefined && id !== "" && Number.isInteger(Number(pid))) panes.set(id, Number(pid));
  }
  return panes;
}

// Returns whether a pane was killed; false means tmux no longer had it.
export async function closeTmuxTerminal(process: ProcessAdapter, terminalId: string): Promise<Result<boolean>> {
  const target = splitTmuxTerminalId(terminalId);
  if (target === undefined) return failed(`not a tmux terminal id: ${terminalId}`);
  const panes = await tmuxPanePids(process);
  if (panes === undefined) return failed(`could not ask tmux about terminal ${terminalId}; record retained`);
  if (!panes.has(terminalId)) return ok(false);
  // The pane was just matched by its exact session:pane id above, so no second verification.
  const killed = await process.run("tmux", ["kill-pane", "-t", target.pane]);
  return killed.kind === "ok" ? ok(true) : failed(`could not close tmux terminal ${terminalId}; record retained`);
}
