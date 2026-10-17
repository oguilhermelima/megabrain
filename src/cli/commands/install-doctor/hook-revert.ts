import { existsSync, readFileSync, unlinkSync } from "node:fs";import { copyFile } from "node:fs/promises";import { basename, dirname } from "node:path";import { isDeepStrictEqual } from "node:util";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";
import { hookConfig, legacyAgyHookConfig } from "./diagnostics.js";import type { Environment } from "./diagnostics.js";import { backupExistingFile, writeJsonAtomic } from "./install-state.js";import { hookAgents, hookAgentAvailable, hookEntryMatches, hookEntryAgent, readHookInstallState, writeHookInstallState, latestHookBackup, repairHooksConfig } from "./hook-config.js";import type { HookAgent, HookInstallState } from "./hook-config.js";
export async function installOrchestrationHooks(environment: Environment, processAdapter: ProcessAdapter): Promise<Result<void>> {
  const hookState = readHookInstallState(environment);
  hookState.movedLegacyAgy = false;
  for (const agent of hookAgents) {
    if (!(await hookAgentAvailable(agent, processAdapter))) continue;
    const result = await repairHooksConfig(agent, environment, processAdapter, hookState);
    if (result.kind !== "ok") return failed(`orchestration-hooks: ${result.error}`);
  }
  const migration = await migrateLegacyAgyHooks(environment, processAdapter, hookState);
  if (migration.kind !== "ok") return failed(`orchestration-hooks: ${migration.error}`);
  return ok(undefined);
}

export function removeHookEntries(existing: Record<string, unknown>, agent: HookAgent): Record<string, unknown> {
  const hooksField = existing.hooks;
  if (typeof hooksField !== "object" || hooksField === null || Array.isArray(hooksField)) return existing;
  const hooks = hooksField as Record<string, unknown>;
  if (agent === "cursor") {
    const list = hooks.afterAgentResponse;
    if (!Array.isArray(list)) return existing;
    return { ...existing, hooks: { ...hooks, afterAgentResponse: list.filter((entry) => hookEntryAgent(entry) !== agent || !hookEntryMatches(entry)) } };
  }
  const stop = hooks.Stop;
  if (!Array.isArray(stop)) return existing;
  const nextStop: unknown[] = [];
  for (const group of stop) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      nextStop.push(group);
      continue;
    }
    const record = group as Record<string, unknown>;
    if (!Array.isArray(record.hooks)) {
      nextStop.push(group);
      continue;
    }
    const entries = record.hooks.filter((entry) => hookEntryAgent(entry) !== agent || !hookEntryMatches(entry));
    if (entries.length === 0 && Object.keys(record).length === 1) continue;
    nextStop.push({ ...record, hooks: entries });
  }
  return { ...existing, hooks: { ...hooks, Stop: nextStop } };
}

export async function migrateLegacyAgyHooks(environment: Environment, processAdapter: ProcessAdapter, hookState: HookInstallState): Promise<Result<void>> {
  const path = legacyAgyHookConfig(environment);
  if (!existsSync(path)) return ok(undefined);
  let existing: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config must be a JSON object");
    existing = parsed as Record<string, unknown>;
  } catch {
    return failed(`agy legacy config is not valid JSON: ${path}`);
  }
  const updated = removeHookEntries(existing, "agy");
  if (isDeepStrictEqual(updated, existing)) return ok(undefined);

  let backup: string | undefined = hookState.backups.agyLegacy;
  if (backup === undefined || !existsSync(backup)) {
    backup = latestHookBackup(path);
    if (backup === undefined) {
      const result = await backupExistingFile(path, processAdapter);
      if (result.kind !== "ok") return result;
      backup = result.value;
    }
    if (backup !== undefined) hookState.backups.agyLegacy = backup;
  }
  hookState.movedLegacyAgy = true;
  writeHookInstallState(environment, hookState);
  try {
    if (emptyConfigCreatedByInstall(updated)) unlinkSync(path);
    else await writeJsonAtomic(path, updated);
  } catch {
    return failed(`could not move agy hooks from ${path}`);
  }
  return ok(undefined);
}

export function restoreHookEntries(current: Record<string, unknown>, original: Record<string, unknown>, agent: HookAgent): Record<string, unknown> {
  const currentHooks = typeof current.hooks === "object" && current.hooks !== null && !Array.isArray(current.hooks)
    ? current.hooks as Record<string, unknown> : {};
  const originalHooks = typeof original.hooks === "object" && original.hooks !== null && !Array.isArray(original.hooks)
    ? original.hooks as Record<string, unknown> : {};
  if (agent === "cursor") {
    const saved = Array.isArray(originalHooks.afterAgentResponse) ? originalHooks.afterAgentResponse.filter((entry) => hookEntryAgent(entry) === agent && hookEntryMatches(entry)) : [];
    const present = Array.isArray(currentHooks.afterAgentResponse) ? currentHooks.afterAgentResponse : [];
    return { ...current, hooks: { ...currentHooks, afterAgentResponse: [...present, ...saved] } };
  }
  const savedGroups: unknown[] = [];
  const originalStop = Array.isArray(originalHooks.Stop) ? originalHooks.Stop : [];
  for (const group of originalStop) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) continue;
    const record = group as Record<string, unknown>;
    const entries = Array.isArray(record.hooks) ? record.hooks.filter((entry) => hookEntryAgent(entry) === agent && hookEntryMatches(entry)) : [];
    if (entries.length > 0) savedGroups.push({ ...record, hooks: entries });
  }
  const currentStop = Array.isArray(currentHooks.Stop) ? currentHooks.Stop : [];
  return { ...current, hooks: { ...currentHooks, Stop: [...currentStop, ...savedGroups] } };
}

export function withoutEmptyContainers(value: unknown): unknown {
  if (Array.isArray(value)) {
    const entries = value.map(withoutEmptyContainers).filter((entry) => !(Array.isArray(entry) && entry.length === 0) && !(typeof entry === "object" && entry !== null && Object.keys(entry).length === 0));
    return entries;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, withoutEmptyContainers(entry)] as const)
      .filter(([, entry]) => !(Array.isArray(entry) && entry.length === 0) && !(typeof entry === "object" && entry !== null && Object.keys(entry).length === 0));
    return Object.fromEntries(entries);
  }
  return value;
}

export function emptyConfigCreatedByInstall(value: unknown): boolean {
  const pruned = withoutEmptyContainers(value);
  if (typeof pruned !== "object" || pruned === null || Array.isArray(pruned)) return false;
  const remaining = { ...(pruned as Record<string, unknown>) };
  if (remaining.version === 1) delete remaining.version;
  return Object.keys(remaining).length === 0;
}

export function removeInstallCreatedStructure(current: Record<string, unknown>, original: unknown, agent: HookAgent): Record<string, unknown> {
  const baseline = typeof original === "object" && original !== null && !Array.isArray(original)
    ? original as Record<string, unknown> : {};
  const currentHooks = current.hooks;
  const originalHooks = baseline.hooks;
  if (typeof currentHooks !== "object" || currentHooks === null || Array.isArray(currentHooks)) return current;
  const hooks = { ...(currentHooks as Record<string, unknown>) };
  const priorHooks = typeof originalHooks === "object" && originalHooks !== null && !Array.isArray(originalHooks)
    ? originalHooks as Record<string, unknown> : {};
  const listKey = agent === "cursor" ? "afterAgentResponse" : "Stop";
  if (Array.isArray(hooks[listKey]) && hooks[listKey].length === 0 && priorHooks[listKey] === undefined) delete hooks[listKey];
  const result = { ...current };
  if (Object.keys(hooks).length === 0 && originalHooks === undefined) delete result.hooks;
  else result.hooks = hooks;
  if (agent === "cursor" && result.version === 1 && baseline.version === undefined) delete result.version;
  return result;
}

export async function revertOrchestrationHooks(environment: Environment): Promise<Result<string>> {
  const hookState = readHookInstallState(environment);
  for (const agent of hookAgents) {
    const path = hookConfig(environment, agent);
    if (!existsSync(path)) continue;
    let current: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config must be a JSON object");
      current = parsed as Record<string, unknown>;
    } catch {
      return failed(`${agent} config is not valid JSON: ${path}`);
    }
    const filtered = removeHookEntries(current, agent);
    const recorded = hookState.backups[agent];
    const backup = recorded !== undefined && dirname(recorded) === dirname(path) && basename(recorded).startsWith(`${basename(path)}.megabrain-backup-`)
      ? recorded : latestHookBackup(path);
    if (backup !== undefined && existsSync(backup)) {
      try {
        const original: unknown = JSON.parse(readFileSync(backup, "utf8"));
        if (isDeepStrictEqual(removeInstallCreatedStructure(filtered, original, agent), removeHookEntries(original as Record<string, unknown>, agent))) {
          await copyFile(backup, path);
          continue;
        }
      } catch {
        // An unusable backup cannot authorize replacing the current config.
      }
    }
    try {
      await writeJsonAtomic(path, filtered);
      if (hookState.createdConfigs.includes(agent) && emptyConfigCreatedByInstall(filtered)) unlinkSync(path);
    } catch {
      return failed(`could not remove ${agent} hooks from ${path}`);
    }
  }
  const legacyPath = legacyAgyHookConfig(environment);
  const legacyBackup = hookState.backups.agyLegacy;
  if (legacyBackup !== undefined && existsSync(legacyBackup)) {
    let original: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyBackup, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config must be a JSON object");
      original = parsed as Record<string, unknown>;
    } catch {
      return failed(`agy legacy backup is not valid JSON: ${legacyBackup}`);
    }
    if (!existsSync(legacyPath)) {
      try {
        await copyFile(legacyBackup, legacyPath);
      } catch {
        return failed(`could not restore agy legacy hooks from ${legacyBackup}`);
      }
    } else {
      let current: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config must be a JSON object");
        current = parsed as Record<string, unknown>;
      } catch {
        return failed(`agy legacy config is not valid JSON: ${legacyPath}`);
      }
      const filtered = removeHookEntries(current, "agy");
      if (isDeepStrictEqual(filtered, removeHookEntries(original, "agy"))) {
        try {
          await copyFile(legacyBackup, legacyPath);
        } catch {
          return failed(`could not restore agy legacy hooks from ${legacyBackup}`);
        }
      } else {
        try {
          const restored = restoreHookEntries(filtered, original, "agy");
          if (emptyConfigCreatedByInstall(restored)) unlinkSync(legacyPath);
          else await writeJsonAtomic(legacyPath, restored);
        } catch {
          return failed(`could not restore agy legacy hooks in ${legacyPath}`);
        }
      }
    }
  } else if (existsSync(legacyPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("config must be a JSON object");
      const filtered = removeHookEntries(parsed as Record<string, unknown>, "agy");
      if (isDeepStrictEqual(filtered, parsed)) {
        // No Megabrain entries were present in the legacy config.
      } else if (emptyConfigCreatedByInstall(filtered)) unlinkSync(legacyPath);
      else await writeJsonAtomic(legacyPath, filtered);
    } catch {
      return failed(`could not remove agy hooks from ${legacyPath}`);
    }
  }
  hookState.createdConfigs = [];
  hookState.backups = {};
  hookState.movedLegacyAgy = false;
  writeHookInstallState(environment, hookState);
  return ok("orchestration-hooks reverted\n");
}

