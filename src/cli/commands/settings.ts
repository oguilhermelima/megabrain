import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readProjectAppearance, setProjectAppearance, type AppearancePatch } from "../../core/project-appearance.js";
import { writePrivateJson } from "../../core/private-json.js";
import { readAdmissionPolicy, resourceHistoryEnabled, readOnlyStateDatabase } from "../../adapters/state-db.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { detectTerminal, OPENERS, type Platform } from "../../core/terminal-openers.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { staleChainSteps, suggestModel, type ChainConfig } from "../../core/chain.js";
import { modelRegistry, readConfig, readLimitRows, validateConfig } from "./chain.js";
import { storedDefault } from "./terminal-open.js";
import { supervisorWatcher } from "./supervise.js";
import { defaultWorktreeLocation, parseWorktreeLocation } from "../../core/worktree-location.js";
import { defaultIdleSetting, parseIdleSetting } from "../../core/native-idle.js";
import { defaultSummarySettings, parseSummarySettings } from "../../chat/summaries.js";
import { defaultKnowledgeSettings, parseKnowledgeSettings, readKnowledgeSettings } from "../../knowledge/settings.js";
import { emptyModelSettings, modelEnabled, modelSettingsFile, parseModelSettings, type ModelSettings } from "../../core/model-settings.js";
import { agentUpdateStatus, readAgentAutoUpdateSettings, writeAgentAutoUpdateSettings } from "../../core/agent-update.js";
import { loadAndPersistModelRegistry } from "../../core/model.js";

type Environment = Readonly<Record<string, string | undefined>>;

function platform(): Platform {
  return process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
}

function terminalEngineFile(environment: Environment): string {
  return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"), "terminal-settings.json");
}

async function readTerminalEngine(environment: Environment): Promise<"native" | "tmux"> {
  try {
    const value = JSON.parse(await readFile(terminalEngineFile(environment), "utf8")) as { terminalEngine?: unknown };
    return value.terminalEngine === "tmux" ? "tmux" : "native";
  } catch { return "native"; }
}

async function writeTerminalEngine(environment: Environment, engine: "native" | "tmux"): Promise<void> {
  const file = terminalEngineFile(environment);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ terminalEngine: engine })}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

// The desktop sidebar's folders: user-made groups of projects, and the top-level order that mixes
// folder ids with project paths. The app reconciles stale paths itself; this only checks the shape.
type SidebarFolders = {
  version: 1;
  folders: Array<{ id: string; name: string; collapsed: boolean; projects: string[] }>;
  order: string[];
};

const emptySidebarFolders: SidebarFolders = { version: 1, folders: [], order: [] };

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const hasOnlyKeys = (value: object, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

function parseSidebarFolders(raw: string): Result<SidebarFolders> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("sidebar-folders: not valid JSON", 2); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return failed("sidebar-folders: expected an object", 2);
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, ["version", "folders", "order"]) || record.version !== 1) return failed("sidebar-folders: expected { version: 1, folders, order }", 2);
  if (!Array.isArray(record.folders)) return failed("sidebar-folders: folders must be a list", 2);
  if (!isStringList(record.order)) return failed("sidebar-folders: order must be a list of folder ids and project paths", 2);
  const ids = new Set<string>();
  const folders: SidebarFolders["folders"] = [];
  for (const folder of record.folders as unknown[]) {
    if (typeof folder !== "object" || folder === null || Array.isArray(folder)) return failed("sidebar-folders: each folder must be an object", 2);
    const entry = folder as Record<string, unknown>;
    if (!hasOnlyKeys(entry, ["id", "name", "collapsed", "projects"])) return failed("sidebar-folders: a folder has only id, name, collapsed and projects", 2);
    const { id, name, collapsed, projects } = entry;
    if (typeof id !== "string" || id === "" || id.startsWith("/")) return failed("sidebar-folders: a folder id must be a non-empty string that is not a path", 2);
    if (ids.has(id)) return failed(`sidebar-folders: duplicate folder id ${id}`, 2);
    if (typeof name !== "string" || name.trim() === "" || name.length > 200) return failed("sidebar-folders: a folder name must be 1 to 200 characters", 2);
    if (typeof collapsed !== "boolean") return failed("sidebar-folders: collapsed must be true or false", 2);
    if (!isStringList(projects)) return failed("sidebar-folders: a folder's projects must be a list of paths", 2);
    ids.add(id);
    folders.push({ id, name, collapsed, projects });
  }
  return ok({ version: 1, folders, order: record.order });
}

// More desktop files with the same contract as the folders: the app owns the meaning, the CLI
// checks the shape and writes it privately. Shortcut overrides map an action id to its keys; hidden
// sessions map a session id to its last activity when the sidebar closed it; the sidebar state holds
// the keys of what the sidebar folded and each worktree's row order.
type ShortcutOverrides = { version: 1; bindings: Record<string, string[]> };
type HiddenSessions = { version: 1; sessions: Record<string, string | null> };
type SidebarState = { version: 1; collapsed: string[]; rows: Record<string, string[]> };

const emptyShortcutOverrides: ShortcutOverrides = { version: 1, bindings: {} };
const emptyHiddenSessions: HiddenSessions = { version: 1, sessions: {} };
const emptySidebarState: SidebarState = { version: 1, collapsed: [], rows: {} };

function desktopFile(environment: Environment, name: string): string {
  return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"), name);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseShortcutOverrides(raw: string): Result<ShortcutOverrides> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("shortcuts: not valid JSON", 2); }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "bindings"]) || value.version !== 1 || !isRecord(value.bindings)) return failed("shortcuts: expected { version: 1, bindings }", 2);
  const bindings: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(value.bindings)) {
    if (!isStringList(keys)) return failed(`shortcuts: the keys of ${id} must be a list of strings`, 2);
    bindings[id] = keys;
  }
  return ok({ version: 1, bindings });
}

function parseHiddenSessions(raw: string): Result<HiddenSessions> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("hidden-sessions: not valid JSON", 2); }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "sessions"]) || value.version !== 1 || !isRecord(value.sessions)) return failed("hidden-sessions: expected { version: 1, sessions }", 2);
  const sessions: Record<string, string | null> = {};
  for (const [id, at] of Object.entries(value.sessions)) {
    if (typeof at !== "string" && at !== null) return failed(`hidden-sessions: the last activity of ${id} must be a string or null`, 2);
    sessions[id] = at;
  }
  return ok({ version: 1, sessions });
}

function parseSidebarState(raw: string): Result<SidebarState> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("sidebar-state: not valid JSON", 2); }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "collapsed", "rows"]) || value.version !== 1 || !isRecord(value.rows)) return failed("sidebar-state: expected { version: 1, collapsed, rows }", 2);
  if (!isStringList(value.collapsed)) return failed("sidebar-state: collapsed must be a list of strings", 2);
  const rows: Record<string, string[]> = {};
  for (const [path, keys] of Object.entries(value.rows)) {
    if (!isStringList(keys)) return failed(`sidebar-state: the rows of ${path} must be a list of strings`, 2);
    rows[path] = keys;
  }
  return ok({ version: 1, collapsed: value.collapsed, rows });
}

type UsageOrder = { version: 1; order: string[]; hidden: string[] };
const emptyUsageOrder: UsageOrder = { version: 1, order: [], hidden: [] };

function parseUsageOrder(raw: string): Result<UsageOrder> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("usage-order: not valid JSON", 2); }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "order", "hidden"]) || value.version !== 1) return failed("usage-order: expected { version: 1, order, hidden }", 2);
  if (!isStringList(value.order) || !isStringList(value.hidden)) return failed("usage-order: order and hidden must be lists of strings", 2);
  return ok({ version: 1, order: value.order, hidden: value.hidden });
}

// The desktop app's agents: the one New chat starts with (null: the one used last) and the ones
// turned off for the app.
const DESKTOP_AGENTS = ["claude", "codex", "grok", "agy"];
type AgentSettings = { version: 1; default: string | null; disabled: string[] };
const emptyAgentSettings: AgentSettings = { version: 1, default: null, disabled: [] };

function parseAgentSettings(raw: string): Result<AgentSettings> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("agents: not valid JSON", 2); }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "default", "disabled"]) || value.version !== 1 || !("default" in value)) return failed("agents: expected { version: 1, default, disabled }", 2);
  if (!isStringList(value.disabled)) return failed("agents: disabled must be a list of agents", 2);
  const unknown = [value.default, ...value.disabled].find((agent) => agent !== null && !DESKTOP_AGENTS.includes(agent as string));
  if (unknown !== undefined) return failed(`agents: unknown agent ${String(unknown)} (expected ${DESKTOP_AGENTS.join(", ")})`, 2);
  if (typeof value.default === "string" && value.disabled.includes(value.default)) return failed(`agents: the default ${value.default} is turned off`, 2);
  return ok({ version: 1, default: value.default as string | null, disabled: [...new Set(value.disabled)] });
}

interface DesktopFile {
  file: string;
  empty: object;
  /** The checked value and the line `set` prints, or why it was refused. */
  parse: (raw: string) => Result<{ value: object; saved: string }>;
}

function desktopFileOf<T extends object>(file: string, parse: (raw: string) => Result<T>, empty: T, saved: (value: T) => string): DesktopFile {
  return {
    file,
    empty,
    parse: (raw) => {
      const parsed = parse(raw);
      return parsed.kind === "ok" ? ok({ value: parsed.value, saved: saved(parsed.value) }) : parsed;
    },
  };
}

/** The desktop files `settings get|set <name>` reads and replaces whole. */
const desktopSettings = {
  "sidebar-folders": desktopFileOf("sidebar-settings.json", parseSidebarFolders, emptySidebarFolders, (value) => `sidebar folders: ${value.folders.length}`),
  "shortcuts": desktopFileOf("shortcut-settings.json", parseShortcutOverrides, emptyShortcutOverrides, (value) => `shortcut overrides: ${Object.keys(value.bindings).length}`),
  "hidden-sessions": desktopFileOf("hidden-sessions.json", parseHiddenSessions, emptyHiddenSessions, (value) => `hidden sessions: ${Object.keys(value.sessions).length}`),
  "sidebar-state": desktopFileOf("sidebar-state.json", parseSidebarState, emptySidebarState, (value) => `sidebar state: ${value.collapsed.length} collapsed, ${Object.keys(value.rows).length} ordered worktrees`),
  "chat-summaries": desktopFileOf("chat-summaries.json", parseSummarySettings, defaultSummarySettings, (value) => `chat summaries: ${value.enabled ? `on, ${value.agent} ${value.model}` : "off"}`),
  "knowledge": desktopFileOf("knowledge-settings.json", parseKnowledgeSettings, defaultKnowledgeSettings, (value) => `knowledge: ${Object.keys(value.projects).length} project overrides`),
  "worktree-location": desktopFileOf("worktree-location.json", parseWorktreeLocation, defaultWorktreeLocation, (value) => `worktree location: ${value.mode}${value.layout === "nested" ? " (by project)" : ""}, ${Object.keys(value.projects).length} project overrides`),
  "usage-order": desktopFileOf("usage-order.json", parseUsageOrder, emptyUsageOrder, (value) => `usage order: ${value.order.length} ordered, ${value.hidden.length} hidden`),
  "device-idle-minutes": desktopFileOf("device-idle.json", parseIdleSetting, defaultIdleSetting, (value) => `device idle: ${value.minutes === 0 ? "never sleeps" : `${value.minutes} min`}`),
  "agents": desktopFileOf("agent-settings.json", parseAgentSettings, emptyAgentSettings, (value) => `agents: default ${value.default ?? "auto"}, ${value.disabled.length} disabled`),
  "models": desktopFileOf(modelSettingsFile, parseModelSettings, emptyModelSettings, (value) => `models: ${Object.keys(value.models).length} toggled, ${Object.keys(value.defaults).length} agent default${Object.keys(value.defaults).length === 1 ? "" : "s"}`),
} as const;

type DesktopSetting = keyof typeof desktopSettings;
const isDesktopSetting = (name: string | undefined): name is DesktopSetting => name !== undefined && Object.hasOwn(desktopSettings, name);

async function readDesktopSetting(environment: Environment, name: DesktopSetting): Promise<object> {
  if (name === "knowledge") return readKnowledgeSettings(dirname(desktopFile(environment, "knowledge-settings.json")));
  const setting = desktopSettings[name];
  try {
    const parsed = setting.parse(await readFile(desktopFile(environment, setting.file), "utf8"));
    return parsed.kind === "ok" ? parsed.value.value : setting.empty;
  } catch { return setting.empty; }
}

async function writeDesktopSetting(environment: Environment, name: DesktopSetting, raw: string): Promise<Result<string>> {
  const setting = desktopSettings[name];
  const parsed = setting.parse(raw);
  if (parsed.kind !== "ok") return parsed;
  await writePrivateJson(desktopFile(environment, setting.file), parsed.value.value);
  return ok(`${parsed.value.saved}\n`);
}

const APPEARANCE_USAGE = "Usage: megabrain settings set project-appearance <repo path> [--name <text>|--no-name] [--color <#rrggbb>|--no-color] [--picture <image file>|--no-picture] [--json]";

function parseAppearancePatch(args: readonly string[]): Result<AppearancePatch> {
  const patch: AppearancePatch = {};
  const fields = { "--name": "name", "--color": "color", "--picture": "picture" } as const;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--json") continue;
    const set = fields[arg as keyof typeof fields];
    const clear = arg.startsWith("--no-") ? fields[`--${arg.slice(5)}` as keyof typeof fields] : undefined;
    const field = set ?? clear;
    if (field === undefined) return failed(`project-appearance: unknown option ${arg}`, 2);
    if (patch[field] !== undefined) return failed(`project-appearance: ${field} is given more than once`, 2);
    if (clear !== undefined) { patch[clear] = null; continue; }
    const value = args[index + 1];
    if (value === undefined) return failed(`project-appearance: ${arg} needs a value`, 2);
    patch[field] = value;
    index += 1;
  }
  return Object.keys(patch).length === 0 ? failed(APPEARANCE_USAGE, 2) : ok(patch);
}
function summary(value: SettingsValue): string {
  const providers = value.limits.enabledProviders.length === 0 ? "none" : value.limits.enabledProviders.join(", ");
  return [
    `supervisor: ${value.supervisor.running ? `running (pid ${value.supervisor.pid ?? "unknown"})` : "stopped"}`,
    `resource history: ${value.resources.historyEnabled ? "enabled" : "disabled"}`,
    `resource policy: ${value.resources.policy === null ? "off" : "configured"}`,
    `usage notices: ${value.limits.notice.enabled ? `enabled (every ${value.limits.notice.intervalSeconds}s)` : "disabled"}`,
    `live usage providers: ${providers}`,
    `chains: ${value.chains.length}; models: ${value.models.length}`,
    `terminal default: ${value.terminal.default ?? "unset"}; detected: ${value.terminal.detected ?? "none"}`,
    `terminal engine: ${value.terminalEngine}`,
  ].join("\n") + "\n";
}

type SettingsValue = {
  terminalEngine: "native" | "tmux";
  supervisor: { running: boolean; pid: number | null };
  resources: {
    historyEnabled: boolean;
    policy: null | { maxAgents: number | null; minAvailableMib: number | null; maxPressure: "normal" | "elevated" | null; maxContainerSuites: number | null };
  };
  limits: {
    enabledProviders: string[];
    notice: { enabled: boolean; intervalSeconds: number };
    readings: Awaited<ReturnType<typeof readLimitRows>>;
  };
  chains: Array<Record<string, unknown> & { name: string }>;
  models: Array<{ agent: string; model: string; name: string; family: string | null; generation: string | null; contextWindows: number[]; status: "current" | "older" | "deprecated"; description: string | null; reasoning: { levels: string[]; default: string | null }; enabled: boolean }>;
  agents: { updates: Awaited<ReturnType<typeof agentUpdateStatus>> };
  terminal: { default: string | null; detected: string | null; available: string[] };
};

const SETTINGS_KEYS = ["terminalEngine", "supervisor", "resources", "limits", "chains", "models", "terminal", "agents"] as const;
type SettingsKey = typeof SETTINGS_KEYS[number];

/** `only` limits the read to those top-level keys, so one page of the desktop window never pays for another's (limits go to the network). */
async function readSettings(environment: Environment, processAdapter: ProcessAdapter, only: ReadonlySet<SettingsKey> | null = null): Promise<Result<Partial<SettingsValue>>> {
  const want = (key: SettingsKey): boolean => only === null || only.has(key);
  const registryStatus = await loadAndPersistModelRegistry(environment);
  if (registryStatus.kind !== "loaded") return failed(registryStatus.error, registryStatus.exitCode);
  const database = readOnlyStateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);

  const chainConfig = readConfig(environment);
  if (chainConfig.kind !== "ok") return chainConfig;
  const registry = modelRegistry(environment);
  if (registry.kind !== "ok") return registry;
  // A step naming a model the registry dropped must not fail the whole read: it is flagged below and validation skips it.
  const stale = staleChainSteps(chainConfig.value, registry.value);
  const staleKeys = new Set(stale.map((entry) => `${entry.chain}/${entry.step}`));
  const lenient: ChainConfig = { ...chainConfig.value, chains: Object.fromEntries(Object.entries(chainConfig.value.chains).map(([name, chain]) => [name, { ...chain, steps: chain.steps.map((step, index) => staleKeys.has(`${name}/${index + 1}`) ? { ...step, unvalidated: true } : step) }])) };
  const validated = validateConfig(lenient, environment);
  if (validated.kind !== "ok") return validated;

  const [historyEnabled, storedPolicy, configuredDefault, readings, terminalEngine, modelSettings, updates] = await Promise.all([
    want("resources") ? resourceHistoryEnabled(environment) : false,
    want("resources") ? readAdmissionPolicy(environment) : undefined,
    want("terminal") ? storedDefault(environment) : undefined,
    want("limits") ? readLimitRows(environment, validated.value, processAdapter) : [],
    want("terminalEngine") ? readTerminalEngine(environment) : "native" as const,
    want("models") ? readDesktopSetting(environment, "models") as Promise<ModelSettings> : emptyModelSettings,
    want("agents") ? agentUpdateStatus(environment) : {},
  ]);
  const settingsPolicy = storedPolicy === undefined ? null : {
    maxAgents: storedPolicy.maxAgents ?? null,
    minAvailableMib: storedPolicy.minAvailableMiB ?? null,
    maxPressure: storedPolicy.maxPressure ?? null,
    maxContainerSuites: storedPolicy.maxContainerSuites ?? null,
  };
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  // A registry written before statuses meant current, older or deprecated said active or retired.
  const status = (value: unknown): SettingsValue["models"][number]["status"] => (value === "older" ? "older" : value === "deprecated" || value === "retired" ? "deprecated" : "current");
  const models = registry.value.map((model) => ({
    agent: model.agent,
    model: model.model,
    name: typeof model.name === "string" ? model.name : model.model,
    family: text(model.family),
    generation: text(model.generation),
    contextWindows: Array.isArray(model.contextWindows) ? model.contextWindows.filter((window): window is number => typeof window === "number") : [],
    status: status(model.status),
    description: text(model.description),
    reasoning: { levels: [...(model.reasoning?.levels ?? [])], default: text(model.reasoning?.default) },
    enabled: modelEnabled(modelSettings, model),
  }));
  const watcher = supervisorWatcher(database.value);
  const chains = Object.entries(chainConfig.value.chains).map(([name, chain]) => ({
    ...chain,
    name,
    steps: chain.steps.map((step, index) => {
      const entry = stale.find((candidate) => candidate.chain === name && candidate.step === index + 1);
      if (entry === undefined) return step;
      const effort = (step as { effort?: unknown }).effort;
      return { ...step, stale: true, reason: `model '${entry.model}' is not registered for agent '${entry.agent}'`, suggested: suggestModel(registry.value, entry.agent, typeof effort === "string" ? effort : undefined) };
    }),
  }));
  const defaultNotice = validated.value.usageLimits?.notice;
  const enabledProviders = [...(validated.value.usageLimits?.liveProviders ?? [])];
  const full: SettingsValue = {
    terminalEngine,
    supervisor: { running: watcher.running, pid: watcher.pid },
    resources: { historyEnabled, policy: settingsPolicy },
    limits: {
      enabledProviders,
      notice: { enabled: defaultNotice?.enabled ?? false, intervalSeconds: defaultNotice?.intervalSeconds ?? 3600 },
      readings,
    },
    chains,
    models,
    agents: { updates },
    terminal: {
      default: configuredDefault ?? null,
      detected: detectTerminal(environment) ?? null,
      available: OPENERS.filter((opener) => opener.platforms.includes(platform())).map((opener) => opener.name),
    },
  };
  return ok(only === null ? full : Object.fromEntries(Object.entries(full).filter(([key]) => only.has(key as SettingsKey))));
}

export async function executeSettings(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "get" && args[1] === "project-appearance") {
    if (args.slice(2).some((arg) => arg !== "--json")) return failed("Usage: megabrain settings get project-appearance [--json]", 2);
    return ok(`${JSON.stringify(await readProjectAppearance(environment))}\n`);
  }
  if (args[0] === "set" && args[1] === "project-appearance") {
    const project = args[2];
    if (project === undefined || project.startsWith("--")) return failed(APPEARANCE_USAGE, 2);
    const patch = parseAppearancePatch(args.slice(3));
    if (patch.kind !== "ok") return patch;
    const saved = await setProjectAppearance(environment, project, patch.value);
    return saved.kind === "ok" ? ok(`${JSON.stringify(saved.value)}\n`) : saved;
  }
  if (args[0] === "get") {
    if (args[1] === "agents-update" && (args.length === 2 || args.length === 3 && args[2] === "--json")) return ok(`${JSON.stringify(await readAgentAutoUpdateSettings(environment))}\n`);
    if ((args.length !== 2 && !(args.length === 3 && args[2] === "--json")) || !isDesktopSetting(args[1])) return failed("Usage: megabrain settings get sidebar-folders|sidebar-state|shortcuts|hidden-sessions|usage-order|chat-summaries|knowledge|agents|models|worktree-location|device-idle-minutes|project-appearance [--json]", 2);
    return ok(`${JSON.stringify(await readDesktopSetting(environment, args[1]))}\n`);
  }
  if (args[0] === "set" && isDesktopSetting(args[1])) {
    const raw = args[2];
    if (args.length !== 3 || raw === undefined) return failed(`Usage: megabrain settings set ${args[1]} <json>`, 2);
    return writeDesktopSetting(environment, args[1], raw);
  }
  if (args[0] === "set" && args[1] === "agents-update") {
    const raw = args[2];
    if (args.length !== 3 || raw === undefined) return failed("Usage: megabrain settings set agents-update <json>", 2);
    const result = await writeAgentAutoUpdateSettings(raw, environment);
    return result.kind === "ok" ? ok(`agent auto-update: ${result.value.enabled ? "on" : "off"}; ${Object.keys(result.value.perAgent).length} overrides\n`) : result;
  }
  if (args[0] === "set") {
    if (args.length !== 3 || args[1] !== "terminal-engine" || (args[2] !== "native" && args[2] !== "tmux")) return failed("Usage: megabrain settings set terminal-engine native|tmux", 2);
    await writeTerminalEngine(environment, args[2]);
    return ok(`terminal engine: ${args[2]}\n`);
  }
  let asJson = false;
  let only: Set<SettingsKey> | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") asJson = true;
    else if (arg === "--only") {
      const keys = (args[index + 1] ?? "").split(",").filter((key) => key.length > 0);
      const bad = keys.find((key) => !(SETTINGS_KEYS as readonly string[]).includes(key));
      if (keys.length === 0 || bad !== undefined) return failed(`settings --only needs a comma-separated list of: ${SETTINGS_KEYS.join(", ")}`, 2);
      only = new Set(keys as SettingsKey[]);
      index += 1;
    }
    else if (arg === "-h" || arg === "--help") return ok(usageText("settings"));
    else return failed(`unknown settings option: ${arg}`, 2);
  }
  const result = await readSettings(environment, processAdapter, only);
  if (result.kind !== "ok") return result;
  if (only !== null && !asJson) return failed("settings --only needs --json", 2);
  return ok(asJson ? `${JSON.stringify(result.value, null, 2)}\n` : summary(result.value as SettingsValue));
}
