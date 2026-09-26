import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { failed, ok, type Result } from "../../core/result.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";
import { pruneDecision, pruneStates } from "../../core/orchestrate-prune.js";
import { installSkillSync, skillSyncDoctor } from "../../core/skill.js";
import { nextBackupPath } from "../../core/tmux.js";
import { executeTmux } from "./tmux.js";
import { getTmux } from "../../hosts/tmux.js";
import { tmuxCallerPaneSession } from "./queue-write.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { usageText } from "../../core/usage.js";
import { runMachineInstall } from "./install-machine.js";

export type Environment = Readonly<Record<string, string | undefined>>;
type Report = { module: string; status: string; reason: string; uncertainDispatches: number; uncertainReasons: unknown[]; retainedTerminals: number; retainedReasons: unknown[]; leakedDispatchSessions: number; prunableDispatches: number };
type State = Record<string, Record<string, unknown>>;
const modules = ["orchestration", "orchestration-hooks", "worktree", "simulator-web", "simulator-native", "simulator-tv", "tv-adb", "tmux-runtime", "skill-sync"];
async function available(process: ProcessAdapter, command: string): Promise<boolean> {
  return (await process.run("which", [command])).kind === "ok";
}

async function succeeds(process: ProcessAdapter, command: string, args: readonly string[]): Promise<boolean> {
  return (await process.run(command, args)).kind === "ok";
}

function statePath(environment: Environment): string {
  return resolve(resolveStateDirectory(environment), "state.json");
}

function readState(environment: Environment): State {
  try {
    return JSON.parse(readFileSync(statePath(environment), "utf8")) as State;
  } catch {
    return {};
  }
}

function fileText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// Keep recognizing old hook scripts so install can migrate them, alongside direct entrypoint
// commands used by existing checkouts and Node-plus-bundle commands written by current installs.
const legacyHookCommandPattern = /(^|\/)megabrain-turn-end\.sh($|\s)/;
const hookEntrypointCommandPattern = /(^|\/)megabrain(?:\.mjs)?['"]?\s+hook turn-end($|\s)/;

function hookCommandKind(command: string): "new" | "legacy" | "none" {
  if (hookEntrypointCommandPattern.test(command)) return "new";
  if (legacyHookCommandPattern.test(command)) return "legacy";
  return "none";
}

function shellWords(command: string): string[] | undefined {
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

function hookPathIssue(agent: string, command: string): string | undefined {
  const words = shellWords(command);
  if (words === undefined) return undefined;
  const args = words.filter((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  if (args.at(-2) !== "hook" || args.at(-1) !== "turn-end") return undefined;
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

function hookConfigCommands(agent: string, path: string): string[] {
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
function hookEntryStatus(agent: string, path: string): "present" | "legacy" | "missing" {
  const kinds = hookConfigCommands(agent, path).map(hookCommandKind);
  if (kinds.includes("new")) return "present";
  if (kinds.includes("legacy")) return "legacy";
  return "missing";
}

function hookConfig(environment: Environment, agent: string): string {
  const home = environment.HOME ?? "";
  return agent === "claude" ? `${home}/.claude/settings.json`
    : agent === "codex" ? `${home}/.codex/hooks.json`
      : agent === "agy" ? `${home}/.agy/hooks.json` : `${home}/.cursor/hooks.json`;
}

function configuredWorktreeRoot(environment: Environment, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("~/")) return `${environment.HOME ?? ""}/${trimmed.slice(2)}`;
  if (trimmed.startsWith("/")) return trimmed;
  return resolve(trimmed);
}

async function worktreeRoot(environment: Environment, process: ProcessAdapter): Promise<string | undefined> {
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

function tmuxFileState(environment: Environment): { tuningBlock: boolean; tuningFile: boolean; wrapperBlock: boolean; wrapperFile: boolean; wrapperConfig: string } {
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

function emptyCounts(): Omit<Report, "module" | "status" | "reason"> {
  return { uncertainDispatches: 0, uncertainReasons: [], retainedTerminals: 0, retainedReasons: [], leakedDispatchSessions: 0, prunableDispatches: 0 };
}

type DispatchHealth = Omit<Report, "module" | "status" | "reason"> & { unrecognisedMessageFiles: string[]; untrackedDispatches: string[] };

// Mirrors the shell's default prune window (MEGABRAIN_DISPATCH_PRUNE_DEFAULT_DAYS), also the
// default parsePruneArgs uses for `megabrain orchestrate prune`: a terminal dispatch only counts
// as prunable once it has been settled for at least this many days.
const PRUNE_DEFAULT_DAYS = 7;

function messageFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !/^\d{4,}-[^-]+-.+\.json$/.test(entry.name))
      .map((entry) => resolve(directory, entry.name));
  } catch {
    return [];
  }
}

async function dispatchHealth(environment: Environment, process: ProcessAdapter): Promise<DispatchHealth> {
  const result: DispatchHealth = { ...emptyCounts(), unrecognisedMessageFiles: [], untrackedDispatches: [] };
  const directory = resolve(resolveStateDirectory(environment), "dispatches");
  if (!existsSync(directory)) return result;
  const pruneStateSet = new Set<string>(pruneStates);
  const pruneOptions = { olderThan: PRUNE_DEFAULT_DAYS, states: [...pruneStates], mode: "archive" as const, dryRun: false, json: false };
  const now = new Date();
  const records: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    result.unrecognisedMessageFiles.push(...messageFiles(resolve(directory, entry.name, "messages")));
    const metaPath = resolve(directory, entry.name, "meta.json");
    // Matches the shell scan's own `[ -f meta.json ]` check: a directory with no meta.json at all
    // is untracked, but one whose meta.json exists and merely fails to parse is not — it still
    // falls into the catch below, silently excluded from every count, exactly as the shell's jq
    // scan drops an unparsable record with no separate notice for it.
    if (!existsSync(metaPath)) {
      result.untrackedDispatches.push(entry.name);
      continue;
    }
    try {
      const record = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
      records.push(record);
      const processState = typeof record.processState === "string" ? record.processState : "";
      const reason = processState === "start-unproven" ? "process start was not proven"
        : processState === "stop-unproven" ? "process stop was not proven"
          : processState === "exited" ? "agent exited without reporting"
            : processState === "abandoned" ? "process was abandoned without proof" : undefined;
      const dispatchId = record.dispatchId ?? entry.name;
      if (reason !== undefined) {
        result.uncertainDispatches += 1;
        result.uncertainReasons.push({ dispatchId, reason, processState, terminalState: record.terminalState ?? null });
      }
      if (record.terminalState === "retained") {
        result.retainedTerminals += 1;
        result.retainedReasons.push({ dispatchId, reason: record.terminalReason ?? "terminal identity remains unproven", processState, terminalState: "retained" });
      }
      if (pruneDecision(record, pruneOptions, now).eligible) {
        result.prunableDispatches += 1;
      }
    } catch {
      // Match the shell scan: malformed metadata is not a health record.
    }
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

async function appiumReady(process: ProcessAdapter): Promise<boolean> {
  return await available(process, "appium") && await succeeds(process, "appium", ["driver", "list", "--installed"]);
}

async function tmuxServerState(process: ProcessAdapter): Promise<{ running: boolean; rgb: boolean; configApplied: boolean }> {
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

async function report(module: string, environment: Environment, process: ProcessAdapter): Promise<Report> {
  let status = "missing";
  let reason = "module is not installed";
  if (module === "simulator-native" || module === "simulator-tv") {
    const platform = await process.run("uname", ["-s"]);
    const darwin = platform.kind === "ok" && platform.value.stdout.trim() === "Darwin";
    if (!darwin) { status = "unsupported"; reason = "macOS only"; }
    else if (!await available(process, "appium")) reason = "appium is not on PATH";
    else if (!await appiumReady(process)) { status = "misconfigured"; reason = "appium-xcuitest-driver is not installed"; }
    else { status = "ok"; reason = "appium and xcuitest driver are installed"; }
    if (module === "simulator-tv" && status === "ok") reason = "Apple TV simulator uses the shared Appium xcuitest toolchain";
  } else if (module === "tv-adb") {
    if (await available(process, "adb") && await succeeds(process, "adb", ["version"])) { status = "ok"; reason = "adb is available"; }
    else reason = "adb is not on PATH";
  } else if (module === "simulator-web") {
    if (!await available(process, "npx")) reason = "npx is not on PATH";
    else if (!await available(process, "node") || !await available(process, "npm")) reason = "node and npm are required for pinned Playwright 1.62.1";
    else {
      const root = environment.MEGABRAIN_PLAYWRIGHT_ROOT ?? `${environment.HOME ?? ""}/.megabrain/playwright`;
      if (!existsSync(resolve(root, "manifest.json"))) reason = "browser profiles are not installed; run megabrain install simulator-web";
      else {
        const script = environment.MEGABRAIN_PLAYWRIGHT_SCRIPT ?? join(resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT), "scripts/playwright-web.mjs");
        const checked = await process.run("node", [script, "doctor", "--root", root]);
        if (checked.kind !== "ok") reason = "browser profile doctor could not read its manifest";
        else {
          try {
            const browserReport = JSON.parse(checked.value.stdout) as { status?: string; reason?: string };
            status = browserReport.status ?? "unknown";
            reason = browserReport.reason ?? "browser profile status is unknown";
          } catch {
            reason = "browser profile doctor could not read its manifest";
          }
        }
      }
    }
  } else if (module === "orchestration") {
    const tmux = await available(process, "tmux");
    const orca = await succeeds(process, "orca", ["status", "--json"]);
    const superset = await succeeds(process, "superset", ["workspaces", "list", "--json"]);
    const state = readState(environment);
    const health = await dispatchHealth(environment, process);
    const tmuxEnabled = state["tmux-runtime"]?.installed === true;
    const usable: string[] = [];
    const missing: string[] = [];
    if (orca) usable.push("orca"); else missing.push("orca");
    if (superset) usable.push("superset"); else missing.push("superset");
    if (tmux && tmuxEnabled) usable.push("tmux"); else if (!tmuxEnabled) missing.push("tmux");
    let suffix = `; uncertain dispatches: ${health.uncertainDispatches} (review with megabrain orchestrate list --uncertain; reconcile or archive eligible records with megabrain orchestrate prune --older-than 1); retained terminals: ${health.retainedTerminals}; leaked dispatch sessions: ${health.leakedDispatchSessions}; prunable dispatches: ${health.prunableDispatches}`;
    if (health.uncertainDispatches > 0) suffix += `; unresolved reasons: ${[...new Set(health.uncertainReasons.map(item => (item as { reason: string }).reason))].join(", ")}`;
    if (health.retainedTerminals > 0) suffix += `; retained reasons: ${[...new Set(health.retainedReasons.map(item => (item as { reason: string }).reason))].join(", ")}`;
    if (health.unrecognisedMessageFiles.length > 0) suffix += `; unrecognised message files: ${health.unrecognisedMessageFiles.join(", ")}`;
    // Mirrors the shell's megabrain_notice call for the same condition (a dispatch directory with
    // no meta.json at all). The shell put it on stderr; folded into reason instead, matching the
    // unrecognisedMessageFiles convention just above, so every reader of this module's report —
    // not only one polling stderr — sees it, and it survives even when the directory it describes
    // is gone by the time a later, separate doctor call would otherwise be needed to find it.
    if (health.untrackedDispatches.length > 0) suffix += `; dispatch directories without metadata: ${health.untrackedDispatches.join(", ")}`;
    if (health.uncertainDispatches > 0 || health.retainedTerminals > 0) {
      status = "misconfigured";
      reason = `dispatch state requires reconciliation${suffix}`;
    } else if (usable.length > 0) { status = "ok"; reason = `usable runtimes: ${usable.join(", ")}; other runtimes are optional${suffix}`; }
    else reason = `no orchestration runtime is available; missing runtimes: ${missing.join(", ")}${suffix}`;
    const { unrecognisedMessageFiles: _unrecognisedMessageFiles, untrackedDispatches: _untrackedDispatches, ...counts } = health;
    return { module, status, reason, ...counts };
  } else if (module === "worktree") {
    const superset = await available(process, "superset") || existsSync(`${environment.HOME ?? ""}/.superset/bin/superset`);
    if (!superset) reason = `superset CLI is not on PATH and ${environment.HOME ?? ""}/.superset/bin/superset is unavailable`;
    else if (!await available(process, "orca")) reason = "orca CLI is not on PATH";
    else {
      const root = await worktreeRoot(environment, process);
      if (root === undefined) { status = "misconfigured"; reason = "Superset worktreeBaseDir is unset or unreadable"; }
      else { status = "ok"; reason = root; }
    }
  } else if (module === "orchestration-hooks") {
    const names = ["claude", "codex", "agy", "cursor"];
    const details: string[] = [];
    let healthy = true;
    for (const name of names) {
      const agentAvailable = name === "cursor" ? await available(process, "cursor") || await available(process, "cursor-agent") : await available(process, name);
      if (!agentAvailable) {
        details.push(`${name}: not-installed`);
        continue;
      }
      const config = name === "claude" ? `${environment.HOME ?? ""}/.claude/settings.json` : name === "codex" ? `${environment.HOME ?? ""}/.codex/hooks.json` : name === "agy" ? `${environment.HOME ?? ""}/.agy/hooks.json` : `${environment.HOME ?? ""}/.cursor/hooks.json`;
      if (!existsSync(config)) { details.push(`${name}: entry-missing (config absent)`); healthy = false; }
      else {
        const entryStatus = hookEntryStatus(name, config);
        if (entryStatus === "present") {
          const issue = hookConfigCommands(name, config)
            .filter((command) => hookCommandKind(command) === "new")
            .map((command) => hookPathIssue(name, command))
            .find((value) => value !== undefined);
          if (issue === undefined) details.push(`${name}: entry-present`);
          else { details.push(issue); healthy = false; }
        }
        else if (entryStatus === "legacy") { details.push(`${name}: legacy entry; run megabrain install orchestration-hooks to migrate`); healthy = false; }
        else { details.push(`${name}: entry-missing`); healthy = false; }
      }
    }
    status = healthy ? "ok" : "misconfigured";
    reason = `${details.join("; ")}; Codex caveat: Codex shows a \"Hooks need review\" prompt on its next launch.`;
  } else if (module === "tmux-runtime") {
    if (!await available(process, "tmux")) reason = "tmux is not on PATH";
    else {
      const versionResult = await process.run("tmux", ["-V"]);
      const version = versionResult.kind === "ok" ? versionResult.value.stdout.trim() : "";
      const enabled = readState(environment)["tmux-runtime"]?.installed === true;
      const server = await tmuxServerState(process);
      const shellResult = await process.run("printenv", ["SHELL"]);
      const shell = environment.SHELL ?? (shellResult.kind === "ok" ? shellResult.value.stdout.trim() : "");
      const platformResult = await process.run("uname", ["-s"]);
      const platform = platformResult.kind === "ok" ? platformResult.value.stdout.trim() : "Darwin";
      const wrapperFile = shell.endsWith("/bash") || (!shell && platform !== "Darwin") ? ".bashrc" : ".zshrc";
      const files = tmuxFileState(environment);
      const config = `${version}; runtime ${enabled ? "enabled" : "disabled"}; tuning block ${files.tuningBlock}; tuning file current ${files.tuningFile}; wrapper block in ${wrapperFile} ${files.wrapperBlock}; wrapper file current ${files.wrapperFile}; ${server.running ? `running server RGB ${server.rgb}` : "running server none"}; session registry current; ${server.configApplied ? "megabrain session config applied" : "megabrain session config will apply when a session launches"}`;
      if (enabled && files.tuningBlock && files.tuningFile && files.wrapperBlock && files.wrapperFile) {
        status = "ok";
        reason = config;
      } else {
        status = "misconfigured";
        reason = `${config}; ${enabled ? "tmux runtime files are not current; run megabrain install tmux-runtime" : "install tmux-runtime to enable it"}`;
      }
    }
  } else if (module === "skill-sync") {
    ({ status, reason } = skillSyncDoctor(environment));
  }
  return { module, status, reason, ...emptyCounts() };
}

function output(value: Report, json: boolean): string {
  return json ? `${JSON.stringify(value, null, 2)}\n` : `${value.module}: ${value.status} (${value.reason})\n`;
}

export async function executeDoctor(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  let module: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") return ok(usageText("doctor"));
    else if (module !== undefined) return failed("doctor accepts at most one module id", 2);
    else module = arg;
  }
  if (module !== undefined && !modules.includes(module)) return failed(`unknown module: ${module}`, 2);
  const values: Report[] = [];
  for (const id of module === undefined ? modules : [module]) {
    values.push(await report(id, environment, process));
  }
  const unhealthy = values.some((value) => value.status !== "ok");
  const text = module === undefined && json ? `${JSON.stringify(values, null, 2)}\n` : values.map((value) => output(value, json)).join("");
  const hook = values.find((value) => value.module === "orchestration-hooks");
  const stderr = hook?.reason.includes("codex: entry-present")
    ? "\nCODEX ACTION REQUIRED: the megabrain hook needs one-time trust in Codex.\nOpen a plain terminal, run codex, and choose \"Trust all and continue\".\nOpening Codex through Superset will not complete this step because Superset passes --dangerously-bypass-hook-trust.\n"
    : undefined;
  return stderr === undefined
    ? { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0 }
    : { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0, stderr };
}

type InstallOptions = Readonly<{ yes: boolean; browser: string }>;

function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY);
}

function writeInstalledState(environment: Environment, module: string, installed: boolean, details: string): void {
  const path = statePath(environment);
  let state: Record<string, unknown> = {};
  try {
    state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    state = {};
  }
  const configuredAt = new Date().toISOString();
  state[module] = { installed, configuredAt, statusSource: "megabrain install", details };
  state._meta = { kind: "installation-record", recordedAt: configuredAt, source: "megabrain install", liveStatusCommand: "megabrain doctor" };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // A best-effort install record must never mask the real install/doctor result.
  }
}

async function dateStamp(processAdapter: ProcessAdapter): Promise<string> {
  const result = await processAdapter.run("date", ["-u", "+%Y%m%dT%H%M%SZ"]);
  if (result.kind === "ok") return result.value.stdout.trim();
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function backupExistingFile(path: string, processAdapter: ProcessAdapter): Promise<Result<string | undefined>> {
  if (!existsSync(path)) return ok(undefined);
  const directory = dirname(path);
  const prefix = `${basename(path)}.megabrain-backup-`;
  let existingBackups: Set<string>;
  try {
    existingBackups = new Set(readdirSync(directory).filter((name) => name.startsWith(prefix)).map((name) => resolve(directory, name)));
  } catch {
    existingBackups = new Set();
  }
  const stamp = await dateStamp(processAdapter);
  const backup = nextBackupPath(path, true, stamp, existingBackups);
  if (backup === undefined) return ok(undefined);
  try {
    await copyFile(path, backup);
  } catch {
    return failed(`could not back up ${path}`);
  }
  return ok(backup);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

// --- orchestration-hooks -----------------------------------------------------------------

const hookAgents = ["claude", "codex", "agy", "cursor"] as const;
type HookAgent = (typeof hookAgents)[number];

async function hookAgentAvailable(agent: HookAgent, processAdapter: ProcessAdapter): Promise<boolean> {
  return agent === "cursor"
    ? (await available(processAdapter, "cursor")) || (await available(processAdapter, "cursor-agent"))
    : available(processAdapter, agent);
}

type HookRuntime = Readonly<{ execPath: string; node: boolean }>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookEntrypointCommand(
  environment: Environment,
  agent: HookAgent,
  runtime: HookRuntime = { execPath: process.execPath, node: process.versions.bun === undefined },
): string | undefined {
  const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
  const entrypoint = resolve(root, ".build/megabrain");
  if (runtime.node) {
    try {
      if ((statSync(entrypoint).mode & 0o111) === 0) return undefined;
    } catch {
      return undefined;
    }
    return `MEGABRAIN_HOOK_AGENT=${agent} ${shellQuote(resolve(runtime.execPath))} ${shellQuote(entrypoint)} hook turn-end`;
  }
  try {
    if ((statSync(entrypoint).mode & 0o111) === 0) return undefined;
    return `MEGABRAIN_HOOK_AGENT=${agent} ${shellQuote(realpathSync(entrypoint))} hook turn-end`;
  } catch {
    return undefined;
  }
}

// Used by repair to find the entry to replace in place, whichever form it currently has: the
// deleted bash wrapper's path (an older install, or one from a different checkout) or an
// existing direct-binary command (possibly stale, e.g. pointing at a different checkout).
function hookEntryMatches(entry: unknown): boolean {
  return typeof entry === "object" && entry !== null &&
    hookCommandKind(String((entry as Record<string, unknown>).command ?? "")) !== "none";
}

function repairStopHooks(existing: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooksField = existing.hooks;
  if (hooksField !== undefined && (typeof hooksField !== "object" || hooksField === null || Array.isArray(hooksField))) throw new Error("hooks must be an object");
  const hooks = (hooksField as Record<string, unknown> | undefined) ?? {};
  const stopField = hooks.Stop;
  if (stopField !== undefined && !Array.isArray(stopField)) throw new Error("hooks.Stop must be an array");
  const stop = (stopField as unknown[] | undefined) ?? [];
  let seen = false;
  const entries: unknown[] = [];
  for (const group of stop) {
    const record = group !== null && typeof group === "object" ? (group as Record<string, unknown>) : {};
    const nested = Array.isArray(record.hooks) ? (record.hooks as unknown[]) : [];
    if (!nested.some(hookEntryMatches)) {
      entries.push(group);
      continue;
    }
    if (seen) continue;
    let nestedSeen = false;
    const nestedEntries: unknown[] = [];
    for (const entry of nested) {
      if (hookEntryMatches(entry)) {
        if (nestedSeen) continue;
        nestedEntries.push({ ...(entry as Record<string, unknown>), type: "command", command });
        nestedSeen = true;
      } else {
        nestedEntries.push(entry);
      }
    }
    entries.push({ ...record, hooks: nestedEntries });
    seen = true;
  }
  if (!seen) entries.push({ hooks: [{ type: "command", command }] });
  return { ...existing, hooks: { ...hooks, Stop: entries } };
}

function repairAfterAgentResponse(existing: Record<string, unknown>, command: string): Record<string, unknown> {
  const hooksField = existing.hooks;
  if (hooksField !== undefined && (typeof hooksField !== "object" || hooksField === null || Array.isArray(hooksField))) throw new Error("hooks must be an object");
  const hooks = (hooksField as Record<string, unknown> | undefined) ?? {};
  const listField = hooks.afterAgentResponse;
  if (listField !== undefined && !Array.isArray(listField)) throw new Error("hooks.afterAgentResponse must be an array");
  const list = (listField as unknown[] | undefined) ?? [];
  let seen = false;
  const entries: unknown[] = [];
  for (const entry of list) {
    if (hookEntryMatches(entry)) {
      if (seen) continue;
      entries.push({ ...(entry as Record<string, unknown>), command, timeout: 10 });
      seen = true;
    } else {
      entries.push(entry);
    }
  }
  if (!seen) entries.push({ command, timeout: 10 });
  return { ...existing, hooks: { ...hooks, afterAgentResponse: entries }, version: (existing.version as number | undefined) ?? 1 };
}

async function repairHooksConfig(agent: HookAgent, environment: Environment, processAdapter: ProcessAdapter): Promise<Result<void>> {
  const path = hookConfig(environment, agent);
  const command = hookEntrypointCommand(environment, agent);
  if (command === undefined) return failed(`hook entrypoint is not executable for ${agent}`);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    const raw = fileText(path);
    try {
      existing = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return failed(`${agent} config is not valid JSON: ${path}`);
    }
    const backup = await backupExistingFile(path, processAdapter);
    if (backup.kind !== "ok") return backup;
  }
  let updated: Record<string, unknown>;
  try {
    updated = agent === "cursor" ? repairAfterAgentResponse(existing, command) : repairStopHooks(existing, command);
  } catch {
    return failed(`could not update ${agent} hooks: ${path}`);
  }
  try {
    await writeJsonAtomic(path, updated);
  } catch {
    return failed(`could not update ${agent} hooks: ${path}`);
  }
  return ok(undefined);
}

async function installOrchestrationHooks(environment: Environment, processAdapter: ProcessAdapter): Promise<Result<void>> {
  for (const agent of hookAgents) {
    if (!(await hookAgentAvailable(agent, processAdapter))) continue;
    const result = await repairHooksConfig(agent, environment, processAdapter);
    if (result.kind !== "ok") return failed(`orchestration-hooks: ${result.error}`);
  }
  return ok(undefined);
}

async function revertOrchestrationHooks(environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  for (const agent of hookAgents) {
    if (!(await hookAgentAvailable(agent, processAdapter))) continue;
    const path = hookConfig(environment, agent);
    const directory = dirname(path);
    const prefix = `${basename(path)}.megabrain-backup-`;
    let latest: string | undefined;
    try {
      const names = readdirSync(directory).filter((name) => name.startsWith(prefix)).sort();
      latest = names.length > 0 ? resolve(directory, names[names.length - 1]) : undefined;
    } catch {
      latest = undefined;
    }
    if (latest === undefined) continue;
    try {
      await copyFile(latest, path);
    } catch {
      return failed(`could not restore ${agent} hooks from ${latest}`);
    }
  }
  return ok("orchestration-hooks reverted\n");
}

// --- simulator-native / simulator-tv -------------------------------------------------------

async function installSimulatorNative(processAdapter: ProcessAdapter): Promise<Result<void>> {
  if (!(await available(processAdapter, "appium"))) {
    const install = await processAdapter.run("npm", ["install", "-g", "appium"]);
    if (install.kind !== "ok") return failed("npm install -g appium failed");
  }
  if (!(await appiumReady(processAdapter))) {
    const driver = await processAdapter.run("appium", ["driver", "install", "xcuitest"]);
    if (driver.kind !== "ok") return failed("appium driver install xcuitest failed");
  }
  return ok(undefined);
}

// --- tv-adb ---------------------------------------------------------------------------------

async function installTvAdb(processAdapter: ProcessAdapter): Promise<Result<void>> {
  if (await available(processAdapter, "adb")) return ok(undefined);
  const message = (await available(processAdapter, "brew"))
    ? "adb is missing. Install Android platform-tools with: brew install android-platform-tools"
    : "adb is missing. Install Android platform-tools with your OS package manager (for example: apt-get install adb)";
  return failed(message);
}

// --- simulator-web ----------------------------------------------------------------------------

type PlaywrightAgent = "claude" | "codex" | "agy";
const playwrightAgents: readonly PlaywrightAgent[] = ["claude", "codex", "agy"];

async function playwrightRegistered(agent: PlaywrightAgent, configPath: string, processAdapter: ProcessAdapter): Promise<boolean> {
  if (agent === "codex") {
    const list = await processAdapter.run("codex", ["mcp", "list", "--json"]);
    if (list.kind !== "ok") return false;
    try {
      const parsed = JSON.parse(list.value.stdout) as Array<{ name?: string; transport?: { command?: string; args?: readonly string[] } }>;
      return parsed.some((entry) => {
        const args = (entry.transport?.args ?? []).join(" ");
        return entry.name === "playwright" && entry.transport?.command === "npx" && args.includes("@playwright/mcp@latest") && args.includes("--config") && args.includes(configPath);
      });
    } catch {
      return false;
    }
  }
  const list = await processAdapter.run(agent, ["mcp", "list"]);
  if (list.kind !== "ok") return false;
  const text = list.value.stdout;
  return text.includes("playwright") && text.includes("@playwright/mcp@latest") && text.includes(`--config ${configPath}`);
}

async function registerPlaywright(agent: PlaywrightAgent, configPath: string, processAdapter: ProcessAdapter): Promise<Result<void>> {
  if (await playwrightRegistered(agent, configPath, processAdapter)) return ok(undefined);
  await processAdapter.run(agent, ["mcp", "remove", "playwright"]);
  const args = agent === "codex"
    ? ["mcp", "add", "playwright", "--", "npx", "-y", "@playwright/mcp@latest", "--config", configPath]
    : ["mcp", "add", "--scope", "user", "playwright", "--", "npx", "-y", "@playwright/mcp@latest", "--config", configPath];
  const result = await processAdapter.run(agent, args);
  if (result.kind !== "ok") return failed(`${agent}: playwright MCP registration failed`);
  return ok(undefined);
}

async function installSimulatorWeb(environment: Environment, processAdapter: ProcessAdapter, browser: string): Promise<Result<void>> {
  if (!(await available(processAdapter, "node")) || !(await available(processAdapter, "npm"))) {
    return failed(`node and npm are required for pinned Playwright 1.62.1`);
  }
  const script = environment.MEGABRAIN_PLAYWRIGHT_SCRIPT ?? join(resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT), "scripts/playwright-web.mjs");
  if (!existsSync(script)) return failed("node, npm, and the browser setup script are required for simulator-web");
  if (!(await available(processAdapter, "npx"))) return failed("npx is not on PATH");
  const versionCheck = await processAdapter.run("npx", ["-y", "@playwright/mcp@latest", "--version"]);
  if (versionCheck.kind !== "ok") return failed("@playwright/mcp could not be executed by npx");
  const root = environment.MEGABRAIN_PLAYWRIGHT_ROOT ?? `${environment.HOME ?? ""}/.megabrain/playwright`;
  const install = await processAdapter.run("node", [script, "install", "--root", root, "--browser", browser]);
  if (install.kind !== "ok") return failed("browser setup failed; run doctor for prerequisites");
  let manifest: { activeBrowser?: string; profiles?: Record<string, { configPath?: string }> };
  try {
    manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")) as typeof manifest;
  } catch {
    return failed("browser setup did not write the active MCP config");
  }
  const activeBrowser = manifest.activeBrowser ?? "chromium";
  const configPath = manifest.profiles?.[activeBrowser]?.configPath;
  if (configPath === undefined || configPath === "") return failed("browser setup did not write the active MCP config");
  const failedAgents: string[] = [];
  for (const agent of playwrightAgents) {
    if (!(await available(processAdapter, agent))) continue;
    const result = await registerPlaywright(agent, configPath, processAdapter);
    if (result.kind !== "ok") failedAgents.push(agent);
  }
  if (failedAgents.length > 0) return failed(`playwright MCP registration failed for ${failedAgents.join(", ")}`);
  return ok(undefined);
}

// --- tmux-runtime -----------------------------------------------------------------------------

async function installTmuxRuntime(environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<void>> {
  if (!(await available(processAdapter, "tmux"))) {
    const platform = await processAdapter.run("uname", ["-s"]);
    const os = platform.kind === "ok" ? platform.value.stdout.trim() : "";
    if (os === "Darwin") {
      if (!(await available(processAdapter, "brew"))) return failed("tmux is missing. Install it with: brew install tmux");
      const brew = await processAdapter.run("brew", ["install", "tmux"]);
      if (brew.kind !== "ok") return failed("brew install tmux failed");
    } else if (os === "Linux") {
      return failed("tmux is missing. Install it with your package manager, for example: sudo apt-get install tmux");
    } else {
      return failed("tmux is missing. Install tmux with your operating system package manager");
    }
  }
  const tuneArgs = options.yes ? ["tune", "--yes"] : ["tune"];
  const tuneResult = await executeTmux(tuneArgs, environment, processAdapter);
  if (tuneResult.kind !== "ok") return failed(tuneResult.kind === "failed" ? tuneResult.error : "tmux tuning failed");
  const wrapperArgs = options.yes ? ["wrapper", "--yes"] : ["wrapper"];
  const wrapperResult = await executeTmux(wrapperArgs, environment, processAdapter);
  if (wrapperResult.kind !== "ok") return failed(wrapperResult.kind === "failed" ? wrapperResult.error : "tmux wrapper failed");
  // WHY: the tmux-runtime doctor reads this flag back to decide "enabled" vs "disabled"
  // (report()'s tmux-runtime branch), so it must be recorded before the after-install
  // doctor re-check below, exactly as the shell set state before its own doctor call.
  writeInstalledState(environment, "tmux-runtime", true, "tmux runtime enabled");
  return ok(undefined);
}

// --- dispatch ----------------------------------------------------------------------------------

async function runInstallStep(module: string, environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<void>> {
  switch (module) {
    case "orchestration": return ok(undefined);
    case "worktree": return ok(undefined);
    case "orchestration-hooks": return installOrchestrationHooks(environment, processAdapter);
    case "simulator-web": return installSimulatorWeb(environment, processAdapter, options.browser);
    case "simulator-native": return installSimulatorNative(processAdapter);
    case "simulator-tv": return installSimulatorNative(processAdapter);
    case "tv-adb": return installTvAdb(processAdapter);
    case "tmux-runtime": return installTmuxRuntime(environment, processAdapter, options);
    case "skill-sync": installSkillSync(environment); return ok(undefined);
    default: return failed(`unknown module: ${module}`, 2);
  }
}

async function installOne(module: string, environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<string>> {
  // WHY: the shell's megabrain_install_one always calls the module's install function first,
  // unconditionally, and only checks doctor status afterward — it never skips the install step
  // just because doctor already reports "ok" beforehand. A doctor "ok" can be satisfied by
  // content that still needs repairing (e.g. orchestration-hooks: a stale, duplicated entry
  // pointing at a different checkout's binary still matches hookCommandKind's path-agnostic
  // pattern and reads as "present"), so skipping here would silently skip the repair too.
  // "unsupported" is the one status still checked first,
  // matching where the shell placed that specific refusal (module_simulator_native_install's own
  // doctor check, before touching npm) — every other module's doctor never reports it.
  const current = await report(module, environment, processAdapter);
  if (current.status === "unsupported") return failed(`${module}: ${current.reason}`);
  const step = await runInstallStep(module, environment, processAdapter, options);
  if (step.kind !== "ok") {
    writeInstalledState(environment, module, false, step.error);
    return failed(`${module}: ${step.error}`);
  }
  const after = await report(module, environment, processAdapter);
  writeInstalledState(environment, module, after.status === "ok", after.reason);
  const text = `${module}: ${after.status} (${after.reason})\n`;
  return after.status === "ok" ? ok(text) : failed(text.trim());
}

async function interactiveInstall(environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<string>> {
  let listing = "Select modules to install (numbers separated by spaces, or all):\n";
  modules.forEach((id, index) => { listing += `  [${index + 1}] ${id}\n`; });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePrompt) => {
    rl.question(`${listing}Modules: `, (value) => {
      rl.close();
      resolvePrompt(value);
    });
  });
  const trimmed = answer.trim();
  let selection: readonly string[];
  if (trimmed === "all") {
    selection = modules;
  } else {
    const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
    const resolved: string[] = [];
    for (const token of tokens) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 1 || index > modules.length) return failed(`invalid module selection: ${token}`);
      resolved.push(modules[index - 1]);
    }
    selection = resolved;
  }
  let exitCode = 0;
  let text = "";
  for (const id of selection) {
    const result = await installOne(id, environment, processAdapter, options);
    text += result.kind === "ok" ? result.value : `${id}: ${result.kind === "failed" || result.kind === "unknown" ? result.error : "install failed"}\n`;
    if (result.kind !== "ok") exitCode = 1;
  }
  return exitCode === 0 ? ok(text) : failed(text);
}

export async function executeInstall(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args.includes("-h") || args.includes("--help")) return ok(usageText("install"));
  const first = args[0];
  const machineFlags = new Set(["--agents", "--skill", "--modules", "--yes"]);
  const machineSetup = args.length === 0 || (first !== undefined && first.startsWith("--") && args.some((arg) => machineFlags.has(arg)));
  if (machineSetup) {
    return runMachineInstall(args, environment, processAdapter, (module) => installOne(module, environment, processAdapter, { yes: true, browser: "both" }));
  }
  let module: string | undefined;
  let yes = false;
  let revert = false;
  let browser = "both";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") { yes = true; continue; }
    if (arg === "--revert") { revert = true; continue; }
    if (arg === "--browser") {
      const value = args[index + 1];
      if (value === undefined) return failed("install accepts a browser value", 2);
      browser = value;
      index += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") return ok(usageText("install"));
    if (module !== undefined) return failed("install accepts at most one module id", 2);
    module = arg;
  }
  const options: InstallOptions = { yes, browser };
  if (module === undefined) {
    if (!isInteractiveTerminal()) return failed("install without a module id requires an interactive terminal");
    return interactiveInstall(environment, processAdapter, options);
  }
  if (!modules.includes(module)) return failed(`unknown module: ${module}`, 2);
  if (revert) {
    if (module !== "orchestration-hooks") return failed(`module cannot be reverted: ${module}`, 2);
    return revertOrchestrationHooks(environment, processAdapter);
  }
  if (module === "simulator-web" && browser !== "chromium" && browser !== "firefox" && browser !== "both") {
    return failed("browser must be chromium, firefox, or both", 2);
  }
  return installOne(module, environment, processAdapter, options);
}
