import { existsSync, unlinkSync } from "node:fs";import { join } from "node:path";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";
import { modules, available, fileText, hookPathIssue, hookConfig } from "./diagnostics.js";import type { Environment } from "./diagnostics.js";import { writeInstalledState, backupExistingFile, writeJsonAtomic } from "./install-state.js";import { hookEntrypointCommand } from "./hook-config.js";
// --- resource-hooks and summaries-context ----------------------------------------------------
// Opt-in modules that each add one hook entry to the agents' hook files. resource-hooks puts a
// pre-tool hook in every agent that routes resource commands into megabrain proc (see
// hook-pre-tool.ts); summaries-context puts a SessionStart hook in Claude and Codex that adds the
// latest summaries of the session's worktree (see hook-session-start.ts). Entries are found by
// their command, so install repairs in place and revert removes exactly megabrain's entries,
// leaving every other hook alone.

export const resourceHookAgents = ["claude", "codex", "grok", "agy"] as const;
export type ResourceHookAgent = (typeof resourceHookAgents)[number];
export const AGY_RESOURCE_HOOK = "megabrain-resources";

export type EntryHook = Readonly<{
  module: "resource-hooks" | "summaries-context";
  event: "PreToolUse" | "SessionStart";
  hook: "pre-tool" | "session-start";
  agents: readonly ResourceHookAgent[];
  note: string;
}>;
export const resourceEntryHook: EntryHook = { module: "resource-hooks", event: "PreToolUse", hook: "pre-tool", agents: resourceHookAgents, note: "routes dev servers, docker and migrations into megabrain proc" };
export const summariesEntryHook: EntryHook = { module: "summaries-context", event: "SessionStart", hook: "session-start", agents: ["claude", "codex"], note: "adds the latest summaries of the worktree to a new session" };

// Grok reads every file in its hooks directory, so this module owns a file of its own there.
export function resourceHookConfig(environment: Environment, agent: ResourceHookAgent): string {
  if (agent === "grok") return join(environment.GROK_HOME ?? join(environment.HOME ?? "", ".grok"), "hooks", "megabrain-resources.json");
  return hookConfig(environment, agent);
}

export function isResourceEntry(entry: unknown, agent: ResourceHookAgent, spec: EntryHook): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const command = String((entry as Record<string, unknown>).command ?? "");
  return command.startsWith(`MEGABRAIN_HOOK_AGENT=${agent} `) && command.endsWith(` hook ${spec.hook}`);
}

export function readJsonObject(path: string): Record<string, unknown> | undefined {
  const raw = fileText(path);
  if (raw === undefined) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

export function resourceGroups(existing: Record<string, unknown>, spec: EntryHook): unknown[] {
  const hooks = existing.hooks;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return [];
  const list = (hooks as Record<string, unknown>)[spec.event];
  return Array.isArray(list) ? list : [];
}

export function withoutResourceEntries(existing: Record<string, unknown>, agent: ResourceHookAgent, spec: EntryHook): Record<string, unknown> {
  if (agent === "agy") { const { [AGY_RESOURCE_HOOK]: _removed, ...rest } = existing; return rest; }
  const groups: unknown[] = [];
  for (const group of resourceGroups(existing, spec)) {
    const record = typeof group === "object" && group !== null ? group as Record<string, unknown> : {};
    const nested = Array.isArray(record.hooks) ? record.hooks as unknown[] : [];
    if (!nested.some((entry) => isResourceEntry(entry, agent, spec))) { groups.push(group); continue; }
    const kept = nested.filter((entry) => !isResourceEntry(entry, agent, spec));
    if (kept.length > 0) groups.push({ ...record, hooks: kept });
  }
  const hooks = typeof existing.hooks === "object" && existing.hooks !== null && !Array.isArray(existing.hooks) ? existing.hooks as Record<string, unknown> : {};
  return { ...existing, hooks: { ...hooks, [spec.event]: groups } };
}

export function withResourceEntry(existing: Record<string, unknown>, agent: ResourceHookAgent, command: string, spec: EntryHook): Record<string, unknown> {
  const base = withoutResourceEntries(existing, agent, spec);
  if (agent === "agy") return { ...base, [AGY_RESOURCE_HOOK]: { PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command, timeout: 10 }] }] } };
  const hooks = base.hooks as Record<string, unknown>;
  // Claude names its shell tool Bash; Codex and Grok get every call and the hook ignores the rest.
  const group = { ...(agent === "claude" && spec.event === "PreToolUse" ? { matcher: "Bash" } : {}), hooks: [{ type: "command", command }] };
  return { ...base, hooks: { ...hooks, [spec.event]: [...resourceGroups(base, spec), group] } };
}

export function resourceEntryCommands(existing: Record<string, unknown>, agent: ResourceHookAgent, spec: EntryHook): string[] {
  const groups = agent === "agy" ? (() => {
    const named = existing[AGY_RESOURCE_HOOK];
    const list = typeof named === "object" && named !== null ? (named as Record<string, unknown>).PreToolUse : undefined;
    return Array.isArray(list) ? list : [];
  })() : resourceGroups(existing, spec);
  return groups.flatMap((group) => {
    const nested = typeof group === "object" && group !== null ? (group as Record<string, unknown>).hooks : undefined;
    return Array.isArray(nested) ? nested.filter((entry) => isResourceEntry(entry, agent, spec)).map((entry) => String((entry as Record<string, unknown>).command)) : [];
  });
}

export async function installEntryHooks(environment: Environment, processAdapter: ProcessAdapter, spec: EntryHook): Promise<Result<void>> {
  for (const agent of spec.agents) {
    if (!(await available(processAdapter, agent))) continue;
    const command = hookEntrypointCommand(environment, agent, undefined, spec.hook);
    if (command === undefined) return failed(`hook entrypoint is not executable for ${agent}`);
    const path = resourceHookConfig(environment, agent);
    const existing = readJsonObject(path);
    if (existing === undefined) return failed(`${agent} config is not valid JSON: ${path}`);
    if (existsSync(path) && resourceEntryCommands(existing, agent, spec).length === 0) {
      const backup = await backupExistingFile(path, processAdapter);
      if (backup.kind !== "ok") return backup;
    }
    try { await writeJsonAtomic(path, withResourceEntry(existing, agent, command, spec)); } catch { return failed(`could not update ${agent} hooks: ${path}`); }
  }
  return ok(undefined);
}

export async function revertEntryHooks(environment: Environment, spec: EntryHook): Promise<Result<string>> {
  for (const agent of spec.agents) {
    const path = resourceHookConfig(environment, agent);
    if (!existsSync(path)) continue;
    if (agent === "grok") { unlinkSync(path); continue; }
    const existing = readJsonObject(path);
    if (existing === undefined) return failed(`${agent} config is not valid JSON: ${path}`);
    if (resourceEntryCommands(existing, agent, spec).length === 0) continue;
    try { await writeJsonAtomic(path, withoutResourceEntries(existing, agent, spec)); } catch { return failed(`could not update ${agent} hooks: ${path}`); }
  }
  writeInstalledState(environment, spec.module, false, "reverted");
  return ok(`${spec.module} reverted\n`);
}

export async function entryHooksReport(environment: Environment, processAdapter: ProcessAdapter, spec: EntryHook): Promise<{ status: string; reason: string }> {
  const details: string[] = [];
  let healthy = true;
  for (const agent of spec.agents) {
    if (!(await available(processAdapter, agent))) { details.push(`${agent}: not-installed`); continue; }
    const existing = readJsonObject(resourceHookConfig(environment, agent));
    const commands = existing === undefined ? [] : resourceEntryCommands(existing, agent, spec);
    const issue = commands.map((command) => hookPathIssue(agent, command)).find((value) => value !== undefined);
    if (commands.length === 0) { details.push(`${agent}: entry-missing`); healthy = false; }
    else if (issue !== undefined) { details.push(issue); healthy = false; }
    else details.push(`${agent}: entry-present`);
  }
  // Opt-in: with no entry in any agent the module was simply never installed.
  if (!details.some((detail) => detail.endsWith(": entry-present")) && details.some((detail) => detail.endsWith(": entry-missing"))) {
    return { status: "missing", reason: "module is not installed (opt-in)" };
  }
  return { status: healthy ? "ok" : "misconfigured", reason: `${details.join("; ")}; opt-in: ${spec.note}` };
}

