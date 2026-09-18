import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, type Dirent } from "node:fs";
import { resolve } from "node:path";
import { failed, ok, type Result } from "../../core/result.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { resolveStateDirectory } from "../../core/state.js";

export type Environment = Readonly<Record<string, string | undefined>>;
type Report = { module: string; status: string; reason: string; uncertainDispatches: number; uncertainReasons: unknown[]; retainedTerminals: number; retainedReasons: unknown[]; leakedDispatchSessions: number; prunableDispatches: number };
type State = Record<string, Record<string, unknown>>;
const modules = ["orchestration", "orchestration-hooks", "worktree", "simulator-web", "simulator-native", "simulator-tv", "tv-adb", "tmux-runtime", "skill-sync"];
const diagnosticModules = ["compiled-binary"];
const valid = (module: string): boolean => modules.includes(module) || diagnosticModules.includes(module);

function newerSource(directory: string, binaryMtime: number): string | undefined {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = newerSource(path, binaryMtime);
      if (nested !== undefined) return nested;
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      try {
        if (statSync(path).mtimeMs > binaryMtime) return path;
      } catch {
        // A source that disappears during the scan cannot establish staleness.
      }
    }
  }
  return undefined;
}

function compiledBinaryHealth(environment: Environment): { status: string; reason: string } {
  const root = environment.MEGABRAIN_ROOT ?? process.cwd();
  const binary = resolve(root, ".build/megabrain");
  const source = resolve(root, "src");
  if (!existsSync(binary)) return { status: "unknown", reason: "compiled binary is not present; freshness cannot be determined" };
  if (!existsSync(source)) return { status: "ok", reason: "source tree is absent; compiled binary freshness is unknown" };
  try {
    const newer = newerSource(source, statSync(binary).mtimeMs);
    return newer === undefined
      ? { status: "ok", reason: "compiled binary is current" }
      : { status: "misconfigured", reason: `compiled binary is stale; newer source: ${newer}; run bun run build` };
  } catch {
    return { status: "ok", reason: "compiled binary freshness could not be checked" };
  }
}

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

function hookEntryPresent(agent: string, path: string): boolean {
  try {
    const value = JSON.parse(fileText(path) ?? "") as Record<string, unknown>;
    const hooks = value.hooks;
    if (agent === "cursor") {
      const entries = (hooks as Record<string, unknown> | undefined)?.afterAgentResponse;
      return Array.isArray(entries) && entries.some((entry) =>
        typeof entry === "object" && entry !== null &&
        /(^|\/)megabrain-turn-end\.sh($|\s)/.test(String((entry as Record<string, unknown>).command ?? "")));
    }
    const groups = (hooks as Record<string, unknown> | undefined)?.Stop;
    return Array.isArray(groups) && groups.some((group) => {
      if (typeof group !== "object" || group === null) return false;
      const entries = (group as Record<string, unknown>).hooks;
      return Array.isArray(entries) && entries.some((entry) =>
        typeof entry === "object" && entry !== null &&
        /(^|\/)megabrain-turn-end\.sh($|\s)/.test(String((entry as Record<string, unknown>).command ?? "")));
    });
  } catch {
    return false;
  }
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
  const repo = environment.MEGABRAIN_ROOT ?? process.cwd();
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

function skillTargetPaths(environment: Environment): string[] {
  const home = environment.HOME ?? "";
  const targets: string[] = [];
  for (const agent of [".claude", ".codex"]) {
    const cache = `${home}/${agent}/plugins/cache/megabrain-local/megabrain`;
    try {
      for (const entry of readdirSync(cache, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const target = `${cache}/${entry.name}/skills/megabrain/SKILL.md`;
        if (existsSync(target)) targets.push(target);
      }
    } catch {
      // An absent agent cache has no registered copies.
    }
  }
  const localTarget = resolve(".claude/skills/megabrain/SKILL.md");
  if (existsSync(localTarget)) targets.push(localTarget);
  return targets;
}

function skillSyncState(environment: Environment): { status: string; reason: string } {
  const root = environment.MEGABRAIN_ROOT ?? process.cwd();
  const source = `${root}/skills/megabrain/SKILL.md`;
  if (!existsSync(source)) return { status: "misconfigured", reason: `skill synchronization failed: installed skill source is missing: ${source}` };
  const targets = skillTargetPaths(environment);
  if (targets.length === 0) return { status: "ok", reason: "no registered skill copies found" };
  let sourceHash: string;
  try {
    sourceHash = createHash("sha256").update(readFileSync(source)).digest("hex");
  } catch {
    return { status: "misconfigured", reason: `skill synchronization failed: could not hash installed skill source: ${source}` };
  }
  let drift = 0;
  for (const target of targets) {
    try {
      const targetHash = createHash("sha256").update(readFileSync(target)).digest("hex");
      if (targetHash !== sourceHash) drift += 1;
    } catch {
      return { status: "misconfigured", reason: `skill synchronization failed: could not hash skill target: ${target}` };
    }
  }
  if (drift > 0) return { status: "misconfigured", reason: `skill drift detected in ${drift} target(s)` };
  return { status: "ok", reason: `skill copies current: ${targets.length}` };
}

function now(environment: Environment): string {
  return environment.MEGABRAIN_TEST_NOW ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function reconcile(environment: Environment, module: string, status: string, reason: string): string {
  const directory = resolveStateDirectory(environment);
  const path = statePath(environment);
  const current = readState(environment);
  const recorded = typeof current[module]?.installed === "boolean" ? current[module].installed as boolean : undefined;
  const installed = status === "ok";
  const checkedAt = now(environment);
  if (current._meta === undefined) {
    current._meta = { kind: "installation-record", recordedAt: checkedAt, source: "megabrain doctor", liveStatusCommand: "megabrain doctor" };
  }
  current[module] = {
    ...(current[module] ?? {}),
    ...(status === "unknown" ? {} : { installed }),
    checkedAt,
    status,
    statusSource: "megabrain doctor",
    details: reason,
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  if (status === "unknown") return `${reason}; state check unknown: ${module} installed state preserved`;
  if (recorded === undefined) return `${reason}; state reconciled: ${module} recorded as installed=${installed}`;
  if (recorded !== installed) return `${reason}; state reconciled: ${module} installed ${recorded} -> ${installed}`;
  return reason;
}

function emptyCounts(): Omit<Report, "module" | "status" | "reason"> {
  return { uncertainDispatches: 0, uncertainReasons: [], retainedTerminals: 0, retainedReasons: [], leakedDispatchSessions: 0, prunableDispatches: 0 };
}

type DispatchHealth = Omit<Report, "module" | "status" | "reason"> & { unrecognisedMessageFiles: string[] };

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
  const result: DispatchHealth = { ...emptyCounts(), unrecognisedMessageFiles: [] };
  const directory = resolve(resolveStateDirectory(environment), "dispatches");
  if (!existsSync(directory)) return result;
  const pruneStates = new Set(["closed", "done", "failed", "orphaned", "circuit_broken"]);
  const records: Array<Record<string, unknown>> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    result.unrecognisedMessageFiles.push(...messageFiles(resolve(directory, entry.name, "messages")));
    try {
      const record = JSON.parse(readFileSync(resolve(directory, entry.name, "meta.json"), "utf8")) as Record<string, unknown>;
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
    } catch {
      // Match the shell scan: malformed metadata is not a health record.
    }
  }
  const sessions = await process.run("tmux", ["list-sessions", "-F", "#{session_name}"]);
  const liveSessions = new Set(sessions.kind === "ok" ? sessions.value.stdout.split("\n").filter(Boolean) : []);
  let callerSession = "";
  if (environment.TMUX && environment.TMUX_PANE) {
    const caller = await process.run("tmux", ["display-message", "-p", "-t", environment.TMUX_PANE, "#{session_name}"]);
    if (caller.kind === "ok") callerSession = caller.value.stdout.trim();
  }
  const leaked = new Set<string>();
  for (const record of records) {
    if (!pruneStates.has(typeof record.state === "string" ? record.state : "")) continue;
    if (record.runtime !== "tmux") continue;
    const session = typeof record.tmuxSession === "string" ? record.tmuxSession : "";
    const parent = typeof record.parentTmuxSession === "string" ? record.parentTmuxSession : "";
    if (session && session !== parent && (!callerSession || session !== callerSession) && liveSessions.has(session)) leaked.add(session);
  }
  result.leakedDispatchSessions = leaked.size;
  return result;
}

async function appiumReady(process: ProcessAdapter): Promise<boolean> {
  return await available(process, "appium") && await succeeds(process, "appium", ["driver", "list", "--installed"]);
}

async function tmuxServerState(process: ProcessAdapter): Promise<{ running: boolean; rgb: boolean; configApplied: boolean }> {
  const sessions = await process.run("tmux", ["list-sessions", "-F", "#{session_name}"]);
  if (sessions.kind !== "ok") return { running: false, rgb: false, configApplied: false };
  const features = await process.run("tmux", ["show-options", "-gqv", "terminal-features"]);
  const rgb = features.kind === "ok" && /(^|:)RGB(?:$|\s|:)/m.test(features.value.stdout);
  let configApplied = false;
  for (const session of sessions.value.stdout.split("\n").filter((value) => value.startsWith("megabrain-"))) {
    const mouse = await process.run("tmux", ["show-options", "-t", session, "-v", "mouse"]);
    const status = await process.run("tmux", ["show-options", "-t", session, "-v", "status"]);
    const escape = await process.run("tmux", ["show-options", "-t", session, "-v", "escape-time"]);
    const border = await process.run("tmux", ["show-options", "-t", session, "-v", "pane-active-border-style"]);
    if (mouse.kind === "ok" && mouse.value.stdout.trim() === "on" && status.kind === "ok" && status.value.stdout.trim() === "off" && escape.kind === "ok" && escape.value.stdout.trim() === "0" && border.kind === "ok" && border.value.stdout.trim() !== "") configApplied = true;
  }
  return { running: true, rgb, configApplied };
}

async function report(module: string, environment: Environment, process: ProcessAdapter): Promise<Report> {
  let status = "missing";
  let reason = "module is not installed";
  if (module === "compiled-binary") {
    ({ status, reason } = compiledBinaryHealth(environment));
  } else if (module === "simulator-native" || module === "simulator-tv") {
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
        const script = environment.MEGABRAIN_PLAYWRIGHT_SCRIPT ?? (environment.MEGABRAIN_ROOT ? `${environment.MEGABRAIN_ROOT}/scripts/playwright-web.mjs` : "scripts/playwright-web.mjs");
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
    if (health.uncertainDispatches > 0 || health.retainedTerminals > 0) {
      status = "misconfigured";
      reason = `dispatch state requires reconciliation${suffix}`;
    } else if (usable.length > 0) { status = "ok"; reason = `usable runtimes: ${usable.join(", ")}; other runtimes are optional${suffix}`; }
    else reason = `no orchestration runtime is available; missing runtimes: ${missing.join(", ")}${suffix}`;
    const { unrecognisedMessageFiles: _unrecognisedMessageFiles, ...counts } = health;
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
      else if (hookEntryPresent(name, config)) details.push(`${name}: entry-present`);
      else { details.push(`${name}: entry-missing`); healthy = false; }
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
    ({ status, reason } = skillSyncState(environment));
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
    else if (arg === "-h" || arg === "--help") return ok("Usage: megabrain doctor [module-id] [--json]\n");
    else if (module !== undefined) return failed("doctor accepts at most one module id", 2);
    else module = arg;
  }
  if (module !== undefined && !valid(module)) return failed(`unknown module: ${module}`, 2);
  const values: Report[] = [];
  for (const id of module === undefined ? modules : [module]) {
    const value = await report(id, environment, process);
    value.reason = reconcile(environment, id, value.status, value.reason);
    values.push(value);
  }
  if (module === undefined) {
    const binary = await report("compiled-binary", environment, process);
    if (binary.status !== "ok") {
      binary.reason = reconcile(environment, binary.module, binary.status, binary.reason);
      values.push(binary);
    }
  }
  // An absent compiled binary is an unknown freshness result, not a finding in a fresh clone.
  const unhealthy = values.some((value) => value.status !== "ok" && !(value.module === "compiled-binary" && value.status === "unknown"));
  const text = module === undefined && json ? `${JSON.stringify(values, null, 2)}\n` : values.map((value) => output(value, json)).join("");
  const hook = values.find((value) => value.module === "orchestration-hooks");
  const stderr = hook?.reason.includes("codex: entry-present")
    ? "\nCODEX ACTION REQUIRED: the megabrain hook needs one-time trust in Codex.\nOpen a plain terminal, run codex, and choose \"Trust all and continue\".\nOpening Codex through Superset will not complete this step because Superset passes --dangerously-bypass-hook-trust.\n"
    : undefined;
  return stderr === undefined
    ? { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0 }
    : { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0, stderr };
}

export async function executeInstall(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  let module: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") continue;
    if (arg === "--json") continue;
    if (arg === "--browser") { index += 1; continue; }
    if (arg === "-h" || arg === "--help") return ok("Usage: megabrain install [module-id] [--browser chromium|firefox|both] [--yes]\n");
    if (module !== undefined) return failed("install accepts at most one module id", 2);
    module = arg;
  }
  if (module === undefined) return failed("install without a module id requires an interactive terminal");
  if (!valid(module)) return failed(`unknown module: ${module}`, 2);
  if (diagnosticModules.includes(module)) return failed(`${module} is a doctor-only diagnostic`, 2);
  const current = await report(module, environment, process);
  if (current.status === "unsupported") return failed(`${module}: ${current.reason}`);
  if (current.status === "ok") return ok(`${module}: already installed\n`);
  return failed(`${module}: installation prerequisites are unavailable`);
}
