import { mkdir, open, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";
import type { Result } from "./result.js";
import { selfInvocation } from "./self-invocation.js";

export type AgentUpdateId = "codex" | "claude" | "grok" | "agy";
export type AgentUpdateStarter = (agent: AgentUpdateId, environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter) => Promise<void>;
export type AgentUpdateRuntime = Readonly<{ startAgentUpdate?: AgentUpdateStarter; now?: () => number }>;
export type AgentInstallKind = "standalone" | "npm" | "brew" | "native" | "unknown";
export type AgentUpdateStatus = "up-to-date" | "update-available" | "updating" | "updated" | "latest-unknown" | "failed";
export type AgentUpdateReport = Readonly<{
  agent: AgentUpdateId;
  installed: string | null;
  latest: string | null;
  installKind: AgentInstallKind;
  status: AgentUpdateStatus;
  checkedAt: string;
  lastAttempt?: Readonly<{ at: string; ok: boolean; error?: string }>;
}>;
export type AgentAutoUpdateSettings = Readonly<{ enabled: boolean; perAgent: Partial<Record<AgentUpdateId, boolean>> }>;
export const defaultAgentAutoUpdateSettings: AgentAutoUpdateSettings = { enabled: true, perAgent: {} };

export type AgentVersionSource = (agent: AgentUpdateId, installKind: AgentInstallKind, process: ProcessAdapter) => Promise<string | null>;

const EXECUTABLE: Record<AgentUpdateId, string> = { codex: "codex", claude: "claude", grok: "grok", agy: "agy" };
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const LOCK_MAX_AGE_MS = 60 * 60 * 1000;
const knownAgent = (agent: string): agent is AgentUpdateId => Object.hasOwn(EXECUTABLE, agent);
const parseVersion = (text: string): string | null => /(?:^|\s|v)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/.exec(text)?.[1] ?? null;

function autoUpdateSettingsFile(environment: Readonly<Record<string, string | undefined>>): string {
  return stateFile(environment, "agent-update-settings.json");
}

export async function readAgentAutoUpdateSettings(environment: Readonly<Record<string, string | undefined>>): Promise<AgentAutoUpdateSettings> {
  try {
    const value = JSON.parse(await readFile(autoUpdateSettingsFile(environment), "utf8")) as Partial<AgentAutoUpdateSettings>;
    if (typeof value.enabled !== "boolean" || typeof value.perAgent !== "object" || value.perAgent === null || Array.isArray(value.perAgent)) return defaultAgentAutoUpdateSettings;
    const perAgent: Partial<Record<AgentUpdateId, boolean>> = {};
    for (const [agent, enabled] of Object.entries(value.perAgent)) {
      if (!knownAgent(agent) || typeof enabled !== "boolean") return defaultAgentAutoUpdateSettings;
      perAgent[agent] = enabled;
    }
    return { enabled: value.enabled, perAgent };
  } catch { return defaultAgentAutoUpdateSettings; }
}

export async function writeAgentAutoUpdateSettings(raw: string, environment: Readonly<Record<string, string | undefined>>): Promise<Result<AgentAutoUpdateSettings>> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { kind: "failed", error: "agents-update: not valid JSON", exitCode: 2 }; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "failed", error: "agents-update: expected { enabled, perAgent }", exitCode: 2 };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "enabled" && key !== "perAgent") || typeof record.enabled !== "boolean" || typeof record.perAgent !== "object" || record.perAgent === null || Array.isArray(record.perAgent)) return { kind: "failed", error: "agents-update: expected { enabled, perAgent }", exitCode: 2 };
  const perAgent: Partial<Record<AgentUpdateId, boolean>> = {};
  for (const [agent, enabled] of Object.entries(record.perAgent)) {
    if (!knownAgent(agent) || typeof enabled !== "boolean") return { kind: "failed", error: "agents-update: perAgent must map known agents to booleans", exitCode: 2 };
    perAgent[agent] = enabled;
  }
  const settings: AgentAutoUpdateSettings = { enabled: record.enabled, perAgent };
  const file = autoUpdateSettingsFile(environment);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(settings) + "\n", { mode: 0o600 });
  await rename(temporary, file);
  return { kind: "ok", value: settings };
}

export function detectAgentInstallKind(agent: AgentUpdateId, executablePath: string): AgentInstallKind {
  if (agent === "codex" && executablePath.includes("/.codex/packages/standalone/")) return "standalone";
  if (executablePath.includes("/Cellar/") || executablePath.includes("/homebrew/Cellar/")) return "brew";
  if (executablePath.includes("/node_modules/")) return "npm";
  if (agent === "claude" && executablePath.includes("/.local/share/claude/versions/")) return "native";
  if (agent === "grok" && executablePath.includes("/.grok/")) return "native";
  return "unknown";
}

async function installedAgent(agent: AgentUpdateId, process: ProcessAdapter): Promise<Readonly<{ version: string | null; installKind: AgentInstallKind }>> {
  const path = await process.run("sh", ["-c", "command -v " + EXECUTABLE[agent]]);
  if (path.kind !== "ok") throw new Error(agent + " is not installed");
  const executable = path.value.stdout.trim();
  const resolved = await process.run("realpath", [executable]);
  const physicalPath = resolved.kind === "ok" ? resolved.value.stdout.trim() : executable;
  const versionResult = await process.run(EXECUTABLE[agent], ["--version"], { timeoutMs: 15_000 });
  if (versionResult.kind !== "ok") throw new Error(versionResult.error);
  return { version: parseVersion(versionResult.value.stdout) ?? parseVersion(versionResult.value.stderr), installKind: detectAgentInstallKind(agent, physicalPath) };
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "megabrain-agent-updates" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("version source returned HTTP " + response.status);
  return response.json();
}

async function npmLatest(packageName: string): Promise<string | null> {
  const value = await readJson("https://registry.npmjs.org/" + encodeURIComponent(packageName) + "/latest");
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string" ? value.version : null;
}

export function codexReleaseVersion(value: unknown): string | null {
  if (typeof value === "string") return parseVersion(value);
  if (typeof value !== "object" || value === null) return null;
  for (const key of ["tag_name", "version", "latest_version", "latestVersion"]) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string") return parseVersion(candidate) ?? candidate;
  }
  return null;
}

export const officialAgentVersion: AgentVersionSource = async (agent, installKind, process) => {
  if (agent === "codex" && installKind === "standalone") {
    try {
      const value = await readJson("https://releases.openai.com/codex/channels/latest");
      return codexReleaseVersion(value);
    } catch {
      try {
        const value = await readJson("https://api.github.com/repos/openai/codex/releases/latest");
        return typeof value === "object" && value !== null && "tag_name" in value && typeof value.tag_name === "string" ? parseVersion(value.tag_name) : null;
      } catch { return null; }
    }
  }
  if (agent === "codex" && installKind === "brew") {
    const result = await process.run("brew", ["info", "--json=v2", "codex"], { timeoutMs: 30_000 });
    if (result.kind !== "ok") return null;
    try {
      const value = JSON.parse(result.value.stdout) as { formulae?: Array<{ versions?: { stable?: unknown } }> };
      const latest = value.formulae?.[0]?.versions?.stable;
      return typeof latest === "string" ? latest : null;
    } catch { return null; }
  }
  if (agent === "codex" || agent === "claude") {
    return npmLatest(agent === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code").catch(() => null);
  }
  if (agent === "grok") {
    const result = await process.run("grok", ["update", "--check", "--json"], { timeoutMs: 30_000 });
    if (result.kind !== "ok") return null;
    try {
      const value = JSON.parse(result.value.stdout) as Record<string, unknown>;
      for (const key of ["latestVersion", "latest_version", "latest", "version"]) {
        if (typeof value[key] === "string") return parseVersion(value[key] as string) ?? value[key] as string;
      }
    } catch { return parseVersion(result.value.stdout); }
    return null;
  }
  // No official check-only source or confirmed package exists for this installation.
  return null;
};

function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).slice(0, 3).map(Number);
  const b = right.split(/[.+-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0) ? -1 : 1;
  return 0;
}

async function performUpdate(agent: AgentUpdateId, kind: AgentInstallKind, process: ProcessAdapter): Promise<void> {
  let result: Result<{ stdout: string; stderr: string; exitCode: number }>;
  if (agent === "codex" && kind === "standalone") {
    result = await process.run("bash", ["-o", "pipefail", "-c", "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"], { timeoutMs: 10 * 60_000 });
  } else if (agent === "codex" && kind === "npm") {
    result = await process.run("npm", ["install", "--global", "@openai/codex@latest"], { timeoutMs: 10 * 60_000 });
  } else if (agent === "codex" && kind === "brew") {
    result = await process.run("brew", ["upgrade", "codex"], { timeoutMs: 10 * 60_000 });
  } else if (agent === "claude" && kind === "npm") {
    result = await process.run("npm", ["install", "--global", "@anthropic-ai/claude-code@latest"], { timeoutMs: 10 * 60_000 });
  } else {
    result = await process.run(EXECUTABLE[agent], ["update"], { timeoutMs: 10 * 60_000 });
  }
  if (result.kind !== "ok") throw new Error(result.error);
}

export async function inspectAgentUpdate(agent: AgentUpdateId, process: ProcessAdapter, source: AgentVersionSource = officialAgentVersion): Promise<AgentUpdateReport> {
  const checkedAt = new Date().toISOString();
  const { version: installed, installKind } = await installedAgent(agent, process);
  const latest = await source(agent, installKind, process);
  const status: AgentUpdateStatus = latest === null || installed === null ? "latest-unknown" : compareVersions(installed, latest) >= 0 ? "up-to-date" : "update-available";
  return { agent, installed, latest, installKind, status, checkedAt };
}

export async function runAgentUpdate(agent: AgentUpdateId, checkOnly: boolean, process: ProcessAdapter, source: AgentVersionSource = officialAgentVersion): Promise<AgentUpdateReport> {
  const checked = await inspectAgentUpdate(agent, process, source);
  if (checkOnly || checked.status === "up-to-date") return checked;
  await performUpdate(agent, checked.installKind, process);
  const after = await installedAgent(agent, process);
  return { ...checked, installed: after.version ?? checked.installed, status: "updated" };
}

export async function runAgentUpdateLocked(agent: AgentUpdateId, checkOnly: boolean, process: ProcessAdapter, environment: Readonly<Record<string, string | undefined>>, source: AgentVersionSource = officialAgentVersion): Promise<AgentUpdateReport> {
  if (checkOnly) return runAgentUpdate(agent, true, process, source);
  const lock = stateFile(environment, ".agent-update-" + agent + ".lock");
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch { throw new Error(agent + " update is already running"); }
  await handle.close();
  const attemptAt = new Date().toISOString();
  let checked: AgentUpdateReport | undefined;
  try {
    checked = await inspectAgentUpdate(agent, process, source);
    await recordAgentUpdate({ ...checked, status: "updating" }, environment);
    const updated = await runAgentUpdate(agent, false, process, source);
    const report = { ...updated, lastAttempt: { at: attemptAt, ok: true } };
    await recordAgentUpdate(report, environment);
    return report;
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    if (checked !== undefined) await recordAgentUpdate({ ...checked, status: "failed", lastAttempt: { at: attemptAt, ok: false, error } }, environment);
    throw cause;
  }
  finally { await rm(lock, { force: true }); }
}

function stateFile(environment: Readonly<Record<string, string | undefined>>, file: string): string {
  return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"), file);
}

function reportFile(environment: Readonly<Record<string, string | undefined>>, agent: AgentUpdateId): string {
  return stateFile(environment, join("agent-updates", agent + ".json"));
}
async function readAgentReport(environment: Readonly<Record<string, string | undefined>>, agent: AgentUpdateId): Promise<AgentUpdateReport | undefined> {
  try {
    return JSON.parse(await readFile(reportFile(environment, agent), "utf8")) as AgentUpdateReport;
  } catch { return undefined; }
}
async function writeAgentReport(report: AgentUpdateReport, environment: Readonly<Record<string, string | undefined>>): Promise<void> {
  const file = reportFile(environment, report.agent);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(report) + "\n", { mode: 0o600 });
  await rename(temporary, file);
}

async function startAgentUpdate(agent: AgentUpdateId, environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter): Promise<void> {
  const invocation = selfInvocation(globalThis.process.execPath, globalThis.process.argv, ["agent", "update", agent, "--background"]);
  const launched = await process.startDetached(invocation.command, invocation.args, { env: { MEGABRAIN_STATE_DIR: environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? globalThis.process.cwd(), ".megabrain") } });
  if (launched.kind !== "ok") throw new Error(launched.error);
}

/** Reserves one six-hour update slot and starts its worker without delaying the agent launch. */
export async function scheduleAgentAutoUpdate(agent: AgentUpdateId, environment: Readonly<Record<string, string | undefined>>, process: ProcessAdapter, runtime: AgentUpdateRuntime = {}): Promise<void> {
  if (environment.MEGABRAIN_STATE_DIR === undefined && environment.HOME === undefined) return;
  const now = runtime.now ?? Date.now;
  const settings = await readAgentAutoUpdateSettings(environment);
  if (!(settings.perAgent[agent] ?? settings.enabled)) return;
  const previous = await readAgentReport(environment, agent);
  if (previous !== undefined && now() - Date.parse(previous.checkedAt) < UPDATE_INTERVAL_MS) return;
  const lock = stateFile(environment, ".agent-update-" + agent + ".lock");
  try {
    const existing = await stat(lock);
    if (now() - existing.mtimeMs < LOCK_MAX_AGE_MS) return;
    await rm(lock, { force: true });
  } catch { /* no lock */ }
  let handle;
  try { handle = await open(lock, "wx", 0o600); } catch { return; }
  await handle.close();
  try {
    await (runtime.startAgentUpdate ?? startAgentUpdate)(agent, environment, process);
  } catch (cause) {
    await rm(lock, { force: true });
    const at = new Date().toISOString();
    const error = cause instanceof Error ? cause.message : String(cause);
    await recordAgentUpdate({ agent, installed: null, latest: null, installKind: "unknown", status: "failed", checkedAt: at, lastAttempt: { at, ok: false, error } }, environment).catch(() => undefined);
  }
}

export async function recordAgentUpdate(report: AgentUpdateReport, environment: Readonly<Record<string, string | undefined>>): Promise<void> {
  await writeAgentReport(report, environment);
}

export async function agentUpdateStatus(environment: Readonly<Record<string, string | undefined>>): Promise<Partial<Record<AgentUpdateId, AgentUpdateReport>>> {
  const reports = await Promise.all((Object.keys(EXECUTABLE) as AgentUpdateId[]).map(async (agent) => [agent, await readAgentReport(environment, agent)] as const));
  return Object.fromEntries(reports.filter((entry): entry is readonly [AgentUpdateId, AgentUpdateReport] => entry[1] !== undefined));
}

export async function runBackgroundAgentUpdate(agent: string, process: ProcessAdapter, environment: Readonly<Record<string, string | undefined>>, source: AgentVersionSource = officialAgentVersion): Promise<void> {
  if (!knownAgent(agent)) return;
  const lock = stateFile(environment, ".agent-update-" + agent + ".lock");
  let report: AgentUpdateReport;
  try {
    const checked = await inspectAgentUpdate(agent, process, source);
    if (checked.status !== "update-available") report = checked;
    else {
      await recordAgentUpdate({ ...checked, status: "updating" }, environment);
      const attemptAt = new Date().toISOString();
      await performUpdate(agent, checked.installKind, process);
      const after = await installedAgent(agent, process);
      report = { ...checked, installed: after.version ?? checked.installed, status: "updated", lastAttempt: { at: attemptAt, ok: true } };
    }
  }
  catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    const at = new Date().toISOString();
    const previous = await readAgentReport(environment, agent);
    report = { agent, installed: previous?.installed ?? null, latest: previous?.latest ?? null, installKind: previous?.installKind ?? "unknown", status: "failed", checkedAt: at, lastAttempt: { at, ok: false, error } };
  }
  try { await recordAgentUpdate(report, environment); } finally { await rm(lock, { force: true }); }
}

export function updateReportText(report: AgentUpdateReport): string {
  const versions = "installed " + (report.installed ?? "unknown") + "; latest " + (report.latest ?? "unknown");
  return report.agent + ": " + report.status + " (" + versions + "; " + report.installKind + ")" + (report.lastAttempt?.error === undefined ? "" : " — " + report.lastAttempt.error) + "\n";
}
