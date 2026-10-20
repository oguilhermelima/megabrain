import { existsSync, readFileSync } from "node:fs";import { basename, join, resolve } from "node:path";import { ok } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { resolveStateDirectory } from "../../../core/state.js";import { pruneDecision, pruneStates } from "../../../core/orchestrate-prune.js";import { getTmux } from "../../../hosts/tmux.js";import { tmuxCallerPaneSession } from "../queue-write.js";import { resolvePackageRoot } from "../../../core/package-root.js";import { discoverAgentDirectories } from "../../../core/agent-directories.js";import { getInstallState, listDispatches, readOnlyStateDatabase } from "../../../adapters/state-db.js";
import type { HookAgent } from "./hook-config.js";
export type Environment = Readonly<Record<string, string | undefined>>;
export type Report = { module: string; status: string; reason: string; uncertainDispatches: number; uncertainReasons: unknown[]; leakedDispatchSessions: number; prunableDispatches: number; usableRuntimes?: number };
export type State = Record<string, Record<string, unknown>>;
export const modules = ["orchestration", "orchestration-hooks", "resource-hooks", "summaries-context", "worktree", "simulator-web", "simulator-native", "simulator-tv", "simulator-maestro", "tv-adb", "tmux-runtime", "skill-sync", "terminal-openers", "artifacts-diagram"];
export async function available(process: ProcessAdapter, command: string): Promise<boolean> {
  return (await process.run("which", [command])).kind === "ok";
}

export async function succeeds(process: ProcessAdapter, command: string, args: readonly string[]): Promise<boolean> {
  return (await process.run(command, args)).kind === "ok";
}

export function readState(environment: Environment): State {
  const opened = readOnlyStateDatabase(environment);
  if (opened.kind !== "ok") return {};
  const loaded = getInstallState(opened.value);
  return loaded.kind === "ok" ? loaded.value as State : {};
}

export function fileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Keep recognizing old hook scripts so install can migrate them, alongside direct entrypoint
// commands used by existing checkouts and Node-plus-bundle commands written by current installs.
export const legacyHookCommandPattern = /(^|\/)megabrain-turn-end\.sh($|\s)/;
export const hookEntrypointCommandPattern = /(^|\/)megabrain(?:\.mjs)?['"]?\s+hook turn-end($|\s)/;

export function hookCommandKind(command: string): "new" | "legacy" | "none" {
  if (hookEntrypointCommandPattern.test(command)) return "new";
  if (legacyHookCommandPattern.test(command)) return "legacy";
  return "none";
}

export function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let active = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const finish = (): void => {
    if (active) words.push(word);
    word = "";
    active = false;
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      active = true;
      escaped = false;
    } else if (quote === "'") {
      if (character === "'") quote = undefined;
      else word += character;
    } else if (quote === '"') {
      if (character === '"') quote = undefined;
      else if (character === "\\") escaped = true;
      else word += character;
    } else if (character === "\\") {
      escaped = true;
      active = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      active = true;
    } else if (/\s/.test(character)) {
      finish();
    } else {
      word += character;
      active = true;
    }
  }
  if (escaped || quote !== undefined) return undefined;
  finish();
  return words;
}

export function hookPathIssue(agent: string, command: string): string | undefined {
  const words = shellWords(command);
  if (words === undefined) return undefined;
  const args = words.filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (args.at(-2) !== "hook" || (args.at(-1) !== "turn-end" && args.at(-1) !== "pre-tool" && args.at(-1) !== "session-start")) return undefined;
  if (args.length >= 4 && /^node(?:\.exe)?$/i.test(basename(args[0] ?? ""))) {
    const interpreter = args[0] ?? "";
    const entrypoint = args[1] ?? "";
    if (!existsSync(interpreter)) return `${agent}: interpreter missing (${interpreter}); run megabrain install`;
    if (!existsSync(entrypoint)) return `${agent}: entrypoint missing (${entrypoint}); run megabrain install`;
  } else {
    const entrypoint = args[0] ?? "";
    if (basename(entrypoint) === "megabrain" && !existsSync(entrypoint)) {
      return `${agent}: entrypoint missing (${entrypoint}); run megabrain install`;
    }
  }
  return undefined;
}

export function hookConfigCommands(agent: string, path: string): string[] {
  try {
    const value = JSON.parse(fileText(path) ?? "") as Record<string, unknown>;
    const hooks = value.hooks as Record<string, unknown> | undefined;
    const commands: string[] = [];
    const collect = (entry: unknown): void => {
      if (typeof entry === "object" && entry !== null) commands.push(String((entry as Record<string, unknown>).command ?? ""));
    };
    if (agent === "cursor") {
      const entries = hooks?.afterAgentResponse;
      if (Array.isArray(entries)) entries.forEach(collect);
    } else {
      const groups = hooks?.Stop;
      if (Array.isArray(groups)) for (const group of groups) {
        if (typeof group !== "object" || group === null) continue;
        const entries = (group as Record<string, unknown>).hooks;
        if (Array.isArray(entries)) entries.forEach(collect);
      }
    }
    return commands;
  } catch {
    return [];
  }
}

// "present": a current, direct-entrypoint command is installed. "legacy": only the deleted wrapper
// script's path is present, and the doctor must say so is actionable (run install to migrate).
// "missing": neither form is present.
export function hookEntryStatus(agent: string, path: string): "present" | "legacy" | "missing" {
  const kinds = hookConfigCommands(agent, path).map(hookCommandKind);
  if (kinds.includes("new")) return "present";
  if (kinds.includes("legacy")) return "legacy";
  return "missing";
}

// Grok reads every *.json under <grok home>/hooks, so megabrain owns a file of its own there and
// never edits config.toml. GROK_HOME relocates the whole directory.
export function grokHooksFile(environment: Environment): string {
  return join(environment.GROK_HOME ?? join(environment.HOME ?? "", ".grok"), "hooks", "megabrain.json");
}

export function hookConfig(environment: Environment, agent: HookAgent): string {
  if (agent === "grok") return grokHooksFile(environment);
  const config = agent === "cursor"
    ? join(environment.HOME ?? "", ".cursor")
    : discoverAgentDirectories(environment)[agent]?.config ?? "";
  return join(config, agent === "claude" ? "settings.json" : "hooks.json");
}

// agy used to be written to this incorrect location. It is read only for migration and revert.
export function legacyAgyHookConfig(environment: Environment): string {
  return join(environment.HOME ?? "", ".agy", "hooks.json");
}

export function configuredWorktreeRoot(environment: Environment, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("~/")) return `${environment.HOME ?? ""}/${trimmed.slice(2)}`;
  if (trimmed.startsWith("/")) return trimmed;
  return resolve(trimmed);
}

export async function worktreeRoot(environment: Environment, process: ProcessAdapter): Promise<string | undefined> {
  const superset = await available(process, "superset") || existsSync(`${environment.HOME ?? ""}/.superset/bin/superset`);
  if (!superset || !await available(process, "orca")) return undefined;
  const current = await process.run("orca", ["worktree", "current", "--json"]);
  const currentValue = current.kind === "ok" ? (() => {
    try { return JSON.parse(current.value.stdout) as Record<string, unknown>; } catch { return undefined; }
  })() : undefined;
  const worktree = currentValue?.result as Record<string, unknown> | undefined;
  const currentPath = (worktree?.worktree as Record<string, unknown> | undefined)?.path;
  if (currentValue?.ok !== true || typeof currentPath !== "string") return undefined;
  const settings = await process.run("superset", ["settings", "get", "worktreeBaseDir"]);
  if (settings.kind === "ok") {
    try {
      const parsed = JSON.parse(settings.value.stdout) as Record<string, unknown>;
      const value = parsed.value ?? (parsed.result as Record<string, unknown> | undefined)?.value;
      if (typeof value === "string" && value.trim() !== "" && value !== "null") return configuredWorktreeRoot(environment, value);
    } catch {
      const value = settings.value.stdout.trim();
      if (value !== "" && value !== "null") return configuredWorktreeRoot(environment, value);
    }
  }
  const stateRoot = fileText(resolve(resolveStateDirectory(environment), "worktree-root"))?.trim();
  return stateRoot ? configuredWorktreeRoot(environment, stateRoot) : undefined;
}

export function tmuxFileState(environment: Environment): { tuningBlock: boolean; tuningFile: boolean; wrapperBlock: boolean; wrapperFile: boolean; wrapperConfig: string } {
  const home = environment.HOME ?? "";
  const shell = environment.SHELL ?? "";
  const bash = shell.endsWith("/bash") || (!shell && (environment as Record<string, string | undefined>).PLATFORM !== "Darwin");
  const wrapperConfig = `${home}/${bash ? ".bashrc" : ".zshrc"}`;
  const wrapperSource = bash ? "source ~/.megabrain/bash/megabrain-agent-tmux.bash" : "source ~/.megabrain/zsh/megabrain-agent-tmux.zsh";
  const tuning = fileText(`${home}/.tmux.conf`) ?? "";
  const wrapper = fileText(wrapperConfig) ?? "";
  const repo = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
  const tuningInstalled = fileText(`${home}/.megabrain/tmux/megabrain.tmux.conf`);
  const wrapperInstalled = fileText(`${home}/.megabrain/${bash ? "bash/megabrain-agent-tmux.bash" : "zsh/megabrain-agent-tmux.zsh"}`);
  const block = (text: string, start: string, end: string, source: string) =>
    text.split("\n").filter((line) => line === start).length === 1 &&
    text.split("\n").filter((line) => line === end).length === 1 &&
    text.split("\n").filter((line) => line === source).length === 1;
  return {
    tuningBlock: block(tuning, "# >>> megabrain tmux tuning >>>", "# <<< megabrain tmux tuning <<<", "source-file ~/.megabrain/tmux/megabrain.tmux.conf"),
    tuningFile: tuningInstalled !== undefined && fileText(`${repo}/tmux/megabrain.tmux.conf`) === tuningInstalled,
    wrapperBlock: block(wrapper, "# >>> megabrain tmux wrapper >>>", "# <<< megabrain tmux wrapper <<<", wrapperSource),
    wrapperFile: wrapperInstalled !== undefined && fileText(`${repo}/${bash ? "bash/megabrain-agent-tmux.bash" : "zsh/megabrain-agent-tmux.zsh"}`) === wrapperInstalled,
    wrapperConfig,
  };
}

export function emptyCounts(): Omit<Report, "module" | "status" | "reason"> {
  return { uncertainDispatches: 0, uncertainReasons: [], leakedDispatchSessions: 0, prunableDispatches: 0 };
}

export type DispatchHealth = Omit<Report, "module" | "status" | "reason">;

// Mirrors the default prune window used by megabrain orchestrate prune.
export const PRUNE_DEFAULT_DAYS = 7;

export async function dispatchHealth(environment: Environment, process: ProcessAdapter): Promise<DispatchHealth> {
  const result: DispatchHealth = emptyCounts();
  const opened = readOnlyStateDatabase(environment);
  if (opened.kind !== "ok") return result;
  const listed = listDispatches(opened.value);
  if (listed.kind !== "ok") return result;
  const records = listed.value;
  const pruneStateSet = new Set<string>(pruneStates);
  const pruneOptions = { olderThan: PRUNE_DEFAULT_DAYS, states: [...pruneStates], mode: "archive" as const, dryRun: false, json: false };
  const now = new Date();
  for (const record of records) {
    const processState = typeof record.processState === "string" ? record.processState : "";
    const reason = processState === "start-unproven" ? "process start was not proven"
      : processState === "stop-unproven" ? "process stop was not proven"
        : processState === "exited" ? "agent exited without reporting"
          : processState === "abandoned" ? "process was abandoned without proof" : undefined;
    if (reason !== undefined) {
      result.uncertainDispatches += 1;
      result.uncertainReasons.push({ dispatchId: record.dispatchId, reason, processState, terminalState: record.terminalState ?? null });
    }
    if (pruneDecision(record, pruneOptions, now).eligible) result.prunableDispatches += 1;
  }
  const sessions = await getTmux().listSessions(process, "#{session_name}");
  const liveSessions = new Set(sessions.kind === "ok" ? sessions.value : []);
  const callerSessionName = await callerSession(environment, process);
  const leaked = new Set<string>();
  for (const record of records) {
    if (!pruneStateSet.has(typeof record.state === "string" ? record.state : "")) continue;
    if (record.runtime !== "tmux") continue;
    const session = typeof record.tmuxSession === "string" ? record.tmuxSession : "";
    const parent = typeof record.parentTmuxSession === "string" ? record.parentTmuxSession : "";
    if (session && session !== parent && (!callerSessionName || session !== callerSessionName) && liveSessions.has(session)) leaked.add(session);
  }
  result.leakedDispatchSessions = leaked.size;
  return result;
}

// The tmux session this caller is itself physically running in — used only to exclude it from
// the leaked-dispatch-session count. Physical, not identity: goes through queue-write.js
// tmuxCallerPaneSession (the raw probe), which an override never suppresses — see the identical
// note on orchestrate-prune.js tmuxCallerSession.
export async function callerSession(environment: Environment, process: ProcessAdapter): Promise<string> {
  return (await tmuxCallerPaneSession(environment, process)) ?? "";
}

export async function appiumReady(process: ProcessAdapter): Promise<boolean> {
  return await available(process, "appium") && await succeeds(process, "appium", ["driver", "list", "--installed"]);
}

export async function serveSimReady(process: ProcessAdapter): Promise<boolean> {
  const version = await process.run("serve-sim", ["--version"]);
  if (version.kind !== "ok" || version.value.stdout.trim() !== "0.1.48") return false;
  const root = await process.run("npm", ["root", "-g"]);
  if (root.kind !== "ok") return false;
  const addon = join(root.value.stdout.trim(), "serve-sim", "dist", "native", "serve-sim-native.node");
  return (await process.run("node", ["-e", "require(process.argv[1])", addon])).kind === "ok";
}

export async function tmuxServerState(process: ProcessAdapter): Promise<{ running: boolean; rgb: boolean; configApplied: boolean }> {
  const sessions = await getTmux().listSessions(process, "#{session_name}");
  if (sessions.kind !== "ok") return { running: false, rgb: false, configApplied: false };
  const features = await getTmux().globalOption("terminal-features", process);
  const rgb = features.kind === "ok" && /(^|:)RGB(?:$|\s|:)/m.test(features.value);
  let configApplied = false;
  for (const session of sessions.value.filter((value) => value.startsWith("megabrain-"))) {
    const mouse = await getTmux().sessionOption(session, "mouse", process);
    const status = await getTmux().sessionOption(session, "status", process);
    const escape = await getTmux().sessionOption(session, "escape-time", process);
    const border = await getTmux().sessionOption(session, "pane-active-border-style", process);
    if (mouse.kind === "ok" && mouse.value.trim() === "on" && status.kind === "ok" && status.value.trim() === "off" && escape.kind === "ok" && escape.value.trim() === "0" && border.kind === "ok" && border.value.trim() !== "") configApplied = true;
  }
  return { running: true, rgb, configApplied };
}

