import nodeProcess from "node:process";
import { existsSync } from "node:fs";import { join, resolve } from "node:path";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { skillSyncDoctor } from "../../../core/skill.js";import { artifactsDiagramReport } from "../artifacts-diagram-install.js";import { probeOpeners, probeSummary } from "../../../core/terminal-openers.js";import { resolvePackageRoot } from "../../../core/package-root.js";import { usageText } from "../../../core/usage.js";import { maestroReport } from "../maestro-install.js";import { inspectDatabase } from "../../../db/db.js";
import { modules, available, succeeds, readState, hookCommandKind, hookPathIssue, hookConfigCommands, hookEntryStatus, hookConfig, worktreeRoot, tmuxFileState, emptyCounts, dispatchHealth, appiumReady, tmuxServerState } from "./diagnostics.js";import type { Environment, Report } from "./diagnostics.js";import type { HookAgent } from "./hook-config.js";import { resourceEntryHook, summariesEntryHook, entryHooksReport } from "./entry-hooks.js";
export async function report(module: string, environment: Environment, process: ProcessAdapter): Promise<Report> {
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
  } else if (module === "simulator-maestro") {
    ({ status, reason } = await maestroReport(environment, process));
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
    if (health.uncertainDispatches > 0 || health.retainedTerminals > 0) {
      status = "misconfigured";
      reason = `dispatch state requires reconciliation${suffix}`;
    } else if (usable.length > 0) { status = "ok"; reason = `usable runtimes: ${usable.join(", ")}; other runtimes are optional${suffix}`; }
    else reason = `no orchestration runtime is available; missing runtimes: ${missing.join(", ")}${suffix}`;
    return { module, status, reason, ...health, usableRuntimes: usable.length };
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
    const names = ["claude", "codex", "agy", "cursor", "grok"];
    const details: string[] = [];
    let healthy = true;
    for (const name of names) {
      const agentAvailable = name === "cursor" ? await available(process, "cursor") || await available(process, "cursor-agent") : await available(process, name);
      if (!agentAvailable) {
        details.push(`${name}: not-installed`);
        continue;
      }
      const config = hookConfig(environment, name as HookAgent);
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
  } else if (module === "resource-hooks") {
    ({ status, reason } = await entryHooksReport(environment, process, resourceEntryHook));
  } else if (module === "summaries-context") {
    ({ status, reason } = await entryHooksReport(environment, process, summariesEntryHook));
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
      const config = `${version}; runtime ${enabled ? "enabled" : "disabled"}; plain panes (no top bar); tuning block ${files.tuningBlock}; tuning file current ${files.tuningFile}; wrapper block in ${wrapperFile} ${files.wrapperBlock}; wrapper file current ${files.wrapperFile}; ${server.running ? `running server RGB ${server.rgb}` : "running server none"}; session registry current; ${server.configApplied ? "megabrain session config applied" : "megabrain session config will apply when a session launches"}`;
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
  } else if (module === "artifacts-diagram") {
    ({ status, reason } = artifactsDiagramReport(environment));
  } else if (module === "terminal-openers") {
    // Native terminals are optional viewers: none installed is still healthy, since
    // --terminal none prints the tmux attach command instead.
    const platform = nodeProcess.platform === "darwin" || nodeProcess.platform === "win32" ? nodeProcess.platform : "linux";
    const probes = await probeOpeners({ platform, home: environment.HOME ?? "", which: (command) => available(process, command), exists: existsSync });
    status = "ok";
    reason = `${probeSummary(probes)}; unverified openers have only been tested with a recording fake`;
  }
  return { module, status, reason, ...emptyCounts() };
}

export function output(value: Report, json: boolean): string {
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
  if (module !== undefined && !modules.includes(module) && module !== "database") return failed(`unknown module: ${module}`, 2);
  const databaseReport = (): Report => {
    const checked = inspectDatabase(environment);
    if (checked.kind !== "ok") return { module: "database", status: "error", reason: checked.error, ...emptyCounts() };
    if (checked.value === undefined) return { module: "database", status: "ok", reason: "database file is not present", ...emptyCounts() };
    return {
      module: "database",
      status: checked.value.clean ? "ok" : "corrupt",
      reason: checked.value.clean
        ? `quick_check ok; user_version ${checked.value.userVersion}; ${checked.value.path}`
        : `quick_check ${checked.value.quickCheck.join(", ")}; ${checked.value.foreignKeyViolations.length} foreign key violation(s); ${checked.value.path}`,
      ...emptyCounts(),
    };
  };
  if (module === "database") {
    const value = databaseReport();
    return { kind: "ok", value: `${output(value, json)}`, exitCode: value.status === "ok" ? 0 : 1 };
  }
  const values: Report[] = [];
  for (const id of module === undefined ? modules : [module]) {
    values.push(await report(id, environment, process));
  }
  const dbReport = databaseReport();
  const unhealthy = values.some((value) => value.status !== "ok") || dbReport.status !== "ok";
  const text = module === undefined && json
    ? `${JSON.stringify([...values, dbReport], null, 2)}\n`
    : `${values.map((value) => output(value, json)).join("")}${module === undefined ? output(dbReport, json) : ""}`;
  const hook = values.find((value) => value.module === "orchestration-hooks");
  const hookStderr = hook?.reason.includes("codex: entry-present")
    ? "\nCODEX ACTION REQUIRED: the megabrain hook needs one-time trust in Codex.\nOpen a plain terminal, run codex, and choose \"Trust all and continue\".\nOpening Codex through Superset will not complete this step because Superset passes --dangerously-bypass-hook-trust.\n"
    : undefined;
  const databaseStderr = json && dbReport.status !== "ok" ? `database: ${dbReport.status} (${dbReport.reason})\n` : undefined;
  const stderr = [hookStderr, databaseStderr].filter((part): part is string => part !== undefined).join("\n");
  return stderr.length === 0
    ? { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0 }
    : { kind: "ok", value: text, exitCode: unhealthy ? 1 : 0, stderr };
}

