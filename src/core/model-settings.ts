import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { reasoningLevels, type Model } from "./model.js";
import { failed, ok, type Result } from "./result.js";

// Which models the desktop app offers and each agent's default for a new chat, as
// `settings get|set models` reads and replaces them in model-settings.json. Only what the person
// changed is saved: a model without a toggle is on when its status is current and off otherwise,
// so a model a refresh adds follows its status until someone flips it.
export type ModelSettings = {
  version: 1;
  /** agent/model to on or off. */
  models: Record<string, boolean>;
  defaults: Record<string, { model: string; effort: string | null }>;
};

export const emptyModelSettings: ModelSettings = { version: 1, models: {}, defaults: {} };
export const modelSettingsFile = "model-settings.json";

const AGENTS = ["claude", "codex", "grok", "agy"];
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseModelSettings(raw: string): Result<ModelSettings> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("models: not valid JSON", 2); }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.models) || !isRecord(value.defaults) || Object.keys(value).some((key) => !["version", "models", "defaults"].includes(key))) {
    return failed("models: expected { version: 1, models, defaults }", 2);
  }
  for (const [key, enabled] of Object.entries(value.models)) {
    const [agent, ...model] = key.split("/");
    if (!AGENTS.includes(agent ?? "") || model.join("/") === "") return failed(`models: ${key} is not agent/model for one of ${AGENTS.join(", ")}`, 2);
    if (typeof enabled !== "boolean") return failed(`models: ${key} must be true or false`, 2);
  }
  for (const [agent, entry] of Object.entries(value.defaults)) {
    if (!AGENTS.includes(agent)) return failed(`models: unknown agent ${agent} (expected ${AGENTS.join(", ")})`, 2);
    if (!isRecord(entry) || typeof entry.model !== "string" || entry.model === "" || Object.keys(entry).some((key) => key !== "model" && key !== "effort")) return failed(`models: the default for ${agent} needs a model`, 2);
    if (entry.effort !== null && !reasoningLevels.includes(entry.effort as (typeof reasoningLevels)[number])) return failed(`models: unknown effort ${String(entry.effort)} for ${agent}`, 2);
  }
  return ok(value as ModelSettings);
}

/** On when the person turned it on, else when the registry calls it current (or says nothing). */
export function modelEnabled(settings: ModelSettings, model: Model): boolean {
  const saved = settings.models[`${model.agent}/${model.model}`];
  if (saved !== undefined) return saved;
  return model.status === undefined || model.status === "current" || model.status === "active";
}

/**
 * What a new chat runs: the model and effort asked for, else the agent's default when that model is
 * still registered and on. A default effort the model does not accept is dropped.
 */
export function startModel(settings: ModelSettings, registry: readonly Model[], agent: string, model: string | undefined, effort: string | undefined): { model: string | undefined; effort: string | undefined } {
  if (model !== undefined) return { model, effort };
  const saved = settings.defaults[agent];
  const entry = saved === undefined ? undefined : registry.find((candidate) => candidate.agent === agent && candidate.model === saved.model);
  if (saved === undefined || entry === undefined || !modelEnabled(settings, entry)) return { model: undefined, effort };
  const defaultEffort = saved.effort !== null && entry.reasoning.levels.includes(saved.effort) ? saved.effort : undefined;
  return { model: saved.model, effort: effort ?? defaultEffort };
}

/** The saved settings in a state directory; nothing saved, or a damaged file, reads as none. */
export async function readModelSettings(stateDirectory: string): Promise<ModelSettings> {
  try {
    const parsed = parseModelSettings(await readFile(join(stateDirectory, modelSettingsFile), "utf8"));
    return parsed.kind === "ok" ? parsed.value : emptyModelSettings;
  } catch {
    return emptyModelSettings;
  }
}
