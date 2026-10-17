import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";import { basename, dirname, resolve } from "node:path";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { resolvePackageRoot } from "../../../core/package-root.js";import { mutateInstallModule, stateDatabase } from "../../../adapters/state-db.js";
import { available, readState, fileText, hookCommandKind, hookConfig } from "./diagnostics.js";import type { Environment } from "./diagnostics.js";import { backupExistingFile, writeJsonAtomic } from "./install-state.js";
// --- orchestration-hooks -----------------------------------------------------------------

export const hookAgents = ["claude", "codex", "agy", "cursor", "grok"] as const;
export type HookAgent = (typeof hookAgents)[number];

export async function hookAgentAvailable(agent: HookAgent, processAdapter: ProcessAdapter): Promise<boolean> {
  return agent === "cursor"
    ? (await available(processAdapter, "cursor")) || (await available(processAdapter, "cursor-agent"))
    : available(processAdapter, agent);
}

export type HookRuntime = Readonly<{ execPath: string; node: boolean }>;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hookEntrypointCommand(
  environment: Environment,
  agent: HookAgent,
  runtime: HookRuntime = { execPath: process.execPath, node: process.versions.bun === undefined },
  hook: "turn-end" | "pre-tool" | "session-start" = "turn-end",
): string | undefined {
  const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
  const entrypoint = resolve(root, ".build/megabrain");
  if (runtime.node) {
    try {
      if ((statSync(entrypoint).mode & 0o111) === 0) return undefined;
    } catch {
      return undefined;
    }
    return `MEGABRAIN_HOOK_AGENT=${agent} ${shellQuote(resolve(runtime.execPath))} ${shellQuote(entrypoint)} hook ${hook}`;
  }
  try {
    if ((statSync(entrypoint).mode & 0o111) === 0) return undefined;
    return `MEGABRAIN_HOOK_AGENT=${agent} ${shellQuote(realpathSync(entrypoint))} hook ${hook}`;
  } catch {
    return undefined;
  }
}

// Used by repair to find the entry to replace in place, whichever form it currently has: the
// deleted bash wrapper's path (an older install, or one from a different checkout) or an
// existing direct-binary command (possibly stale, e.g. pointing at a different checkout).
export function hookEntryMatches(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const command = String((entry as Record<string, unknown>).command ?? "");
  return hookEntryAgent(entry) !== undefined && hookCommandKind(command) !== "none";
}

export function hookEntryAgent(entry: unknown): HookAgent | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const command = String((entry as Record<string, unknown>).command ?? "");
  const match = /(?:^|\s)MEGABRAIN_HOOK_AGENT=(claude|codex|agy|cursor|grok)(?:\s|$)/.exec(command);
  return match?.[1] as HookAgent | undefined;
}

export function hasHookEntry(existing: Record<string, unknown>, agent: HookAgent): boolean {
  const hooks = existing.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return false;
  const value = hooks as Record<string, unknown>;
  const matchesAgent = (entry: unknown): boolean => {
    if (hookEntryAgent(entry) !== agent || !hookEntryMatches(entry)) return false;
    return hookCommandKind(String((entry as Record<string, unknown>).command ?? "")) === "new";
  };
  if (agent === "cursor") return Array.isArray(value.afterAgentResponse) && value.afterAgentResponse.some(matchesAgent);
  return Array.isArray(value.Stop) && value.Stop.some((group) => {
    if (typeof group !== "object" || group === null || Array.isArray(group)) return false;
    const entries = (group as Record<string, unknown>).hooks;
    return Array.isArray(entries) && entries.some(matchesAgent);
  });
}

export function repairStopHooks(existing: Record<string, unknown>, command: string, agent: HookAgent): Record<string, unknown> {
  const hooksField = existing.hooks;
  if (hooksField !== undefined && (typeof hooksField !== "object" || hooksField === null || Array.isArray(hooksField))) throw new Error("hooks must be an object");
  const hooks = (hooksField as Record<string, unknown> | undefined) ?? {};
  const stopField = hooks.Stop;
  if (stopField !== undefined && !Array.isArray(stopField)) throw new Error("hooks.Stop must be an array");
  const stop = (stopField as unknown[] | undefined) ?? [];
  let seen = false;
  const entries: unknown[] = [];
  for (const group of stop) {
    const record = group !== null && typeof group === "object" ? (group as Record<string, unknown>) : {};
    const nested = Array.isArray(record.hooks) ? (record.hooks as unknown[]) : [];
    if (!nested.some((entry) => hookEntryAgent(entry) === agent && hookEntryMatches(entry))) {
      entries.push(group);
      continue;
    }
    if (seen) continue;
    let nestedSeen = false;
    const nestedEntries: unknown[] = [];
    for (const entry of nested) {
      if (hookEntryAgent(entry) === agent && hookEntryMatches(entry)) {
        if (nestedSeen) continue;
        nestedEntries.push({ ...(entry as Record<string, unknown>), type: "command", command });
        nestedSeen = true;
      } else {
        nestedEntries.push(entry);
      }
    }
    entries.push({ ...record, hooks: nestedEntries });
    seen = true;
  }
  if (!seen) entries.push({ hooks: [{ type: "command", command }] });
  return { ...existing, hooks: { ...hooks, Stop: entries } };
}

export function repairAfterAgentResponse(existing: Record<string, unknown>, command: string, agent: HookAgent): Record<string, unknown> {
  const hooksField = existing.hooks;
  if (hooksField !== undefined && (typeof hooksField !== "object" || hooksField === null || Array.isArray(hooksField))) throw new Error("hooks must be an object");
  const hooks = (hooksField as Record<string, unknown> | undefined) ?? {};
  const listField = hooks.afterAgentResponse;
  if (listField !== undefined && !Array.isArray(listField)) throw new Error("hooks.afterAgentResponse must be an array");
  const list = (listField as unknown[] | undefined) ?? [];
  let seen = false;
  const entries: unknown[] = [];
  for (const entry of list) {
    if (hookEntryAgent(entry) === agent && hookEntryMatches(entry)) {
      if (seen) continue;
      entries.push({ ...(entry as Record<string, unknown>), command, timeout: 10 });
      seen = true;
    } else {
      entries.push(entry);
    }
  }
  if (!seen) entries.push({ command, timeout: 10 });
  return { ...existing, hooks: { ...hooks, afterAgentResponse: entries }, version: (existing.version as number | undefined) ?? 1 };
}

export type HookInstallState = { createdConfigs: string[]; backups: Record<string, string>; movedLegacyAgy?: boolean };

export function readHookInstallState(environment: Environment): HookInstallState {
  const moduleState = readState(environment)["orchestration-hooks"];
  const value = moduleState?.hookConfigs;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { createdConfigs: [], backups: {} };
  const record = value as Record<string, unknown>;
  const createdConfigs = Array.isArray(record.createdConfigs) ? record.createdConfigs.filter((agent): agent is string => typeof agent === "string") : [];
  const backups = typeof record.backups === "object" && record.backups !== null && !Array.isArray(record.backups)
    ? Object.fromEntries(Object.entries(record.backups as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
  return { createdConfigs, backups, movedLegacyAgy: record.movedLegacyAgy === true };
}

export function writeHookInstallState(environment: Environment, hookState: HookInstallState): void {
  const opened = stateDatabase(environment);
  if (opened.kind !== "ok") return;
  mutateInstallModule(opened.value, "orchestration-hooks", (value) => {
    const moduleState = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return { ...moduleState, hookConfigs: hookState };
  });
}

export function latestHookBackup(path: string): string | undefined {
  const prefix = `${basename(path)}.megabrain-backup-`;
  try {
    const names = readdirSync(dirname(path)).filter((name) => name.startsWith(prefix)).sort();
    return names.length > 0 ? resolve(dirname(path), names[names.length - 1]!) : undefined;
  } catch {
    return undefined;
  }
}

export async function repairHooksConfig(agent: HookAgent, environment: Environment, processAdapter: ProcessAdapter, hookState: HookInstallState): Promise<Result<void>> {
  const path = hookConfig(environment, agent);
  const command = hookEntrypointCommand(environment, agent);
  if (command === undefined) return failed(`hook entrypoint is not executable for ${agent}`);
  const existedBeforeInstall = existsSync(path);
  let existing: Record<string, unknown> = {};
  if (existedBeforeInstall) {
    const raw = fileText(path);
    try {
      existing = raw === undefined ? {} : (JSON.parse(raw) as Record<string, unknown>);
    } catch {
      return failed(`${agent} config is not valid JSON: ${path}`);
    }
  }
  if (existedBeforeInstall && !hasHookEntry(existing, agent)) {
    const recorded = hookState.backups[agent];
    const backupPath = recorded !== undefined && dirname(recorded) === dirname(path) && basename(recorded).startsWith(`${basename(path)}.megabrain-backup-`)
      ? recorded : latestHookBackup(path);
    if (backupPath !== undefined) {
      hookState.backups[agent] = backupPath;
    } else {
      const backup = await backupExistingFile(path, processAdapter);
      if (backup.kind !== "ok") return backup;
      if (backup.value !== undefined) hookState.backups[agent] = backup.value;
    }
  }
  let updated: Record<string, unknown>;
  try {
    updated = agent === "cursor" ? repairAfterAgentResponse(existing, command, agent) : repairStopHooks(existing, command, agent);
  } catch {
    return failed(`could not update ${agent} hooks: ${path}`);
  }
  try {
    await writeJsonAtomic(path, updated);
  } catch {
    return failed(`could not update ${agent} hooks: ${path}`);
  }
  if (!existedBeforeInstall && !hookState.createdConfigs.includes(agent)) hookState.createdConfigs.push(agent);
  writeHookInstallState(environment, hookState);
  return ok(undefined);
}

