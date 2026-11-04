import { copyFileSync, existsSync, mkdirSync } from "node:fs";import { dirname, join } from "node:path";import type { ProcessAdapter } from "../../../adapters/proc.js";import { failed, ok } from "../../../core/result.js";import { type AgentEnvironment, type MachineAgent, type MachineAgentDirectories } from "../../../core/agent-directories.js";import { type SkillMode } from "../install-ui.js";


export function installAgentSkills(
  source: string,
  agents: readonly MachineAgent[],
  mode: "global" | "project" | "none",
  directories: MachineAgentDirectories,
  projectDirectory: string,
): string[] {
  if (mode === "none") return [];
  const installed: string[] = [];
  for (const agent of agents) {
    const entry = directories[agent];
    if (entry === undefined) throw new Error(`could not resolve ${agent} configuration directory`);
    const target = mode === "global" ? entry.globalSkill : join(projectDirectory, entry.projectSkill);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    installed.push(target);
  }
  return installed;
}

export const agents = ["claude", "codex", "agy", "grok"] as const;
export const modules = ["orchestration", "orchestration-hooks", "resource-hooks", "summaries-context", "worktree", "simulator-web", "simulator-native", "simulator-tv", "simulator-maestro", "tv-adb", "tmux-runtime", "artifacts-diagram"] as const;
export const INSTALL_VALUE_OPTIONS = ["--agents", "--skill", "--modules", "--tmux", "--browser"] as const;
export type MachineSelection = Readonly<{
  readonly agents: readonly MachineAgent[];
  readonly skill: SkillMode;
  readonly tmux: "yes" | "no";
  readonly modules: readonly string[];
  readonly yes: boolean;
  readonly provided: boolean;
}>;
export type MachineArguments = Omit<MachineSelection, "agents" | "modules" | "skill" | "tmux" | "provided"> & Readonly<{
  readonly agents?: readonly MachineAgent[];
  readonly modules?: readonly string[];
  readonly skill?: SkillMode;
  readonly tmux?: "yes" | "no";
  readonly provided: boolean;
}>;
export type ParseFailure = Readonly<{ kind: "failed"; error: string; exitCode: 2 }>;

export function csv(value: string): string[] {
  return value.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
}

export function parseAgents(value: string): readonly MachineAgent[] | ParseFailure {
  const requested = csv(value);
  if (requested.length === 1 && requested[0] === "none") return [];
  if (requested.length === 0 || requested.some((agent) => !(agents as readonly string[]).includes(agent)) || requested.includes("none")) {
    return { kind: "failed", error: "--agents requires claude,codex,agy,grok or none", exitCode: 2 };
  }
  return [...new Set(requested)] as MachineAgent[];
}

export function parseModules(value: string): readonly string[] | ParseFailure {
  if (value === "all") return modules;
  const requested = csv(value);
  if (requested.length === 1 && requested[0] === "none") return [];
  if (requested.length === 0 || requested.includes("none") || requested.some((module) => !(modules as readonly string[]).includes(module))) {
    return { kind: "failed", error: "--modules requires a comma-separated module list, all, or none", exitCode: 2 };
  }
  return [...new Set(requested)];
}

export function parseMachineInstallArgs(args: readonly string[]): MachineArguments | ParseFailure {
  let selectedAgents: readonly MachineAgent[] | undefined;
  let selectedModules: readonly string[] | undefined;
  let skill: SkillMode | undefined;
  let tmux: "yes" | "no" | undefined;
  let yes = false;
  let provided = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") { yes = true; continue; }
    if (!(INSTALL_VALUE_OPTIONS as readonly string[]).includes(arg)) {
      return { kind: "failed", error: `unknown install option: ${arg}`, exitCode: 2 };
    }
    if (seen.has(arg)) return { kind: "failed", error: `${arg} may only be specified once`, exitCode: 2 };
    seen.add(arg);
    provided = true;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { kind: "failed", error: `${arg} requires a value`, exitCode: 2 };
    index += 1;
    if (arg === "--browser") {
      continue;
    } else if (arg === "--agents") {
      const parsed = parseAgents(value);
      if ("kind" in parsed) return parsed;
      selectedAgents = parsed as readonly MachineAgent[];
    } else if (arg === "--modules") {
      const parsed = parseModules(value);
      if ("kind" in parsed) return parsed;
      selectedModules = parsed as readonly string[];
    } else if (arg === "--tmux") {
      if (value !== "yes" && value !== "no") return { kind: "failed", error: "--tmux must be yes or no", exitCode: 2 };
      tmux = value;
    } else if (arg === "--skill") {
      if (value !== "none" && value !== "global" && value !== "project") {
        return { kind: "failed", error: `${arg} must be none, global, or project`, exitCode: 2 };
      }
      const mode = value as SkillMode;
      skill = mode;
    }
  }
  return { agents: selectedAgents, modules: selectedModules, skill, tmux, yes, provided };
}

export type DefaultModuleSelection = Readonly<{
  readonly modules: readonly string[];
  readonly skipped: readonly Readonly<{ module: string; reason: string }>[];
  readonly tmuxAvailable: boolean;
  readonly orcaAvailable: boolean;
  readonly supersetAvailable: boolean;
  /** Modules whose own prerequisite is missing here, with what is missing; megabrain cannot install it for them. */
  readonly unavailable: Readonly<Record<string, string>>;
}>;

export async function resolveDefaultModuleSelection(environment: AgentEnvironment, processAdapter: ProcessAdapter): Promise<DefaultModuleSelection> {
  const defaults: string[] = [];
  const skipped: { module: string; reason: string }[] = [];
  const has = async (command: string): Promise<boolean> => (await processAdapter.run("which", [command])).kind === "ok";
  const tmux = await has("tmux");
  const orca = await has("orca");
  const supersetOnPath = await has("superset");
  const homeSuperset = environment.HOME === undefined ? "" : join(environment.HOME, ".superset/bin/superset");
  const superset = supersetOnPath || (homeSuperset.length > 0 && existsSync(homeSuperset));
  if (orca || supersetOnPath || tmux) defaults.push("orchestration");
  else skipped.push({ module: "orchestration", reason: "no orca, superset, or tmux runtime detected" });
  defaults.push("orchestration-hooks");
  if (!tmux) skipped.push({ module: "tmux-runtime", reason: "tmux was not found" });
  if (superset && orca) defaults.push("worktree");
  else if (superset && !orca) skipped.push({ module: "worktree", reason: "orca CLI is not on PATH" });
  const unavailable: Record<string, string> = {};
  if (!(superset && orca)) unavailable.worktree = "needs Orca and Superset";
  if (!await has("adb")) unavailable["tv-adb"] = "needs adb from Android platform-tools";
  const platform = await processAdapter.run("uname", ["-s"]);
  const darwin = platform.kind === "ok" && platform.value.stdout.trim() === "Darwin";
  const xcode = darwin && await has("xcrun");
  if (!xcode) {
    const reason = darwin ? "needs Xcode" : "macOS only";
    unavailable["simulator-native"] = reason;
    unavailable["simulator-tv"] = reason;
    unavailable["simulator-maestro"] = reason;
  }
  return { modules: defaults, skipped, tmuxAvailable: tmux, orcaAvailable: orca, supersetAvailable: superset, unavailable };
}

export async function resolveDefaultModules(environment: AgentEnvironment, processAdapter: ProcessAdapter): Promise<readonly string[]> {
  return (await resolveDefaultModuleSelection(environment, processAdapter)).modules;
}

export async function detectAgents(processAdapter: ProcessAdapter): Promise<readonly MachineAgent[]> {
  const found: MachineAgent[] = [];
  for (const agent of agents) {
    if ((await processAdapter.run("which", [agent])).kind === "ok") found.push(agent);
  }
  return found;
}

export async function listOutput(processAdapter: ProcessAdapter, command: string, args: readonly string[]): Promise<string> {
  const result = await processAdapter.run(command, args);
  return result.kind === "ok" ? result.value.stdout : "";
}

export function hasAgyMegabrainImport(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || !("imports" in value) || !Array.isArray(value.imports)) return false;
    return value.imports.some((entry: unknown) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === "megabrain");
  } catch {
    return false;
  }
}

