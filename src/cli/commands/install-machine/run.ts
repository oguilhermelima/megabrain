import { deleteInstallModule, stateDatabase } from "../../../adapters/state-db.js";import { join } from "node:path";import packageJson from "../../../../package.json" with { type: "json" };
import type { ProcessAdapter } from "../../../adapters/proc.js";import { failed, ok, type Result } from "../../../core/result.js";import { resolvePackageRoot } from "../../../core/package-root.js";import { type AgentEnvironment, type MachineAgent } from "../../../core/agent-directories.js";import { executeTmux } from "../tmux.js";import { agentLabel, createClackPrompter, moduleLabel, SetupCancelled, type MachinePrompter, type SkillMode } from "../install-ui.js";import { createJsonPrompter } from "../install-json.js";
import { installAgentSkills, agents, modules, parseMachineInstallArgs } from "./selection.js";import type { MachineSelection, MachineArguments } from "./selection.js";import { retireLegacyChannels, retireLegacyInstructions } from "./legacy-retirement.js";import { readMachineState, matchingMachineInstall, writeMachineState, machineContext, agentChoices, defaultTmux, moduleChoices, machineInstallPlan } from "./state-plan.js";import type { PersistedMachineSelection } from "./state-plan.js";
export async function runMachineInstall(
  args: readonly string[],
  environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>,
  processAdapter: ProcessAdapter,
  installModule: (module: string) => Promise<Result<string>>,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  revertTmuxRuntime: () => Promise<Result<string>> = () => executeTmux(["wrapper", "--revert"], environment, processAdapter),
  createPrompter: () => MachinePrompter = createClackPrompter,
  write: (text: string) => void = (text) => { process.stdout.write(text); },
): Promise<Result<string>> {
  const plan = args.includes("--plan");
  const json = args.includes("--json");
  if (plan && !json) return failed("install --plan requires --json", 2);
  const parsed = parseMachineInstallArgs(args.filter((arg) => arg !== "--plan" && arg !== "--json"));
  if ("kind" in parsed) return parsed;
  if (plan) {
    if (parsed.provided || parsed.yes) return failed("install --plan takes no selection flags", 2);
    return machineInstallPlan(environment, processAdapter);
  }
  if (!interactive && !parsed.yes && !parsed.provided) {
    return failed("install setup requires a terminal, --yes, or explicit --agents, --skill, or --modules flags");
  }
  // The rich terminal flow only runs when a person is answering; --yes and scripted flags keep the
  // plain line output below, which tests and automation read. --json streams events instead.
  const jsonUi = json ? createJsonPrompter(write, parsed.yes) : undefined;
  const ui = jsonUi ?? (interactive && !parsed.yes ? createPrompter() : undefined);
  try {
    const result = await installMachine(parsed, environment, processAdapter, installModule, revertTmuxRuntime, ui);
    if (jsonUi !== undefined) {
      const recorded = readMachineState(environment)?.machineInstall;
      const configured = typeof recorded === "object" && recorded !== null && Array.isArray((recorded as Record<string, unknown>).modules)
        ? ((recorded as Record<string, unknown>).modules as unknown[]).filter((module): module is string => typeof module === "string")
        : [];
      const success = result.kind === "ok" && (result.exitCode ?? 0) === 0;
      jsonUi.finish(success, configured, result.kind === "ok" ? "" : result.error.trim());
    }
    return result;
  } catch (error: unknown) {
    // The prompt already told the person it was cancelled; only the exit status is left to report.
    if (error instanceof SetupCancelled) return ok("", 130);
    throw error;
  }
}

export async function installMachine(
  parsed: MachineArguments,
  environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>,
  processAdapter: ProcessAdapter,
  installModule: (module: string) => Promise<Result<string>>,
  revertTmuxRuntime: () => Promise<Result<string>>,
  ui: MachinePrompter | undefined,
): Promise<Result<string>> {
  const context = await machineContext(environment, processAdapter);
  if (context === undefined) return failed("could not read valid megabrain install state");
  const { defaults, availableAgents, directories, state, tmuxInstalled, last } = context;

  if (ui !== undefined) {
    ui.intro(packageJson.version, agentChoices(context), { orca: defaults.orcaAvailable, superset: defaults.supersetAvailable, tmux: defaults.tmuxAvailable });
  }

  const detected = parsed.agents ?? availableAgents;
  const selectedAgents: readonly MachineAgent[] = parsed.agents ?? (ui === undefined
    ? detected
    : await ui.agents(agentChoices(context), last.agents ?? availableAgents));
  const skill: SkillMode = parsed.skill ?? (ui !== undefined && selectedAgents.length > 0 ? await ui.skill(last.skill ?? "global") : ui !== undefined ? "none" : "global");
  const tmux: "yes" | "no" = parsed.tmux ?? (!defaults.tmuxAvailable
    ? "no"
    : ui !== undefined ? await ui.tmux(defaultTmux(context)) : parsed.yes ? "yes" : "no");
  let modulesToInstall = [...(parsed.modules ?? (ui === undefined
    ? defaults.modules
    : await ui.modules(moduleChoices(context, tmux))))];
  if (tmux === "yes" && !modulesToInstall.includes("tmux-runtime")) modulesToInstall.unshift("tmux-runtime");
  if (tmux === "no") modulesToInstall = modulesToInstall.filter((module) => module !== "tmux-runtime");
  const defaultSkips = [
    ...(parsed.modules === undefined && ui === undefined ? defaults.skipped.filter(({ module }) => module !== "tmux-runtime" && !modulesToInstall.includes(module)) : []),
    ...(!defaults.tmuxAvailable && tmux === "no" ? [{ module: "tmux-runtime", reason: "tmux was not found" }] : []),
  ].map(({ module, reason }) => `${module} skipped: ${reason}`);
  const selection: MachineSelection = { agents: selectedAgents, skill, tmux, modules: modulesToInstall, yes: parsed.yes, provided: parsed.provided };

  if (ui !== undefined && !(await ui.review({ agents: selectedAgents, skill, tmux, modules: modulesToInstall, skippedDefaults: defaultSkips }))) {
    ui.outro("Nothing was changed.");
    return ok("");
  }

  const confirm = ui === undefined ? undefined : (message: string) => ui.confirm(message, true);
  let tmuxReverted = false;
  if (tmux === "no" && tmuxInstalled) {
    const shouldRevert = parsed.yes || (confirm !== undefined && await confirm("Turn off the tmux runtime and remove its shell wrapper?"));
    if (!shouldRevert) {
      if (ui !== undefined) { ui.outro("tmux runtime kept; nothing else was changed."); return ok(""); }
      return ok("tmux runtime retained; rerun with --yes to remove it\n");
    }
    const step = ui?.step("Turning off the tmux runtime");
    const reverted = await revertTmuxRuntime();
    if (reverted.kind !== "ok") {
      const reason = reverted.kind === "failed" ? reverted.error : reverted.reason;
      step?.fail(`tmux runtime: ${reason}`);
      return failed(`tmux runtime revert failed: ${reason}`);
    }
    step?.done("tmux runtime turned off");
    const opened = stateDatabase(environment);
    if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
    const deleted = deleteInstallModule(opened.value, "tmux-runtime");
    if (deleted.kind !== "ok") return deleted;
    tmuxReverted = true;
  }
  const recordedSelection: PersistedMachineSelection = { agents: selectedAgents, skill, tmux, requestedModules: modulesToInstall, modules: modulesToInstall, version: packageJson.version };
  const previous = matchingMachineInstall(state.machineInstall, recordedSelection);
  const legacyInstructions = await retireLegacyInstructions(environment, process.cwd(), parsed.yes, confirm);
  if (legacyInstructions.kind !== "ok") return legacyInstructions;
  if (ui !== undefined && legacyInstructions.value.length > 0) ui.info(legacyInstructions.value.trim());
  const configuredModules = [...(previous?.modules ?? [])];
  const pendingModules = modulesToInstall.filter((module) => !configuredModules.includes(module));
  const skillsConfigured = previous !== undefined;
  if (skillsConfigured && pendingModules.length === 0) {
    if (ui !== undefined) {
      ui.outro("Everything is already set up. Nothing to change.");
      return ok("");
    }
    const summary = `machine install summary: configured ${configuredModules.join(", ") || "none"}; failed none\n`;
    return ok(`${legacyInstructions.value}${tmuxReverted ? "tmux runtime reverted\n" : ""}${defaultSkips.length > 0 ? `${defaultSkips.join("\n")}\n` : ""}machine configuration already current; no changes made\n${summary}`);
  }

  try {
    if (!modulesToInstall.includes("tmux-runtime")) {
      const opened = stateDatabase(environment);
      if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
      const deleted = deleteInstallModule(opened.value, "tmux-runtime");
      if (deleted.kind !== "ok") return deleted;
    }
    const retired = await retireLegacyChannels(availableAgents, processAdapter, parsed.yes, confirm);
    if (retired.kind !== "ok") return retired;
    if (ui !== undefined && retired.value.length > 0 && !retired.value.includes("no legacy plugin registrations found")) ui.info(retired.value.trim());
    const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
    if (!skillsConfigured && skill !== "none" && selectedAgents.length > 0) {
      const step = ui?.step("Installing the megabrain skill");
      const installed = installAgentSkills(join(root, "skills/megabrain/SKILL.md"), selectedAgents, skill, directories, process.cwd());
      if (step !== undefined) step.done(`Skill installed for ${selectedAgents.map(agentLabel).join(", ")}`);
      else for (const path of installed) process.stdout.write(`skill installed at ${path}\n`);
    }
    // Record the selected skill configuration before attempting modules so a failed module does
    // not make a later run rewrite the skill files that already succeeded.
    const saved = writeMachineState(environment, selection, configuredModules);
    if (saved.kind !== "ok") return saved;
    const failures: string[] = [];
    for (const module of pendingModules) {
      const step = ui?.step(`Setting up ${moduleLabel(module)}`, module);
      try {
        const result = await installModule(module);
        if (result.kind !== "ok") {
          const reason = result.kind === "failed" ? result.error : result.reason;
          failures.push(`${module}: ${reason}`);
          step?.fail(`${moduleLabel(module)}: ${reason.startsWith(`${module}: `) ? reason.slice(module.length + 2) : reason}`);
          continue;
        }
        configuredModules.push(module);
        step?.done(moduleLabel(module));
        const warning = /\(warning: ([^;)]+)/.exec(result.value)?.[1];
        if (ui !== undefined && warning !== undefined) ui.warn(`${moduleLabel(module)}: ${warning}. Review with megabrain orchestrate list --uncertain`);
        const saved = writeMachineState(environment, selection, configuredModules);
        if (saved.kind !== "ok") throw new Error(saved.kind === "failed" ? saved.error : "could not save megabrain install state");
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "module installation failed";
        failures.push(`${module}: ${reason}`);
        step?.fail(`${moduleLabel(module)}: ${reason}`);
      }
    }
    if (ui !== undefined) {
      const next = tmux === "yes" ? "Open a new terminal tab so agents start inside tmux." : "Run megabrain doctor any time to check the setup.";
      const missed = failures.map((failure) => moduleLabel(failure.split(":", 1)[0] ?? "")).join(", ");
      ui.outro(failures.length === 0 ? `All set. ${next}` : `Everything else is set up. ${missed} ${failures.length === 1 ? "was" : "were"} not; fix what is shown above and run megabrain install again, or leave ${failures.length === 1 ? "it" : "them"} unselected.`);
      return ok("", failures.length === 0 ? undefined : 1);
    }
    const summary = `machine install summary: configured ${configuredModules.join(", ") || "none"}; failed ${failures.map((failure) => failure.split(":", 1)[0]).join(", ") || "none"}\n`;
    const skipped = defaultSkips.length > 0 ? `${defaultSkips.join("\n")}\n` : "";
    if (failures.length > 0) return failed(`${legacyInstructions.value}${retired.value}${tmuxReverted ? "tmux runtime reverted\n" : ""}${skipped}${failures.join("\n")}\n${summary}`);
    return ok(`${legacyInstructions.value}${retired.value}${tmuxReverted ? "tmux runtime reverted\n" : ""}${skipped}machine configuration installed for agents ${selectedAgents.join(",") || "none"}; modules ${configuredModules.join(", ") || "none"}\n${summary}`);
  } catch (error: unknown) {
    if (error instanceof SetupCancelled) throw error;
    return failed(error instanceof Error ? error.message : "machine configuration failed");
  }
}
