import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import packageJson from "../../../package.json" with { type: "json" };
import type { ProcessAdapter } from "../../adapters/proc.js";
import { failed, ok, type Result } from "../../core/result.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { resolveStateDirectory } from "../../core/state.js";
import { discoverAgentDirectories, type AgentEnvironment, type MachineAgent, type MachineAgentDirectories } from "../../core/agent-directories.js";
import { executeTmux } from "./tmux.js";
import { agentLabel, createClackPrompter, moduleLabel, SetupCancelled, type AgentChoice, type MachinePrompter, type ModuleChoice, type SkillMode } from "./install-ui.js";

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
  readonly orcaAvailable: boolean;
  readonly supersetAvailable: boolean;
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
  return { modules: defaults, skipped, tmuxAvailable: tmux, orcaAvailable: orca, supersetAvailable: superset };
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
  confirm: ((message: string) => Promise<boolean>) | undefined,
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
      const shouldRemove = yes || (confirm !== undefined && await confirm(`Remove the old ${agent} megabrain ${artifact}? The skill replaces it.`));
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
  confirm: ((message: string) => Promise<boolean>) | undefined,
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

      const shouldRemove = yes || (confirm !== undefined && await confirm(`Remove the leftover "# megabrain recipes" line from ${path}?`));
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
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  revertTmuxRuntime: () => Promise<Result<string>> = () => executeTmux(["wrapper", "--revert"], environment, processAdapter),
  createPrompter: () => MachinePrompter = createClackPrompter,
): Promise<Result<string>> {
  const parsed = parseMachineInstallArgs(args);
  if ("kind" in parsed) return parsed;
  if (!interactive && !parsed.yes && !parsed.provided) {
    return failed("install setup requires a terminal, --yes, or explicit --agents, --skill, or --modules flags");
  }
  // The rich terminal flow only runs when a person is answering; --yes and scripted flags keep the
  // plain line output below, which tests and automation read.
  const ui = interactive && !parsed.yes ? createPrompter() : undefined;
  try {
    return await installMachine(parsed, environment, processAdapter, installModule, revertTmuxRuntime, ui);
  } catch (error: unknown) {
    // The prompt already told the person it was cancelled; only the exit status is left to report.
    if (error instanceof SetupCancelled) return ok("", 130);
    throw error;
  }
}

async function installMachine(
  parsed: MachineArguments,
  environment: AgentEnvironment & Readonly<{ MEGABRAIN_STATE_DIR?: string }>,
  processAdapter: ProcessAdapter,
  installModule: (module: string) => Promise<Result<string>>,
  revertTmuxRuntime: () => Promise<Result<string>>,
  ui: MachinePrompter | undefined,
): Promise<Result<string>> {
  const defaults = await resolveDefaultModuleSelection(environment, processAdapter);
  const availableAgents = await detectAgents(processAdapter);
  const directories = discoverAgentDirectories(environment);
  const statePath = join(resolveStateDirectory(environment), "state.json");
  const state = readMachineState(statePath);
  if (state === undefined) return failed(`could not read valid megabrain state at ${statePath}`);
  const tmuxState = state["tmux-runtime"];
  const tmuxInstalled = typeof tmuxState === "object" && tmuxState !== null && !Array.isArray(tmuxState) && (tmuxState as Record<string, unknown>).installed === true;

  if (ui !== undefined) {
    const choices: AgentChoice[] = agents.map((agent) => ({
      agent,
      installed: availableAgents.includes(agent),
      configDir: directories[agent] === undefined ? undefined : dirname(dirname(dirname(directories[agent].globalSkill))),
    }));
    ui.intro(packageJson.version, choices, { orca: defaults.orcaAvailable, superset: defaults.supersetAvailable, tmux: defaults.tmuxAvailable });
  }

  const detected = parsed.agents ?? availableAgents;
  // A re-run starts from what this machine chose last time rather than from the detected defaults.
  const last = typeof state.machineInstall === "object" && state.machineInstall !== null && !Array.isArray(state.machineInstall)
    ? state.machineInstall as Record<string, unknown>
    : undefined;
  const lastAgents = Array.isArray(last?.agents) ? (last.agents as unknown[]).filter((agent): agent is MachineAgent => typeof agent === "string" && (agents as readonly string[]).includes(agent)) : undefined;
  const lastSkill = last?.skill === "none" || last?.skill === "global" || last?.skill === "project" ? last.skill : undefined;
  const lastModules = Array.isArray(last?.requestedModules) ? (last.requestedModules as unknown[]).filter((module): module is string => typeof module === "string") : undefined;
  const selectedAgents: readonly MachineAgent[] = parsed.agents ?? (ui === undefined
    ? detected
    : await ui.agents(agents.map((agent) => ({ agent, installed: availableAgents.includes(agent), configDir: directories[agent] === undefined ? undefined : dirname(dirname(dirname(directories[agent].globalSkill))) })), lastAgents ?? availableAgents));
  const skill: SkillMode = parsed.skill ?? (ui !== undefined && selectedAgents.length > 0 ? await ui.skill(lastSkill ?? "global") : ui !== undefined ? "none" : "global");
  const tmux: "yes" | "no" = parsed.tmux ?? (!defaults.tmuxAvailable
    ? "no"
    : ui !== undefined ? await ui.tmux(tmuxInstalled || !Object.hasOwn(state, "machineInstall")) : parsed.yes ? "yes" : "no");
  const selectable = modules.filter((module) => module !== "tmux-runtime");
  let modulesToInstall = [...(parsed.modules ?? (ui === undefined
    ? defaults.modules
    : await ui.modules(selectable.map((module): ModuleChoice => ({
      module,
      selectedByDefault: (lastModules ?? defaults.modules).includes(module),
      skippedReason: defaults.skipped.find((entry) => entry.module === module)?.reason,
    })))))];
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
    delete state["tmux-runtime"];
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
    if (!modulesToInstall.includes("tmux-runtime")) delete state["tmux-runtime"];
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
    writeMachineState(statePath, state, selection, configuredModules);
    const failures: string[] = [];
    for (const module of pendingModules) {
      const step = ui?.step(`Setting up ${moduleLabel(module)}`);
      try {
        const result = await installModule(module);
        if (result.kind !== "ok") {
          const reason = result.kind === "failed" ? result.error : result.reason;
          failures.push(`${module}: ${reason}`);
          step?.fail(`${moduleLabel(module)}: ${reason}`);
          continue;
        }
        configuredModules.push(module);
        step?.done(moduleLabel(module));
        const latestState = readMachineState(statePath);
        if (latestState === undefined) throw new Error(`could not read valid megabrain state at ${statePath}`);
        writeMachineState(statePath, latestState, selection, configuredModules);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : "module installation failed";
        failures.push(`${module}: ${reason}`);
        step?.fail(`${moduleLabel(module)}: ${reason}`);
      }
    }
    if (ui !== undefined) {
      const next = tmux === "yes" ? "Open a new terminal tab so agents start inside tmux." : "Run megabrain doctor any time to check the setup.";
      ui.outro(failures.length === 0 ? `All set. ${next}` : `Finished with ${failures.length} failed module${failures.length === 1 ? "" : "s"}; rerun megabrain install to retry just those.`);
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
