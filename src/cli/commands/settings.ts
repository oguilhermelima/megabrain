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
