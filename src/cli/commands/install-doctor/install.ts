import { INSTALL_VALUE_OPTIONS } from "../install-machine/selection.js";
import { createInterface } from "node:readline";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { installSkillSync } from "../../../core/skill.js";import { installArtifactsDiagram, revertArtifactsDiagram } from "../artifacts-diagram-install.js";import { executeTmux } from "../tmux.js";import { usageText } from "../../../core/usage.js";import { runMachineInstall } from "../install-machine.js";import { installMaestro, revertMaestro } from "../maestro-install.js";
import { modules, hookCommandKind, hookConfig, legacyAgyHookConfig } from "./diagnostics.js";import type { Environment } from "./diagnostics.js";import { report, output } from "./doctor.js";import { isInteractiveTerminal, writeInstalledState } from "./install-state.js";import type { InstallOptions } from "./install-state.js";import { readHookInstallState } from "./hook-config.js";import { installOrchestrationHooks, revertOrchestrationHooks } from "./hook-revert.js";import { resourceEntryHook, summariesEntryHook, installEntryHooks, revertEntryHooks } from "./entry-hooks.js";import { installSimulatorNative, installTvAdb, installSimulatorWeb, installTmuxRuntime } from "./platform-install.js";
// --- dispatch ----------------------------------------------------------------------------------

export async function runInstallStep(module: string, environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<void>> {
  switch (module) {
    case "orchestration": return ok(undefined);
    case "worktree": return ok(undefined);
    case "orchestration-hooks": return installOrchestrationHooks(environment, processAdapter);
    case "resource-hooks": return installEntryHooks(environment, processAdapter, resourceEntryHook);
    case "summaries-context": return installEntryHooks(environment, processAdapter, summariesEntryHook);
    case "simulator-web": return installSimulatorWeb(environment, processAdapter, options.browser);
    case "simulator-native": return installSimulatorNative(processAdapter);
    case "simulator-tv": return installSimulatorNative(processAdapter);
    case "simulator-maestro": return installMaestro(environment, processAdapter);
    case "tv-adb": return installTvAdb(processAdapter);
    case "tmux-runtime": return installTmuxRuntime(environment, processAdapter, options);
    case "skill-sync": installSkillSync(environment); return ok(undefined);
    case "artifacts-diagram": return installArtifactsDiagram(environment, processAdapter);
    default: return failed(`unknown module: ${module}`, 2);
  }
}

export async function installOne(module: string, environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<string>> {
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
    const saved = await writeInstalledState(environment, module, false, step.error);
    if (saved.kind !== "ok") return saved;
    return failed(`${module}: ${step.error}`);
  }
  const after = await report(module, environment, processAdapter);
  // Orchestration installs nothing of its own: it is usable as soon as one runtime is. Leftover
  // dispatch records that need review are worth reporting, but they are not a failed install.
  if (module === "orchestration" && after.status === "misconfigured" && typeof after.usableRuntimes === "number" && after.usableRuntimes > 0) {
    const saved = await writeInstalledState(environment, module, true, after.reason);
    if (saved.kind !== "ok") return saved;
    return ok(`${module}: ok (warning: ${after.reason})\n`);
  }
  const saved = await writeInstalledState(environment, module, after.status === "ok", after.reason);
  if (saved.kind !== "ok") return saved;
  const movedLegacyAgy = module === "orchestration-hooks" && readHookInstallState(environment).movedLegacyAgy === true;
  const migration = movedLegacyAgy
    ? `agy hook moved from ${legacyAgyHookConfig(environment)} to ${hookConfig(environment, "agy")}\n`
    : "";
  const text = `${module}: ${after.status} (${after.reason})\n${migration}`;
  return after.status === "ok" ? ok(text) : failed(text.trim());
}

export async function interactiveInstall(environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<string>> {
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
  const machineFlags = new Set(["--agents", "--skill", "--modules", "--tmux", "--yes", "--plan", "--json"]);
  const machineSetup = args.includes("--plan") || args.length === 0 || (first !== undefined && first.startsWith("--") && args.some((arg) => machineFlags.has(arg)));
  if (machineSetup) {
    const positional: string[] = [];
    if (args.includes("--plan")) {
      for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if ((INSTALL_VALUE_OPTIONS as readonly string[]).includes(arg)) {
          if (args[index + 1] === undefined || args[index + 1].startsWith("--")) return failed(`install option requires a value: ${arg}`, 2);
          index += 1;
          continue;
        }
        if (["--plan", "--json", "--yes", "--revert"].includes(arg)) continue;
        if (arg.startsWith("-")) return failed(`unknown install option: ${arg}`, 2);
        positional.push(arg);
      }
    }
    if (positional.length > 1) return failed("install accepts at most one module id", 2);
    const moduleId = positional[0];
    const machineArgs = (moduleId === undefined ? args : args.filter((arg) => arg !== moduleId)).filter((arg, index, values) => arg !== "--browser" && values[index - 1] !== "--browser");
    if (moduleId !== undefined && !modules.includes(moduleId)) return failed(`unknown module: ${moduleId}`, 2);
    return runMachineInstall(
      machineArgs,
      environment,
      processAdapter,
      (module) => installOne(module, environment, processAdapter, { yes: true, browser: "both" }),
      undefined,
      () => executeTmux(["wrapper", "--revert"], environment, processAdapter),
      undefined,
      undefined,
      moduleId,
    );
  }
  let module: string | undefined;
  let yes = false;
  let revert = false;
  let json = false;
  let browser = "both";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") { yes = true; continue; }
    if (arg === "--revert") { revert = true; continue; }
    if (arg === "--json") { json = true; continue; }
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
  const result = await installModuleCommand(module, revert, browser, environment, processAdapter, options);
  return json ? moduleResultAsJson(module, revert ? "revert" : "install", result) : result;
}

// One module's outcome as a single JSON object, keeping the exit code the text form would have.
export function moduleResultAsJson(module: string, action: "install" | "revert", result: Result<string>): Result<string> {
  const message = (result.kind === "ok" ? result.value : result.error).trim();
  const succeeded = result.kind === "ok" && (result.exitCode ?? 0) === 0;
  const body = JSON.stringify({ module, action, ok: succeeded, message });
  return result.kind === "ok" ? ok(`${body}\n`, result.exitCode) : failed(body, result.exitCode);
}

export async function installModuleCommand(
  module: string,
  revert: boolean,
  browser: string,
  environment: Environment,
  processAdapter: ProcessAdapter,
  options: InstallOptions,
): Promise<Result<string>> {
  if (!modules.includes(module)) return failed(`unknown module: ${module}`, 2);
  if (revert) {
    if (module === "resource-hooks") return revertEntryHooks(environment, resourceEntryHook);
    if (module === "summaries-context") return revertEntryHooks(environment, summariesEntryHook);
    if (module === "simulator-maestro") { const saved = await writeInstalledState(environment, module, false, "reverted"); return saved.kind === "ok" ? revertMaestro(environment) : saved; }
    if (module === "artifacts-diagram") { const saved = await writeInstalledState(environment, module, false, "reverted"); return saved.kind === "ok" ? revertArtifactsDiagram(environment) : saved; }
    if (module !== "orchestration-hooks") return failed(`module cannot be reverted: ${module}`, 2);
    return revertOrchestrationHooks(environment);
  }
  if (module === "simulator-web" && browser !== "chromium" && browser !== "firefox" && browser !== "both") {
    return failed("browser must be chromium, firefox, or both", 2);
  }
  return installOne(module, environment, processAdapter, options);
}
