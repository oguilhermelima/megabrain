import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import packageJson from "../../../package.json" with { type: "json" };
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { resolveStateDirectory } from "../../core/state.js";
import { discoverAgentDirectories, type AgentEnvironment, type MachineAgent, type MachineAgentDirectories } from "../../core/agent-directories.js";

export { discoverAgentDirectories } from "../../core/agent-directories.js";

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

function updateInstructionFile(path: string, pointer: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let content = "";
  let mode = 0o600;
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${path}`);
    content = readFileSync(path, "utf8");
    mode = statSync(path).mode;
  }

  const lines = content.split("\n");
  const pointerIndex = lines.findIndex((line) => /^# megabrain recipes(?:\s|$)/.test(line));
  let next: string;
  if (pointerIndex >= 0) {
    let pointerInserted = false;
    const updatedLines: string[] = [];
    for (const line of lines) {
      if (line === pointer || /^# megabrain recipes(?:\s|$)/.test(line)) {
        if (!pointerInserted) updatedLines.push(pointer);
        pointerInserted = true;
      } else {
        updatedLines.push(line);
      }
    }
    next = updatedLines.join("\n");
  } else {
    const separator = content.length === 0 ? "" : content.endsWith("\n") ? "" : "\n";
    next = `${content}${separator}${pointer}\n`;
  }
  if (next === content) return;

  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { mode });
    renameSync(temporary, path);
  } catch (cause: unknown) {
    try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw cause;
  }
}

export function installAgentInstructions(
  agents: readonly MachineAgent[],
  mode: "global" | "project" | "none",
  directories: MachineAgentDirectories,
  projectDirectory: string,
  pointer: string,
): string[] {
  if (mode === "none") return [];
  const targets = mode === "project"
    ? [join(projectDirectory, "AGENTS.md")]
    : agents.map((agent) => {
      const entry = directories[agent];
      if (entry === undefined) throw new Error(`could not resolve ${agent} configuration directory`);
      return entry.globalInstructions;
    });
  for (const target of targets) updateInstructionFile(target, pointer);
  return targets;
}

const agents = ["claude", "codex", "agy"] as const;
const modules = ["orchestration", "orchestration-hooks", "worktree", "simulator-web", "simulator-native", "simulator-tv", "tv-adb", "tmux-runtime"] as const;
type SkillMode = "none" | "global" | "project";
type InstructionMode = SkillMode;
type MachineSelection = Readonly<{
  readonly agents: readonly MachineAgent[];
  readonly skill: SkillMode;
  readonly agentsMd: InstructionMode;
  readonly modules: readonly string[];
  readonly yes: boolean;
  readonly provided: boolean;
}>;
type MachineArguments = Omit<MachineSelection, "agents" | "modules" | "skill" | "agentsMd" | "provided"> & Readonly<{
  readonly agents?: readonly MachineAgent[];
  readonly modules?: readonly string[];
  readonly skill?: SkillMode;
  readonly agentsMd?: InstructionMode;
  readonly provided: boolean;
}>;
type ParseFailure = Readonly<{ kind: "failed"; error: string; exitCode: 2 }>;

function csv(value: string): string[] {
  return value.split(",").map((token) => token.trim()).filter((token) => token.length > 0);
}

function parseAgents(value: string): readonly MachineAgent[] | ParseFailure {
  const requested = csv(value);
  if (requested.length === 1 && requested[0] === "none") return [];
  if (requested.length === 0 || requested.some((agent) => !(agents as readonly string[]).includes(agent)) || requested.includes("none")) {
    return { kind: "failed", error: "--agents requires claude,codex,agy or none", exitCode: 2 };
  }
  return [...new Set(requested)] as MachineAgent[];
}

function parseModules(value: string): readonly string[] | ParseFailure {
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
  let agentsMd: InstructionMode | undefined;
  let yes = false;
  let provided = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") { yes = true; continue; }
    if (arg !== "--agents" && arg !== "--skill" && arg !== "--agents-md" && arg !== "--modules") {
      return { kind: "failed", error: `unknown install option: ${arg}`, exitCode: 2 };
    }
    if (seen.has(arg)) return { kind: "failed", error: `${arg} may only be specified once`, exitCode: 2 };
    seen.add(arg);
    provided = true;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) return { kind: "failed", error: `${arg} requires a value`, exitCode: 2 };
    index += 1;
    if (arg === "--agents") {
      const parsed = parseAgents(value);
      if ("kind" in parsed) return parsed;
      selectedAgents = parsed as readonly MachineAgent[];
    } else if (arg === "--modules") {
      const parsed = parseModules(value);
      if ("kind" in parsed) return parsed;
      selectedModules = parsed as readonly string[];
    } else if (arg === "--skill" || arg === "--agents-md") {
      if (value !== "none" && value !== "global" && value !== "project") {
        return { kind: "failed", error: `${arg} must be none, global, or project`, exitCode: 2 };
      }
      const mode = value as SkillMode;
      if (arg === "--skill") skill = mode;
      else agentsMd = mode;
    }
  }
  return { agents: selectedAgents, modules: selectedModules, skill, agentsMd, yes, provided };
}

export async function resolveDefaultModules(environment: AgentEnvironment, processAdapter: ProcessAdapter): Promise<readonly string[]> {
  const defaults = ["orchestration", "orchestration-hooks"];
  const has = async (command: string): Promise<boolean> => (await processAdapter.run("which", [command])).kind === "ok";
  if (await has("tmux")) defaults.unshift("tmux-runtime");
  const homeSuperset = environment.HOME === undefined ? "" : join(environment.HOME, ".superset/bin/superset");
  if (await has("superset") || (homeSuperset.length > 0 && existsSync(homeSuperset))) defaults.push("worktree");
  return defaults;
}

async function detectAgents(processAdapter: ProcessAdapter): Promise<readonly MachineAgent[]> {
  const found: MachineAgent[] = [];
  for (const agent of agents) {
    if ((await processAdapter.run("which", [agent])).kind === "ok") found.push(agent);
  }
  return found;
}

async function listOutput(processAdapter: ProcessAdapter, command: string, args: readonly string[]): Promise<string> {
  const result = await processAdapter.run(command, args);
  return result.kind === "ok" ? result.value.stdout : "";
}

function hasAgyMegabrainImport(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    if (typeof value !== "object" || value === null || !("imports" in value) || !Array.isArray(value.imports)) return false;
    return value.imports.some((entry: unknown) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === "megabrain");
  } catch {
    return false;
  }
}

export async function retireLegacyChannels(
  availableAgents: readonly MachineAgent[],
  processAdapter: ProcessAdapter,
  yes: boolean,
  interactive: boolean,
): Promise<Result<string>> {
  const messages: string[] = [];
  for (const agent of availableAgents) {
    const pluginOutput = await listOutput(processAdapter, agent, agent === "agy" ? ["plugin", "list"] : ["plugin", "list"]);
    const marketplaceOutput = agent === "agy" ? "" : await listOutput(processAdapter, agent, ["plugin", "marketplace", "list"]);
    const pluginFound = agent === "agy"
      ? hasAgyMegabrainImport(pluginOutput)
      : /megabrain(?:@megabrain-local|\s+installed\b)/i.test(pluginOutput);
    const marketplaceFound = /megabrain-local/i.test(marketplaceOutput);
    for (const [artifact, found] of [["plugin", pluginFound], ["marketplace", marketplaceFound]] as const) {
      if (!found) continue;
      const shouldRemove = yes || (interactive && await ask(`Remove the legacy ${agent} megabrain ${artifact}?`, ["no", "yes"], "no") === "yes");
      if (!shouldRemove) {
        messages.push(`${agent} ${artifact} retained; rerun with --yes to remove it`);
        continue;
      }
      const args = artifact === "marketplace"
        ? ["plugin", "marketplace", "remove", "megabrain-local"]
        : agent === "claude"
          ? ["plugin", "uninstall", "megabrain@megabrain-local"]
          : agent === "codex"
            ? ["plugin", "remove", "megabrain@megabrain-local"]
            : ["plugin", "uninstall", "megabrain"];
      const removal = await processAdapter.run(agent, args);
      if (removal.kind !== "ok") return failed(`could not remove ${agent} megabrain ${artifact}: ${removal.error}`);
      messages.push(`${agent} ${artifact} removed`);
    }
  }
  return ok(messages.length === 0 ? "no legacy plugin registrations found\n" : `${messages.join("\n")}\n`);
}

async function ask(label: string, options: readonly string[], defaultValue: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${label}\n`);
    options.forEach((option, index) => process.stdout.write(`  ${index + 1}) ${option}${option === defaultValue ? " (default)" : ""}\n`));
    const response = (await reader.question(`Selection [${options.indexOf(defaultValue) + 1}]: `)).trim();
    if (response.length === 0) return defaultValue;
    const index = Number(response);
    if (!Number.isInteger(index) || index < 1 || index > options.length) throw new Error(`invalid selection for ${label}`);
    return options[index - 1] ?? defaultValue;
  } finally {
    reader.close();
  }
}

async function askMany(label: string, options: readonly string[], defaults: readonly string[]): Promise<string[]> {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${label}\n`);
    options.forEach((option, index) => process.stdout.write(`  ${index + 1}) ${option}\n`));
    const defaultNumbers = defaults.map((value) => String(options.indexOf(value) + 1)).join(",");
    const response = (await reader.question(`Numbers separated by commas, or none [${defaultNumbers || "none"}]: `)).trim();
    if (response.length === 0) return [...defaults];
    if (response === "none") return [];
    if (response === "all") return [...options];
    const selected: string[] = [];
    for (const token of response.split(",").map((part) => part.trim())) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 1 || index > options.length) throw new Error(`invalid selection for ${label}`);
      const option = options[index - 1];
      if (option !== undefined && !selected.includes(option)) selected.push(option);
    }
    return selected;
  } finally {
    reader.close();
  }
}

function readMachineState(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

type PersistedMachineSelection = Readonly<{
  readonly agents: readonly MachineAgent[];
  readonly skill: SkillMode;
  readonly agentsMd: InstructionMode;
  readonly modules: readonly string[];
  readonly version: string;
}>;

function sameSelection(left: unknown, right: PersistedMachineSelection): boolean {
  return typeof left === "object" && left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function writeMachineState(path: string, state: Record<string, unknown>, selection: MachineSelection): void {
  const next = { ...state, machineInstall: { agents: selection.agents, skill: selection.skill, agentsMd: selection.agentsMd, modules: selection.modules, version: packageJson.version } };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (cause: unknown) {
    try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw cause;
  }
}

export async function runMachineInstall(
  args: readonly string[],
  environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>,
  processAdapter: ProcessAdapter,
  installModule: (module: string) => Promise<Result<string>>,
  interactive = Boolean(process.stdin.isTTY),
): Promise<Result<string>> {
  const parsed = parseMachineInstallArgs(args);
  if ("kind" in parsed) return parsed;
  if (!interactive && !parsed.yes && !parsed.provided) {
    return failed("install setup requires a terminal, --yes, or explicit --agents, --skill, --agents-md, or --modules flags");
  }

  const defaults = await resolveDefaultModules(environment, processAdapter);
  const availableAgents = await detectAgents(processAdapter);
  const detected = parsed.agents ?? availableAgents;
  const selectedAgents = parsed.agents ?? (interactive && !parsed.yes ? await askMany("Select agents", detected, detected) as MachineAgent[] : detected);
  const skill: SkillMode = parsed.skill ?? (interactive && !parsed.yes ? await ask("Install the skill?", ["none", "global", "project"], "global") as SkillMode : "global");
  const agentsMd: InstructionMode = parsed.agentsMd ?? (interactive && !parsed.yes ? await ask("Add the instructions pointer?", ["none", "global", "project"], "global") as InstructionMode : "global");
  const modulesToInstall = parsed.modules ?? (interactive && !parsed.yes ? await askMany("Select modules", modules, defaults) : defaults);
  const selection: MachineSelection = { agents: selectedAgents, skill, agentsMd, modules: modulesToInstall, yes: parsed.yes, provided: parsed.provided };
  const statePath = join(resolveStateDirectory(environment), "state.json");
  const state = readMachineState(statePath);
  if (state === undefined) return failed(`could not read valid megabrain state at ${statePath}`);
  const recordedSelection = { agents: selectedAgents, skill, agentsMd, modules: modulesToInstall, version: packageJson.version };
  if (sameSelection(state.machineInstall, recordedSelection)) return ok("machine configuration already current; no changes made\n");

  try {
    if (!modulesToInstall.includes("tmux-runtime")) delete state["tmux-runtime"];
    const retired = await retireLegacyChannels(availableAgents, processAdapter, parsed.yes, interactive);
    if (retired.kind !== "ok") return retired;
    const directories = discoverAgentDirectories(environment);
    const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
    if (skill !== "none") {
      const installed = installAgentSkills(join(root, "skills/megabrain/SKILL.md"), selectedAgents, skill, directories, process.cwd());
      for (const path of installed) process.stdout.write(`skill installed at ${path}\n`);
    }
    if (agentsMd !== "none") {
      const pointer = "# megabrain recipes";
      const installed = installAgentInstructions(selectedAgents, agentsMd, directories, process.cwd(), pointer);
      for (const path of installed) process.stdout.write(`instructions updated at ${path}\n`);
    }
    for (const module of modulesToInstall) {
      const result = await installModule(module);
      if (result.kind !== "ok") return failed(`could not install megabrain module ${module}: ${result.error}`);
    }
    writeMachineState(statePath, state, selection);
    return ok(`${retired.value}machine configuration installed for agents ${selectedAgents.join(",") || "none"}; modules ${modulesToInstall.join(",") || "none"}\n`);
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : "machine configuration failed");
  }
}
