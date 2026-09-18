import { failed, ok, type Result } from "./result.js";

export type TmuxVerb = "tune" | "wrapper";
export type TmuxOptions = Readonly<{
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly revert: boolean;
  readonly json: boolean;
}>;

export const TMUX_TUNE_START = "# >>> megabrain tmux tuning >>>";
export const TMUX_TUNE_END = "# <<< megabrain tmux tuning <<<";
export const TMUX_TUNE_SOURCE = "source-file ~/.megabrain/tmux/megabrain.tmux.conf";
export const TMUX_WRAPPER_START = "# >>> megabrain tmux wrapper >>>";
export const TMUX_WRAPPER_END = "# <<< megabrain tmux wrapper <<<";

export function parseTmuxOptions(verb: TmuxVerb, args: readonly string[]): Result<TmuxOptions> {
  let yes = false;
  let dryRun = false;
  let revert = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--revert") revert = true;
    else if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok({ yes, dryRun, revert, json });
    else return failed(`unknown tmux ${verb} option: ${arg}`, 2);
  }
  if (dryRun && revert) return failed("--dry-run and --revert cannot be combined", 2);
  return ok({ yes, dryRun, revert, json });
}

export function tmuxUsage(verb?: TmuxVerb): string {
  if (verb === "tune") return "Usage: megabrain tmux tune [--yes] [--dry-run] [--revert] [--json]\n";
  if (verb === "wrapper") return "Usage: megabrain tmux wrapper [--yes] [--dry-run] [--revert] [--json]\n";
  return "Usage: megabrain tmux tune [--yes] [--dry-run] [--revert] [--json]\n       megabrain tmux wrapper [--yes] [--dry-run] [--revert] [--json]\n";
}

export function countExactLines(content: string, line: string): number {
  const lines = content.split("\n");
  return lines.filter((candidate) => candidate === line).length;
}

export function blockPresent(content: string, start: string, end: string, source: string): boolean {
  return countExactLines(content, start) === 1 && countExactLines(content, end) === 1 && countExactLines(content, source) === 1;
}

export function validateManagedConfig(content: string, start: string, end: string): boolean {
  return countExactLines(content, start) === countExactLines(content, end);
}

function contentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function withTrailingNewline(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

export function rewriteManagedBlock(content: string, start: string, end: string, source: string): string {
  const output: string[] = [];
  let inBlock = false;
  let replaced = false;
  for (const line of contentLines(content)) {
    if (line === start) {
      if (!replaced) {
        output.push(start, source, end);
        replaced = true;
      }
      inBlock = true;
      continue;
    }
    if (inBlock && line === end) {
      inBlock = false;
      continue;
    }
    if (!inBlock) output.push(line);
  }
  if (!replaced) output.push(start, source, end);
  return withTrailingNewline(output);
}

export function removeManagedBlock(content: string, start: string, end: string): string {
  const output: string[] = [];
  let inBlock = false;
  for (const line of contentLines(content)) {
    if (line === start) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === end) {
      inBlock = false;
      continue;
    }
    if (!inBlock) output.push(line);
  }
  return withTrailingNewline(output);
}

export function nextBackupPath(config: string, configExists: boolean, stamp: string, existingPaths: ReadonlySet<string>): string | undefined {
  if (!configExists) return undefined;
  const base = `${config}.megabrain-backup-${stamp}`;
  if (!existingPaths.has(base)) return base;
  let suffix = 1;
  let candidate = `${base}-${suffix}`;
  while (existingPaths.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

export function shellFor(environment: Readonly<Record<string, string | undefined>>): "zsh" | "bash" | string {
  const shell = environment.SHELL ?? "";
  if (shell.endsWith("zsh")) return "zsh";
  if (shell.endsWith("bash")) return "bash";
  return shell.length > 0 ? shell : "unknown";
}

export function wrapperSource(shell: "zsh" | "bash" | string): string | undefined {
  if (shell === "zsh") return "source ~/.megabrain/zsh/megabrain-agent-tmux.zsh";
  if (shell === "bash") return "source ~/.megabrain/bash/megabrain-agent-tmux.bash";
  return undefined;
}

export function tunePlan(config: string, installPath: string, backupPath: string | undefined): string {
  return `Recommended tmux tuning:\n  - enable RGB and host-terminal parity options\n  - raise history, enable focus, passthrough, clipboard, mouse, and titles\n  - make splits and new windows inherit the current pane path\n  - install the shared tuning file at ${installPath}\n${backupPath === undefined ? `  - no backup: ${config} does not exist` : `  - back up ${config} to ${backupPath}`}\n`;
}

export function wrapperPlan(config: string, installPath: string, backupPath: string | undefined): string {
  return `Recommended tmux agent wrapper:\n  - install the wrapper file at ${installPath}\n  - add a source block to ${config}\nWarning: this defines shell functions named claude, codex and agy that take over those commands in every new interactive zsh. MEGABRAIN_NO_TMUX=1 or "command claude" bypasses them.\n${backupPath === undefined ? `  - no backup: ${config} does not exist` : `  - back up ${config} to ${backupPath}`}\n`;
}
