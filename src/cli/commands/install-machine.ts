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
import { executeTmux } from "./tmux.js";

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

const agents = ["claude", "codex", "agy"] as const;
const modules = ["orchestration", "orchestration-hooks", "worktree", "simulator-web", "simulator-native", "simulator-tv", "tv-adb", "tmux-runtime"] as const;
type SkillMode = "none" | "global" | "project";
type MachineSelection = Readonly<{
  readonly agents: readonly MachineAgent[];
  readonly skill: SkillMode;
  readonly tmux: "yes" | "no";
  readonly modules: readonly string[];
  readonly yes: boolean;
  readonly provided: boolean;
}>;
type MachineArguments = Omit<MachineSelection, "agents" | "modules" | "skill" | "tmux" | "provided"> & Readonly<{
  readonly agents?: readonly MachineAgent[];
  readonly modules?: readonly string[];
  readonly skill?: SkillMode;
  readonly tmux?: "yes" | "no";
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
  let tmux: "yes" | "no" | undefined;
  let yes = false;
  let provided = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") { yes = true; continue; }
    if (arg !== "--agents" && arg !== "--skill" && arg !== "--modules" && arg !== "--tmux") {
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

type DefaultModuleSelection = Readonly<{
  readonly modules: readonly string[];
  readonly skipped: readonly Readonly<{ module: string; reason: string }>[];
  readonly tmuxAvailable: boolean;
}>;

async function resolveDefaultModuleSelection(environment: AgentEnvironment, processAdapter: ProcessAdapter): Promise<DefaultModuleSelection> {
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
  return { modules: defaults, skipped, tmuxAvailable: tmux };
}

export async function resolveDefaultModules(environment: AgentEnvironment, processAdapter: ProcessAdapter): Promise<readonly string[]> {
  return (await resolveDefaultModuleSelection(environment, processAdapter)).modules;
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

const legacyInstructionsHeading = "# megabrain recipes";

function instructionLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function lineContent(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function removeLegacyInstructionsHeading(path: string): "missing" | "absent" | "followed" | "removed" {
  if (!existsSync(path)) return "missing";
  if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing to replace symbolic link: ${path}`);

  const content = readFileSync(path, "utf8");
  const lines = instructionLines(content);
  const headingIndex = lines.findIndex((line) => lineContent(line) === legacyInstructionsHeading);
  if (headingIndex < 0) return "absent";
  const trailingLines = lines.slice(headingIndex + 1);
  if (trailingLines.some((line) => lineContent(line).trim().length > 0)) return "followed";

  const removeBlankLine = trailingLines.length > 0 && lineContent(trailingLines[0] ?? "").trim().length === 0 ? 1 : 0;
  const next = removeBlankLine === 1
    ? [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 2)].join("")
    : [...lines.slice(0, headingIndex), ...lines.slice(headingIndex + 1)].join("");
  if (next === content) return "absent";

  const mode = statSync(path).mode;
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, next, { mode });
    renameSync(temporary, path);
  } catch (cause: unknown) {
    try { unlinkSync(temporary); } catch { /* preserve the original failure */ }
    throw cause;
  }
  return "removed";
}

export async function retireLegacyInstructions(
  environment: AgentEnvironment,
  projectDirectory: string,
  yes: boolean,
  interactive: boolean,
): Promise<Result<string>> {
  const home = environment.HOME;
  const targets = [
    ...(home === undefined || home.length === 0 ? [] : [join(home, ".codex", "AGENTS.md"), join(home, ".agy", "AGENTS.md")]),
    join(projectDirectory, "AGENTS.md"),
  ];
  const messages: string[] = [];
  try {
    for (const path of targets) {
      if (!existsSync(path)) continue;
      if (lstatSync(path).isSymbolicLink()) return failed(`refusing to replace symbolic link: ${path}`);
      const content = readFileSync(path, "utf8");
      if (!instructionLines(content).some((line) => lineContent(line) === legacyInstructionsHeading)) continue;

      const lines = instructionLines(content);
      const headingIndex = lines.findIndex((line) => lineContent(line) === legacyInstructionsHeading);
      const hasFollowingContent = lines.slice(headingIndex + 1).some((line) => lineContent(line).trim().length > 0);
      if (hasFollowingContent) {
        messages.push(`${path}: retained; content follows the heading`);
        continue;
      }

      const shouldRemove = yes || (interactive && await ask(`Remove the legacy instructions heading from ${path}?`, ["no", "yes"], "no") === "yes");
      if (!shouldRemove) {
        messages.push(`${path}: legacy heading found; rerun with --yes to remove it`);
        continue;
      }
      const result = removeLegacyInstructionsHeading(path);
      if (result === "removed") messages.push(`${path}: legacy instructions heading removed`);
      else if (result === "followed") messages.push(`${path}: retained; content follows the heading`);
    }
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : "could not retire legacy instructions heading");
  }
  return ok(messages.length === 0 ? "" : `${messages.join("\n")}\n`);
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
  readonly tmux: "yes" | "no";
  /** Modules requested for this machine install. */
  readonly requestedModules: readonly string[];
  /** Modules that completed successfully, in request order. */
  readonly modules: readonly string[];
  readonly version: string;
}>;

function matchingMachineInstall(left: unknown, right: PersistedMachineSelection): PersistedMachineSelection | undefined {
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

function writeMachineState(path: string, state: Record<string, unknown>, selection: MachineSelection, configuredModules: readonly string[]): void {
  const next = { ...state, machineInstall: { agents: selection.agents, skill: selection.skill, tmux: selection.tmux, requestedModules: selection.modules, modules: configuredModules, version: packageJson.version } };
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
  revertTmuxRuntime: () => Promise<Result<string>> = () => executeTmux(["wrapper", "--revert"], environment, processAdapter),
): Promise<Result<string>> {
  const parsed = parseMachineInstallArgs(args);
  if ("kind" in parsed) return parsed;
  if (!interactive && !parsed.yes && !parsed.provided) {
    return failed("install setup requires a terminal, --yes, or explicit --agents, --skill, or --modules flags");
  }

  const defaults = await resolveDefaultModuleSelection(environment, processAdapter);
  const availableAgents = await detectAgents(processAdapter);
  const detected = parsed.agents ?? availableAgents;
  const selectedAgents = parsed.agents ?? (interactive && !parsed.yes ? await askMany("Select agents", detected, detected) as MachineAgent[] : detected);
  const skill: SkillMode = parsed.skill ?? (interactive && !parsed.yes ? await ask("Install the skill?", ["none", "global", "project"], "global") as SkillMode : "global");
  const tmux = parsed.tmux ?? (defaults.tmuxAvailable && interactive && !parsed.yes
    ? await ask("Run agents inside tmux, splitting the screen?", ["no", "yes"], "yes") as "yes" | "no"
    : defaults.tmuxAvailable && parsed.yes ? "yes" : "no");
  let modulesToInstall = [...(parsed.modules ?? (interactive && !parsed.yes ? await askMany("Select modules", modules, defaults.modules) : defaults.modules))];
  if (tmux === "yes" && !modulesToInstall.includes("tmux-runtime")) modulesToInstall.unshift("tmux-runtime");
  if (tmux === "no") modulesToInstall = modulesToInstall.filter((module) => module !== "tmux-runtime");
  const defaultSkips = [
    ...(parsed.modules === undefined ? defaults.skipped.filter(({ module }) => module !== "tmux-runtime" && !modulesToInstall.includes(module)) : []),
    ...(!defaults.tmuxAvailable && tmux === "no" ? [{ module: "tmux-runtime", reason: "tmux was not found" }] : []),
  ].map(({ module, reason }) => `${module} skipped: ${reason}`);
  const selection: MachineSelection = { agents: selectedAgents, skill, tmux, modules: modulesToInstall, yes: parsed.yes, provided: parsed.provided };
  const statePath = join(resolveStateDirectory(environment), "state.json");
  const state = readMachineState(statePath);
  if (state === undefined) return failed(`could not read valid megabrain state at ${statePath}`);
  const tmuxState = state["tmux-runtime"];
  const tmuxInstalled = typeof tmuxState === "object" && tmuxState !== null && !Array.isArray(tmuxState) && (tmuxState as Record<string, unknown>).installed === true;
  let tmuxReverted = false;
  if (tmux === "no" && tmuxInstalled) {
    const shouldRevert = parsed.yes || (interactive && await ask("Revert the tmux runtime and remove its agent wrapper?", ["no", "yes"], "yes") === "yes");
    if (!shouldRevert) return ok("tmux runtime retained; rerun with --yes to remove it\n");
    const reverted = await revertTmuxRuntime();
    if (reverted.kind !== "ok") return failed(`tmux runtime revert failed: ${reverted.kind === "failed" ? reverted.error : reverted.reason}`);
    delete state["tmux-runtime"];
    tmuxReverted = true;
  }
  const recordedSelection: PersistedMachineSelection = { agents: selectedAgents, skill, tmux, requestedModules: modulesToInstall, modules: modulesToInstall, version: packageJson.version };
  const previous = matchingMachineInstall(state.machineInstall, recordedSelection);
  const legacyInstructions = await retireLegacyInstructions(environment, process.cwd(), parsed.yes, interactive);
  if (legacyInstructions.kind !== "ok") return legacyInstructions;
  const configuredModules = [...(previous?.modules ?? [])];
  const pendingModules = modulesToInstall.filter((module) => !configuredModules.includes(module));
  const skillsConfigured = previous !== undefined;
  if (skillsConfigured && pendingModules.length === 0) {
    const summary = `machine install summary: configured ${configuredModules.join(", ") || "none"}; failed none\n`;
    return ok(`${legacyInstructions.value}${tmuxReverted ? "tmux runtime reverted\n" : ""}${defaultSkips.length > 0 ? `${defaultSkips.join("\n")}\n` : ""}machine configuration already current; no changes made\n${summary}`);
  }

  try {
    if (!modulesToInstall.includes("tmux-runtime")) delete state["tmux-runtime"];
    const retired = await retireLegacyChannels(availableAgents, processAdapter, parsed.yes, interactive);
    if (retired.kind !== "ok") return retired;
    const directories = discoverAgentDirectories(environment);
    const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
    if (!skillsConfigured && skill !== "none") {
      const installed = installAgentSkills(join(root, "skills/megabrain/SKILL.md"), selectedAgents, skill, directories, process.cwd());
      for (const path of installed) process.stdout.write(`skill installed at ${path}\n`);
    }
    // Record the selected skill configuration before attempting modules so a failed module does
    // not make a later run rewrite the skill files that already succeeded.
    writeMachineState(statePath, state, selection, configuredModules);
    const failures: string[] = [];
    for (const module of pendingModules) {
      try {
        const result = await installModule(module);
        if (result.kind !== "ok") {
          failures.push(`${module}: ${result.kind === "failed" ? result.error : result.reason}`);
          continue;
        }
        configuredModules.push(module);
        const latestState = readMachineState(statePath);
        if (latestState === undefined) throw new Error(`could not read valid megabrain state at ${statePath}`);
        writeMachineState(statePath, latestState, selection, configuredModules);
      } catch (error: unknown) {
        failures.push(`${module}: ${error instanceof Error ? error.message : "module installation failed"}`);
      }
    }
    const summary = `machine install summary: configured ${configuredModules.join(", ") || "none"}; failed ${failures.map((failure) => failure.split(":", 1)[0]).join(", ") || "none"}\n`;
    const skipped = defaultSkips.length > 0 ? `${defaultSkips.join("\n")}\n` : "";
    if (failures.length > 0) return failed(`${legacyInstructions.value}${retired.value}${tmuxReverted ? "tmux runtime reverted\n" : ""}${skipped}${failures.join("\n")}\n${summary}`);
    return ok(`${legacyInstructions.value}${retired.value}${tmuxReverted ? "tmux runtime reverted\n" : ""}${skipped}machine configuration installed for agents ${selectedAgents.join(",") || "none"}; modules ${configuredModules.join(", ") || "none"}\n${summary}`);
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : "machine configuration failed");
  }
}
