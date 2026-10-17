import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { failed, ok, type Result } from "../core/result.js";

export const TOGGLES = ["summaries", "retitle", "topics", "sessions", "context"] as const;
export type Toggle = (typeof TOGGLES)[number];
/** summaries: summarise a project's chats and sessions. retitle: rename chats from summaries. topics: curate summaries into topics.
 *  sessions: also read sessions opened outside the app. context: give agents the topics. */
export type Toggles = Record<Toggle, boolean>;
export type KnowledgeSettings = { defaults: Toggles; projects: Record<string, Partial<Toggles>> };

export const allOn: Toggles = { summaries: true, retitle: true, topics: true, sessions: true, context: true };
/** Nothing reaches a model until the person turns summaries on. */
export const allOff: Toggles = { summaries: false, retitle: false, topics: false, sessions: false, context: false };
export const defaultKnowledgeSettings: KnowledgeSettings = { defaults: allOff, projects: {} };

export function knowledgeSettingsPath(stateDir: string): string { return join(stateDir, "knowledge-settings.json"); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToggles(value: unknown, where: string): Result<Partial<Toggles>> {
  if (!isRecord(value)) return failed(`knowledge: ${where} must be an object`, 2);
  const out: Partial<Toggles> = {};
  for (const [key, flag] of Object.entries(value)) {
    if (!(TOGGLES as readonly string[]).includes(key)) return failed(`knowledge: ${where} has unknown toggle ${key}`, 2);
    if (typeof flag !== "boolean") return failed(`knowledge: ${where}.${key} must be a boolean`, 2);
    out[key as Toggle] = flag;
  }
  return ok(out);
}

export function parseKnowledgeSettings(raw: string): Result<KnowledgeSettings> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("knowledge: not valid JSON", 2); }
  if (!isRecord(value)) return failed("knowledge: expected a JSON object", 2);
  // A top-level "enabled" from an earlier design is ignored.
  const unknown = Object.keys(value).find((key) => key !== "defaults" && key !== "projects" && key !== "enabled");
  if (unknown !== undefined) return failed(`knowledge: unknown key ${unknown}`, 2);
  const defaults = parseToggles(value.defaults ?? {}, "defaults");
  if (defaults.kind !== "ok") return defaults;
  if (value.projects !== undefined && !isRecord(value.projects)) return failed("knowledge: projects must be an object keyed by repository path", 2);
  const projects: KnowledgeSettings["projects"] = {};
  for (const [repo, toggles] of Object.entries(value.projects ?? {})) {
    const parsed = parseToggles(toggles, `projects.${repo}`);
    if (parsed.kind !== "ok") return parsed;
    projects[repo] = parsed.value;
  }
  return ok({ defaults: { ...allOn, ...defaults.value }, projects });
}

/**
 * The settings, migrating the old chat summary switch once: with no knowledge file yet, the chat-summaries enabled
 * and retitle fields become the defaults for summaries and retitle, the file is written, and those fields are ignored from then on.
 * With neither file, nobody has chosen anything: every toggle is off and nothing is written.
 */
export function readKnowledgeSettings(stateDir: string): KnowledgeSettings {
  const path = knowledgeSettingsPath(stateDir);
  try {
    const parsed = parseKnowledgeSettings(readFileSync(path, "utf8"));
    return parsed.kind === "ok" ? parsed.value : defaultKnowledgeSettings;
  } catch { /* no file yet: migrate */ }
  let defaults: Toggles;
  try {
    const old: unknown = JSON.parse(readFileSync(join(stateDir, "chat-summaries.json"), "utf8"));
    if (!isRecord(old)) return defaultKnowledgeSettings;
    defaults = { ...allOn, summaries: old.enabled === true, ...(typeof old.retitle === "boolean" ? { retitle: old.retitle } : {}) };
  } catch { return defaultKnowledgeSettings; }
  const migrated: KnowledgeSettings = { defaults, projects: {} };
  try {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(migrated)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* read-only state: the migrated value still applies for this read */ }
  return migrated;
}

/** What applies to one project: its own value, else the default; everything but summaries needs summaries. */
export function effectiveToggles(settings: KnowledgeSettings, repo: string): Toggles {
  const own = settings.projects[repo] ?? {};
  const merged = Object.fromEntries(TOGGLES.map((key) => [key, own[key] ?? settings.defaults[key]])) as Toggles;
  return merged.summaries ? merged : { summaries: false, retitle: false, topics: false, sessions: false, context: false };
}

export function togglesFor(stateDir: string, repo: string): Toggles {
  return effectiveToggles(readKnowledgeSettings(stateDir), repo);
}
