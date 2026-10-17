import { getInstallState, putInstallModule, stateDatabase } from "../../../adapters/state-db.js";import { dirname } from "node:path";import packageJson from "../../../../package.json" with { type: "json" };
import type { ProcessAdapter } from "../../../adapters/proc.js";import { failed, ok, type Result } from "../../../core/result.js";import { discoverAgentDirectories, type AgentEnvironment, type MachineAgent, type MachineAgentDirectories } from "../../../core/agent-directories.js";import { agentLabel, moduleInfo, type AgentChoice, type ModuleChoice, type SkillMode } from "../install-ui.js";
import { agents, modules, resolveDefaultModuleSelection, detectAgents } from "./selection.js";import type { MachineSelection, DefaultModuleSelection } from "./selection.js";
export function readMachineState(environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>): Record<string, unknown> | undefined {
  const opened = stateDatabase(environment);
  if (opened.kind !== "ok") return undefined;
  const loaded = getInstallState(opened.value);
  return loaded.kind === "ok" ? loaded.value : undefined;
}

export type PersistedMachineSelection = Readonly<{
  readonly agents: readonly MachineAgent[];
  readonly skill: SkillMode;
  readonly tmux: "yes" | "no";
  /** Modules requested for this machine install. */
  readonly requestedModules: readonly string[];
  /** Modules that completed successfully, in request order. */
  readonly modules: readonly string[];
  readonly version: string;
}>;

export function matchingMachineInstall(left: unknown, right: PersistedMachineSelection): PersistedMachineSelection | undefined {
  if (typeof left !== "object" || left === null || Array.isArray(left)) return undefined;
  const value = left as Record<string, unknown>;
  if (value.agents === undefined || JSON.stringify(value.agents) !== JSON.stringify(right.agents)) return undefined;
  if (value.skill !== right.skill || value.version !== right.version || !Array.isArray(value.modules)) return undefined;
  const tmux = value.tmux ?? (value.modules.includes("tmux-runtime") ? "yes" : "no");
  if (tmux !== right.tmux) return undefined;
  const requestedModules = Array.isArray(value.requestedModules) ? value.requestedModules : value.modules;
  if (JSON.stringify(requestedModules) !== JSON.stringify(right.requestedModules)) return undefined;
  if (!value.modules.every((module): module is string => typeof module === "string" && right.requestedModules.includes(module))) return undefined;
  return {
    agents: right.agents,
    skill: right.skill,
    tmux: right.tmux,
    requestedModules: right.requestedModules,
    modules: value.modules as string[],
    version: right.version,
  };
}

export function writeMachineState(environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>, selection: MachineSelection, configuredModules: readonly string[]): Result<void> {
  const opened = stateDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const value = { agents: selection.agents, skill: selection.skill, tmux: selection.tmux, requestedModules: selection.modules, modules: configuredModules, version: packageJson.version };
  const saved = putInstallModule(opened.value, "machineInstall", value);
  return saved.kind === "ok" ? ok(undefined) : saved;
}

export type MachineContext = Readonly<{
  defaults: DefaultModuleSelection;
  availableAgents: readonly MachineAgent[];
  directories: MachineAgentDirectories;
  state: Record<string, unknown>;
  tmuxInstalled: boolean;
  /** What this machine chose on its last install, so a re-run starts there rather than from detection. */
  last: Readonly<{ agents?: readonly MachineAgent[]; skill?: SkillMode; tmux?: "yes" | "no"; requested?: readonly string[]; configured?: readonly string[] }>;
}>;

export async function machineContext(environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>, processAdapter: ProcessAdapter): Promise<MachineContext | undefined> {
  const defaults = await resolveDefaultModuleSelection(environment, processAdapter);
  const availableAgents = await detectAgents(processAdapter);
  const directories = discoverAgentDirectories(environment);
  const state = readMachineState(environment);
  if (state === undefined) return undefined;
  const tmuxState = state["tmux-runtime"];
  const tmuxInstalled = typeof tmuxState === "object" && tmuxState !== null && !Array.isArray(tmuxState) && (tmuxState as Record<string, unknown>).installed === true;
  const recorded = typeof state.machineInstall === "object" && state.machineInstall !== null && !Array.isArray(state.machineInstall)
    ? state.machineInstall as Record<string, unknown>
    : undefined;
  const strings = (value: unknown): string[] | undefined => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
  return {
    defaults,
    availableAgents,
    directories,
    state,
    tmuxInstalled,
    last: {
      agents: strings(recorded?.agents)?.filter((agent): agent is MachineAgent => (agents as readonly string[]).includes(agent)),
      skill: recorded?.skill === "none" || recorded?.skill === "global" || recorded?.skill === "project" ? recorded.skill : undefined,
      tmux: recorded?.tmux === "yes" || recorded?.tmux === "no" ? recorded.tmux : undefined,
      requested: strings(recorded?.requestedModules),
      configured: strings(recorded?.modules),
    },
  };
}

export function agentChoices(context: MachineContext): AgentChoice[] {
  return agents.map((agent) => ({
    agent,
    installed: context.availableAgents.includes(agent),
    configDir: context.directories[agent] === undefined ? undefined : dirname(dirname(dirname(context.directories[agent].globalSkill))),
  }));
}

export function defaultTmux(context: MachineContext): boolean {
  return context.tmuxInstalled || !Object.hasOwn(context.state, "machineInstall");
}

export function moduleChoices(context: MachineContext, tmux: "yes" | "no"): ModuleChoice[] {
  const { defaults } = context;
  return modules.filter((module) => module !== "tmux-runtime").map((module): ModuleChoice => {
    // Orchestration needs somewhere to open children; the tmux answer can provide it.
    const unavailableReason = module === "orchestration"
      ? (defaults.orcaAvailable || defaults.supersetAvailable || tmux === "yes" ? undefined : "needs Orca, Superset or tmux")
      : defaults.unavailable[module];
    return {
      module,
      selectedByDefault: unavailableReason === undefined && (context.last.requested ?? defaults.modules).includes(module),
      skippedReason: unavailableReason,
      unavailable: unavailableReason !== undefined,
    };
  });
}

// What an install would offer on this machine, for a program to present: the same detection,
// choices and defaults as the terminal flow, without asking or changing anything.
export async function machineInstallPlan(environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>, processAdapter: ProcessAdapter): Promise<Result<string>> {
  const context = await machineContext(environment, processAdapter);
  if (context === undefined) return failed("could not read valid megabrain install state");
  const { defaults, last } = context;
  const tmux = defaults.tmuxAvailable && defaultTmux(context) ? "yes" : "no";
  const choices = moduleChoices(context, tmux);
  const defaultAgents = last.agents ?? context.availableAgents;
  const plan = {
    version: packageJson.version,
    hosts: { orca: defaults.orcaAvailable, superset: defaults.supersetAvailable, tmux: defaults.tmuxAvailable },
    agents: agentChoices(context).map((choice) => ({ agent: choice.agent, label: agentLabel(choice.agent), installed: choice.installed, configDir: choice.configDir ?? null })),
    modules: choices.map((choice) => ({
      module: choice.module,
      ...moduleInfo(choice.module),
      selectedByDefault: choice.selectedByDefault,
      unavailable: choice.unavailable === true,
      reason: choice.skippedReason ?? null,
    })),
    defaults: {
      agents: defaultAgents,
      skill: defaultAgents.length === 0 ? "none" : last.skill ?? "global",
      tmux,
      modules: choices.filter((choice) => choice.selectedByDefault).map((choice) => choice.module),
    },
    previous: last.agents === undefined && last.configured === undefined
      ? null
      : { agents: last.agents ?? [], skill: last.skill ?? "none", tmux: last.tmux ?? "no", modules: last.configured ?? [] },
  };
  return ok(`${JSON.stringify(plan, null, 2)}\n`);
}

