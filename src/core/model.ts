import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadModels, saveModels, stateDatabase } from "../adapters/state-db.js";
import { failed, type Failed, type Result } from "./result.js";
import type { StateEnvironment } from "./state.js";
import { resolvePackageRoot } from "./package-root.js";

export type ModelProvenance = Readonly<Record<string, unknown>>;

export type Model = {
  readonly agent: string;
  readonly model: string;
  readonly reasoning: {
    readonly separateAxis: boolean;
    readonly levels: readonly string[];
    readonly [key: string]: unknown;
  };
  readonly provenance: ModelProvenance;
  readonly [key: string]: unknown;
};

export type ModelRegistry = {
  readonly version: 1;
  readonly models: readonly Model[];
  readonly [key: string]: unknown;
};

export type ModelOperationResult =
  | { readonly kind: "ok"; readonly value: ModelRegistry }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "unknown" };

export type ReasoningResult =
  | { readonly kind: "valid" }
  | { readonly kind: "unknown" }
  | { readonly kind: "invalid"; readonly message: string };

export const reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

function modelEntry(registry: ModelRegistry, agent: string, model: string): Model | undefined {
  return registry.models.find((entry) => entry.agent === agent && entry.model === model);
}

export function validateReasoning(
  registry: ModelRegistry,
  agent: string,
  model: string,
  effort: string | undefined,
): ReasoningResult {
  const entry = modelEntry(registry, agent, model);
  if (entry === undefined) return { kind: "unknown" };
  if (!entry.reasoning.separateAxis) {
    return effort === undefined || effort.length === 0
      ? { kind: "valid" }
      : { kind: "invalid", message: `model '${model}' for agent '${agent}' has effort as part of the model id; do not supply effort` };
  }
  if (effort === undefined || effort.length === 0) {
    return { kind: "invalid", message: `model '${model}' for agent '${agent}' requires a separate reasoning level` };
  }
  if (!entry.reasoning.levels.includes(effort)) {
    const supported = entry.reasoning.levels.length === 0 ? "  none" : entry.reasoning.levels.map((level) => `  ${level}`).join("\n");
    return { kind: "invalid", message: `model '${model}' for agent '${agent}' does not support reasoning level '${effort}'. Supported reasoning levels:\n${supported}` };
  }
  return { kind: "valid" };
}

export function addModel(
  registry: ModelRegistry,
  agent: string,
  model: string,
  levels: string,
  obtainedAt: string,
): ModelOperationResult {
  if (!["codex", "claude", "agy"].includes(agent)) return { kind: "invalid", message: `unknown agent: ${agent}` };
  if (model.length === 0) return { kind: "invalid", message: "model id cannot be empty" };
  if (levels.length === 0) return { kind: "invalid", message: "reasoning levels cannot be empty" };
  const parsedLevels = levels.split(",");
  for (const level of parsedLevels) {
    if (level.length === 0) return { kind: "invalid", message: "reasoning levels cannot contain empty values" };
    if (!reasoningLevels.includes(level as (typeof reasoningLevels)[number])) return { kind: "invalid", message: `unknown reasoning level: ${level}` };
  }
  if (modelEntry(registry, agent, model) !== undefined) return { kind: "invalid", message: `model already registered for agent '${agent}': ${model}` };
  const entry: Model = {
    agent,
    model,
    reasoning: { separateAxis: true, levels: parsedLevels },
    provenance: { kind: "curated", method: "manual curation", obtainedAt },
  };
  return { kind: "ok", value: { ...registry, models: [...registry.models, entry] } };
}

export function upgradeRegistry(registry: ModelRegistry, template: ModelRegistry): ModelRegistry {
  let models = [...registry.models];
  for (const templateModel of template.models) {
    const index = models.findIndex((entry) => entry.agent === templateModel.agent && entry.model === templateModel.model);
    if (index < 0) models.push(templateModel);
    else if (models[index].provenance.kind !== "curated") models[index] = { ...models[index], reasoning: templateModel.reasoning, status: templateModel.status };
  }
  return { ...registry, models };
}

export function refreshAgyModels(ids: readonly string[], obtainedAt: string): readonly Model[] {
  const models = [...new Set(ids.filter((id) => /^(gemini|claude|gpt-oss)-[A-Za-z0-9_.-]+$/.test(id)))].sort();
  return models.map((model) => {
    const level = model.endsWith("-high") ? "high" : model.endsWith("-medium") ? "medium" : model.endsWith("-low") ? "low" : "none";
    return { agent: "agy", model, reasoning: { separateAxis: false, levels: [level] }, provenance: { kind: "live", command: "agy models", obtainedAt } };
  });
}

export type ModelEnvironment = StateEnvironment & Readonly<{
  readonly MEGABRAIN_ROOT?: string;
}>;

export function modelRegistryPaths(environment: ModelEnvironment): { readonly template: string } {
  const root = resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT);
  return { template: resolve(root, ".megabrain/models.json") };
}

function isModelEntry(value: unknown): value is Model {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const reasoning = entry.reasoning;
  if (typeof entry.agent !== "string" || typeof entry.model !== "string" || typeof entry.provenance !== "object" || entry.provenance === null || typeof reasoning !== "object" || reasoning === null) return false;
  const reasoningRecord = reasoning as Record<string, unknown>;
  const levels = reasoningRecord.levels;
  return typeof reasoningRecord.separateAxis === "boolean" && Array.isArray(levels) && levels.every((level: unknown) => typeof level === "string");
}

export function parseModelRegistry(text: string): ModelRegistry | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const registry = value as Record<string, unknown>;
    return registry.version === 1 && Array.isArray(registry.models) && registry.models.every(isModelEntry) ? value as ModelRegistry : undefined;
  } catch {
    return undefined;
  }
}

export type LoadedModelRegistry = Readonly<{ readonly kind: "loaded"; readonly registry: ModelRegistry; readonly raw: string }>;

export function loadModelRegistry(environment: ModelEnvironment): LoadedModelRegistry | Failed {
  const { template } = modelRegistryPaths(environment);
  try {
    if (!existsSync(template)) return failed(`model registry template is missing: ${template}`);
    const templateRaw = readFileSync(template, "utf8");
    const templateRegistry = parseModelRegistry(templateRaw);
    if (templateRegistry === undefined) return failed(`model registry template is not valid JSON: ${template}`);
    const opened = stateDatabase(environment);
    if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
    let registry: ModelRegistry;
    let storedEmpty = false;
    const loaded = loadModels(opened.value);
    if (loaded.kind !== "ok") return failed(loaded.error, loaded.exitCode);
    if (loaded.value.models.length === 0) { registry = templateRegistry; storedEmpty = true; }
    else {
      const parsed = parseModelRegistry(JSON.stringify(loaded.value));
      if (parsed === undefined) return failed("model registry stored in database is invalid");
      registry = parsed;
    }
    const upgraded = upgradeRegistry(registry, templateRegistry);
    const upgradedRaw = `${JSON.stringify(upgraded, null, 2)}\n`;
    const currentRaw = `${JSON.stringify(registry, null, 2)}\n`;
    if (storedEmpty || upgradedRaw !== currentRaw) {
      const saved = saveModelRegistry(environment, upgraded);
      if (saved.kind !== "ok") return failed(saved.error, saved.exitCode);
    }
    return { kind: "loaded", registry: upgraded, raw: upgradedRaw };
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : "could not read model registry");
  }
}

export function saveModelRegistry(environment: ModelEnvironment, registry: ModelRegistry): Result<void> {
  const opened = stateDatabase(environment);
  if (opened.kind !== "ok") return failed(opened.error, opened.exitCode);
  const saved = saveModels(opened.value, registry);
  return saved.kind === "ok" ? { kind: "ok", value: undefined } : saved;
}

export function formatModelList(registry: ModelRegistry): string {
  const line = (values: readonly string[]) => values.map((value, index) => index < 5 ? value.padEnd([10, 38, 16, 11, 18][index]) : value).join(" ");
  const rows = [line(["AGENT", "MODEL", "REASONING", "STATUS", "MODEL-PROVENANCE", "EFFORT-PROVENANCE"])];
  for (const entry of registry.models) {
    const provenance = entry.provenance;
    const date = typeof provenance.fetchedAt === "string" ? provenance.fetchedAt : typeof provenance.obtainedAt === "string" ? provenance.obtainedAt : "undated";
    rows.push(line([
      entry.agent,
      entry.model,
      entry.reasoning.levels.join(","),
      typeof entry.status === "string" ? entry.status : "active",
      `${typeof provenance.kind === "string" ? provenance.kind : "unknown"} (${date})`,
      typeof entry.reasoning.provenance === "object" && entry.reasoning.provenance !== null && typeof (entry.reasoning.provenance as Record<string, unknown>).kind === "string" ? (entry.reasoning.provenance as Record<string, unknown>).kind as string : "unknown",
    ]));
  }
  return `${rows.join("\n")}\n`;
}
