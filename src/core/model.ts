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

/** Context window in tokens recorded for a launch model; absent when unknown. */
export function contextWindowOf(registry: ModelRegistry, agent: string, model: string): number | undefined {
  const window = modelEntry(registry, agent, model)?.contextWindow;
  return typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? window : undefined;
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
  if (!["codex", "claude", "agy", "grok"].includes(agent)) return { kind: "invalid", message: `unknown agent: ${agent}` };
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

// The table's fields a curated row may lack; a field the row sets is the person's and stays.
const curatedFillable = ["name", "family", "generation", "status", "description", "contextWindow", "contextWindows"] as const;

/** A curated row with every field it lacks taken from the table, its own fields and levels kept. */
function fillCurated(row: Model, templateModel: Model): Model {
  const missing = curatedFillable.filter((key) => row[key] === undefined && templateModel[key] !== undefined);
  const reasoningDefault = row.reasoning.default === undefined && templateModel.reasoning.default !== undefined;
  if (missing.length === 0 && !reasoningDefault) return row;
  return {
    ...row,
    ...Object.fromEntries(missing.map((key) => [key, templateModel[key]])),
    reasoning: reasoningDefault ? { ...row.reasoning, default: templateModel.reasoning.default } : row.reasoning,
  };
}

// The shipped models.json is the single metadata table. Context-window values come from the
// installed Claude model listing and ~/.codex/models_cache.json; unknown windows stay empty.
export function upgradeRegistry(registry: ModelRegistry, template: ModelRegistry): ModelRegistry {
  let models = [...registry.models];
  for (const templateModel of template.models) {
    const index = models.findIndex((entry) => entry.agent === templateModel.agent && entry.model === templateModel.model);
    if (index < 0) models.push(templateModel);
    else if (models[index].provenance.kind === "curated") models[index] = fillCurated(models[index], templateModel);
    else models[index] = {
      ...models[index], reasoning: templateModel.reasoning, status: templateModel.status,
      contextWindow: templateModel.contextWindow, name: templateModel.name,
      contextWindows: templateModel.contextWindows, description: templateModel.description,
      family: templateModel.family, generation: templateModel.generation,
    };
  }
  return { ...registry, models };
}

// Every level a CLI can name, in order; agy also offers a "thinking" variant of some Claude models.
const levelOrder: readonly string[] = [...reasoningLevels, "thinking"];
const byLevel = (left: string, right: string) => levelOrder.indexOf(left) - levelOrder.indexOf(right);

// A refresh reads what each CLI offers today; what a person choosing needs beyond that (the
// best-for line, family, generation and status) is megabrain's own, kept in the shipped table and
// laid over the live row. A model the table does not know keeps what was derived from its id.
type Curated = Readonly<{ family?: string; generation?: string; status: string; description?: string }>;

function curated(template: readonly Model[], agent: string, model: string, derived: Curated): Curated {
  const entry = template.find((candidate) => candidate.agent === agent && candidate.model === model);
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  const family = text(entry?.family) ?? derived.family;
  const generation = text(entry?.generation) ?? derived.generation;
  const description = text(entry?.description) ?? derived.description;
  return {
    ...(family === undefined ? {} : { family }),
    ...(generation === undefined ? {} : { generation }),
    status: text(entry?.status) ?? derived.status,
    ...(description === undefined ? {} : { description }),
  };
}

const versionOf = (text: string): number[] => text.split(".").map(Number);
function compareVersions(left: string, right: string): number {
  const [a, b] = [versionOf(left), versionOf(right)];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// agy lists one id per reasoning level ("gemini-4-argon-high\tGemini 4 Argon (High)"); an id with
// no level runs at none. The registry keeps one model per base id with the levels it was listed
// at, and launching joins the two back into the id agy listed (agyModelId).
const agyLevel = /-(minimal|low|medium|high|xhigh|max|thinking)$/;

export function agyModelId(model: string, effort: string | null): string {
  return effort === null || effort === "none" || agyLevel.test(model) ? model : `${model}-${effort}`;
}

export function refreshAgyModels(listing: string, obtainedAt: string, template: readonly Model[] = []): readonly Model[] {
  const folded = new Map<string, { name: string | undefined; levels: string[] }>();
  for (const [, id = "", listedName] of listing.matchAll(/^((?:gemini|claude|gpt-oss)-[A-Za-z0-9_.-]+)(?:\t(.*))?$/gm)) {
    const level = agyLevel.exec(id)?.[1];
    const base = level === undefined ? id : id.slice(0, -level.length - 1);
    const entry = folded.get(base) ?? { name: undefined, levels: [] };
    entry.name ??= listedName?.replace(/\s*\([^)]*\)\s*$/, "").trim() || undefined;
    if (!entry.levels.includes(level ?? "none")) entry.levels.push(level ?? "none");
    folded.set(base, entry);
  }
  return [...folded].map(([model, { name, levels }]) => {
    // agy lists only what it offers now, so each listed model is current unless the table says otherwise.
    const [, family = model, generation] = /^(?:claude-)?([a-z]+(?:-[a-z]+)*?)-(\d+(?:[.-]\d+)?)(?=$|-)/.exec(model) ?? [];
    return {
      agent: "agy",
      model,
      ...(name === undefined ? {} : { name }),
      ...curated(template, "agy", model, { family, ...(generation === undefined ? {} : { generation: generation.replace("-", ".") }), status: "current" }),
      reasoning: { separateAxis: true, levels: levels.sort(byLevel) },
      provenance: { kind: "live", command: "agy models", obtainedAt },
    };
  });
}

// `grok models` lists the ids it offers. Their levels, names and windows live in grok's own
// ~/.grok/models_cache.json; without it a refresh keeps the levels the registry already knows for
// an id and falls back to the levels every listed model supports.
const grokFallbackLevels = ["low", "medium", "high"];

type GrokCacheEntry = { name?: unknown; description?: unknown; context_window?: unknown; context_windows?: unknown; reasoning_effort?: unknown; reasoning_efforts?: unknown };

function grokCache(text: string | undefined): Readonly<Record<string, GrokCacheEntry>> {
  try {
    const models = (JSON.parse(text ?? "{}") as { models?: Record<string, { info?: GrokCacheEntry }> }).models ?? {};
    return Object.fromEntries(Object.entries(models).flatMap(([id, value]) => (value?.info === undefined ? [] : [[id, value.info]])));
  } catch {
    return {};
  }
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

// grok-4.7 and grok-4.7-build-fast are generation 4.7 of the grok and grok fast families; the
// newest generation grok lists is current and the rest older.
function grokIdentity(model: string): { family: string; generation?: string } {
  const [, generation, rest = ""] = /^grok-(\d+(?:\.\d+)*)(.*)$/.exec(model) ?? [];
  return { family: /fast/.test(rest) ? "grok fast" : "grok", ...(generation === undefined ? {} : { generation }) };
}

export function refreshGrokModels(listing: string, cacheText: string | undefined, known: readonly Model[], obtainedAt: string, template: readonly Model[] = []): readonly Model[] {
  const ids = [...new Set([...listing.matchAll(/^[ \t]*[*-][ \t]+(grok-[A-Za-z0-9_.-]+)/gm)].map((match) => match[1]!))];
  const cache = grokCache(cacheText);
  const newest = ids.map((model) => grokIdentity(model).generation ?? "0").reduce((top, generation) => (compareVersions(generation, top) > 0 ? generation : top), "0");
  return ids.map((model) => {
    const provenance = { kind: "live", command: "grok models", obtainedAt };
    const identity = grokIdentity(model);
    const status = identity.generation !== undefined && compareVersions(identity.generation, newest) === 0 ? "current" : "older";
    const info = cache[model];
    const cachedLevels = Array.isArray(info?.reasoning_efforts) ? info.reasoning_efforts.map((effort: { id?: unknown }) => effort?.id).filter((id): id is string => typeof id === "string") : [];
    if (info === undefined || cachedLevels.length === 0) {
      const levels = known.find((entry) => entry.agent === "grok" && entry.model === model)?.reasoning.levels ?? grokFallbackLevels;
      return { agent: "grok", model, ...curated(template, "grok", model, { ...identity, status }), reasoning: { separateAxis: true, levels }, provenance };
    }
    const windows = Array.isArray(info.context_windows) ? info.context_windows.filter(positive) : [];
    const level = typeof info.reasoning_effort === "string" && cachedLevels.includes(info.reasoning_effort) ? info.reasoning_effort : undefined;
    return {
      agent: "grok",
      model,
      ...(typeof info.name === "string" ? { name: info.name } : {}),
      ...curated(template, "grok", model, { ...identity, status, ...(typeof info.description === "string" ? { description: info.description } : {}) }),
      ...(positive(info.context_window) ? { contextWindow: info.context_window } : {}),
      ...(windows.length > 0 ? { contextWindows: windows } : {}),
      reasoning: { separateAxis: true, levels: cachedLevels.sort(byLevel), ...(level === undefined ? {} : { default: level }) },
      provenance,
    };
  });
}

// Codex keeps what it offers in ~/.codex/models_cache.json: each model's slug, display name, the
// reasoning levels it accepts and its default, its window, and whether the picker lists it at all
// (internal models are hidden). Its own description says when a model is older ("Older generation
// workhorse model.", "Previous generation...").
type CodexCacheEntry = { slug?: unknown; display_name?: unknown; description?: unknown; visibility?: unknown; context_window?: unknown; default_reasoning_level?: unknown; supported_reasoning_levels?: unknown };

export function refreshCodexModels(cacheText: string | undefined, template: readonly Model[], obtainedAt: string): readonly Model[] {
  let listed: CodexCacheEntry[];
  try {
    const models = (JSON.parse(cacheText ?? "") as { models?: unknown }).models;
    listed = Array.isArray(models) ? models.filter((entry): entry is CodexCacheEntry => typeof entry === "object" && entry !== null && (entry as CodexCacheEntry).visibility === "list") : [];
  } catch {
    return [];
  }
  return listed.flatMap((info) => {
    if (typeof info.slug !== "string" || info.slug === "") return [];
    const model = info.slug;
    const levels = Array.isArray(info.supported_reasoning_levels) ? info.supported_reasoning_levels.map((level: { effort?: unknown }) => level?.effort).filter((effort): effort is string => typeof effort === "string").sort(byLevel) : [];
    const [, generation, family = "gpt"] = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z]+))?/.exec(model) ?? [];
    const own = typeof info.description === "string" ? info.description : undefined;
    const name = typeof info.display_name === "string" ? info.display_name.replace(/^(GPT-[\d.]+)-/, "$1 ") : undefined;
    const fallback = typeof info.default_reasoning_level === "string" && levels.includes(info.default_reasoning_level) ? info.default_reasoning_level : undefined;
    return [{
      agent: "codex",
      model,
      ...(name === undefined ? {} : { name }),
      ...curated(template, "codex", model, { family, ...(generation === undefined ? {} : { generation }), status: own !== undefined && /^(Older|Previous)\b/.test(own) ? "older" : "current", ...(own === undefined ? {} : { description: own }) }),
      ...(positive(info.context_window) ? { contextWindow: info.context_window, contextWindows: [info.context_window] } : {}),
      reasoning: { separateAxis: true, levels, ...(fallback === undefined ? {} : { default: fallback }) },
      provenance: { kind: "live", command: "~/.codex/models_cache.json", obtainedAt },
    }];
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

/** The shipped table, for what a refresh lays over a live listing; empty when it cannot be read. */
export function readTemplateModels(environment: ModelEnvironment): readonly Model[] {
  try {
    return parseModelRegistry(readFileSync(modelRegistryPaths(environment).template, "utf8"))?.models ?? [];
  } catch {
    return [];
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
