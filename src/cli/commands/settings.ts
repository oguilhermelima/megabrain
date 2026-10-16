import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readAdmissionPolicy, resourceHistoryEnabled, stateDatabase } from "../../adapters/state-db.js";
import type { ProcessAdapter } from "../../adapters/proc.js";
import { detectTerminal, OPENERS, type Platform } from "../../core/terminal-openers.js";
import { failed, ok, type Result } from "../../core/result.js";
import { usageText } from "../../core/usage.js";
import { modelRegistry, readConfig, readLimitRows, validateConfig } from "./chain.js";
import { storedDefault } from "./terminal-open.js";
import { supervisorWatcher } from "./supervise.js";

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

function sidebarFoldersFile(environment: Environment): string {
  return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"), "sidebar-settings.json");
}

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

async function readSidebarFolders(environment: Environment): Promise<SidebarFolders> {
  try {
    const parsed = parseSidebarFolders(await readFile(sidebarFoldersFile(environment), "utf8"));
    return parsed.kind === "ok" ? parsed.value : emptySidebarFolders;
  } catch { return emptySidebarFolders; }
}

async function writeSidebarFolders(environment: Environment, value: SidebarFolders): Promise<void> {
  const file = sidebarFoldersFile(environment);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
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
  models: Array<{ agent: string; model: string; name: string; contextWindows: number[]; current: boolean; reasoning: { levels: string[] } }>;
  terminal: { default: string | null; detected: string | null; available: string[] };
};

async function readSettings(environment: Environment, processAdapter: ProcessAdapter): Promise<Result<SettingsValue>> {
  const database = stateDatabase(environment);
  if (database.kind !== "ok") return failed(database.error, database.exitCode);

  const chainConfig = readConfig(environment);
  if (chainConfig.kind !== "ok") return chainConfig;
  const validated = validateConfig(chainConfig.value, environment);
  if (validated.kind !== "ok") return validated;

  const registry = modelRegistry(environment);
  if (registry.kind !== "ok") return registry;

  const [historyEnabled, storedPolicy, configuredDefault, readings, terminalEngine] = await Promise.all([
    resourceHistoryEnabled(environment),
    readAdmissionPolicy(environment),
    storedDefault(environment),
    readLimitRows(environment, validated.value, processAdapter),
    readTerminalEngine(environment),
  ]);
  const settingsPolicy = storedPolicy === undefined ? null : {
    maxAgents: storedPolicy.maxAgents ?? null,
    minAvailableMib: storedPolicy.minAvailableMiB ?? null,
    maxPressure: storedPolicy.maxPressure ?? null,
    maxContainerSuites: storedPolicy.maxContainerSuites ?? null,
  };
  const models = registry.value.map((model) => ({
    agent: model.agent,
    model: model.model,
    name: typeof model.name === "string" ? model.name : model.model,
    contextWindows: Array.isArray(model.contextWindows) ? model.contextWindows.filter((window): window is number => typeof window === "number") : [],
    current: model.current === true,
    reasoning: { levels: [...(model.reasoning?.levels ?? [])] },
  }));
  const watcher = supervisorWatcher(database.value);
  const chains = Object.entries(validated.value.chains).map(([name, chain]) => ({ ...chain, name }));
  const defaultNotice = validated.value.usageLimits?.notice;
  const enabledProviders = [...(validated.value.usageLimits?.liveProviders ?? [])];
  return ok({
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
    terminal: {
      default: configuredDefault ?? null,
      detected: detectTerminal(environment) ?? null,
      available: OPENERS.filter((opener) => opener.platforms.includes(platform())).map((opener) => opener.name),
    },
  });
}

export async function executeSettings(args: readonly string[], environment: Environment, processAdapter: ProcessAdapter): Promise<Result<string>> {
  if (args[0] === "get") {
    if (args.length !== 2 || args[1] !== "sidebar-folders") return failed("Usage: megabrain settings get sidebar-folders", 2);
    return ok(`${JSON.stringify(await readSidebarFolders(environment))}\n`);
  }
  if (args[0] === "set" && args[1] === "sidebar-folders") {
    const raw = args[2];
    if (args.length !== 3 || raw === undefined) return failed("Usage: megabrain settings set sidebar-folders <json>", 2);
    const parsed = parseSidebarFolders(raw);
    if (parsed.kind !== "ok") return parsed;
    await writeSidebarFolders(environment, parsed.value);
    return ok(`sidebar folders: ${parsed.value.folders.length}\n`);
  }
  if (args[0] === "set") {
    if (args.length !== 3 || args[1] !== "terminal-engine" || (args[2] !== "native" && args[2] !== "tmux")) return failed("Usage: megabrain settings set terminal-engine native|tmux", 2);
    await writeTerminalEngine(environment, args[2]);
    return ok(`terminal engine: ${args[2]}\n`);
  }
  let asJson = false;
  for (const arg of args) {
    if (arg === "--json") asJson = true;
    else if (arg === "-h" || arg === "--help") return ok(usageText("settings"));
    else return failed(`unknown settings option: ${arg}`, 2);
  }
  const result = await readSettings(environment, processAdapter);
  if (result.kind !== "ok") return result;
  return ok(asJson ? `${JSON.stringify(result.value, null, 2)}\n` : summary(result.value));
}
