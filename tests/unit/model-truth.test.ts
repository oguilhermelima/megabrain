import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseModelRegistry,
  refreshAgyModels,
  refreshCodexModels,
  refreshGrokModels,
  type Model,
  type ModelRegistry,
} from "../../src/core/model.js";

// What each agent's own CLI says it offers, captured and redacted to the fields megabrain reads:
// codex 0.162.1 (~/.codex/models_cache.json, 2026-10-17), grok 1.0.52 (~/.grok/models_cache.json),
// agy 1.4.0 (agy models).
const fixture = (name: string) => readFileSync(new URL(`../fixtures/models/${name}`, import.meta.url), "utf8");

function shipped(): ModelRegistry {
  const registry = parseModelRegistry(readFileSync(new URL("../../.megabrain/models.json", import.meta.url), "utf8"));
  if (registry === undefined) throw new Error("shipped registry does not parse");
  return registry;
}

const of = (agent: string, registry: ModelRegistry = shipped()) => registry.models.filter((entry) => entry.agent === agent);
const find = (agent: string, model: string, registry: ModelRegistry = shipped()) => registry.models.find((entry) => entry.agent === agent && entry.model === model);
const ids = (models: readonly Model[], status: string) => models.filter((entry) => entry.status === status).map((entry) => entry.model);

type CodexCacheModel = { slug: string; display_name: string; visibility: string; context_window: number; default_reasoning_level: string; supported_reasoning_levels: { effort: string }[] };
const codexCache = JSON.parse(fixture("codex-models-cache.json")) as { models: CodexCacheModel[] };
const listedCodex = codexCache.models.filter((entry) => entry.visibility === "list");

// No source gives these a version: agy lists GPT-OSS by size and Mythos Preview predates the numbered Mythos line.
const unversioned = new Set(["gpt-oss-120b", "claude-mythos-preview"]);

describe("every shipped model describes itself for a person choosing", () => {
  test("each has a display name, family, generation, status, best-for line and the reasoning levels it accepts", () => {
    for (const entry of shipped().models) {
      const label = `${entry.agent}/${entry.model}`;
      expect({ label, name: typeof entry.name === "string" && entry.name !== "" && entry.name !== entry.model }).toEqual({ label, name: true });
      expect({ label, family: typeof entry.family === "string" && entry.family !== "" }).toEqual({ label, family: true });
      expect({ label, generation: typeof entry.generation === "string" && /^\d+(\.\d+)*$/.test(entry.generation as string) }).toEqual({ label, generation: !unversioned.has(entry.model) });
      expect({ label, status: ["current", "older", "deprecated"].includes(entry.status as string) }).toEqual({ label, status: true });
      expect({ label, description: typeof entry.description === "string" && (entry.description as string).length >= 12 && (entry.description as string).length <= 60 }).toEqual({ label, description: true });
    }
  });

  test("every model outside agy, which reports no windows, carries its context windows", () => {
    for (const entry of shipped().models.filter((model) => model.agent !== "agy")) {
      expect({ model: entry.model, windows: Array.isArray(entry.contextWindows) && (entry.contextWindows as unknown[]).length > 0 }).toEqual({ model: entry.model, windows: true });
    }
  });

  test("no model offers a level no source lists: minimal is gone everywhere", () => {
    expect(shipped().models.filter((entry) => entry.reasoning.levels.includes("minimal")).map((entry) => entry.model)).toEqual([]);
  });
});

describe("claude", () => {
  test("the 5.5 family is current, earlier releases older, the retiring ones deprecated", () => {
    const claude = of("claude");
    expect(ids(claude, "current").sort()).toEqual(["claude-fable-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(ids(claude, "older").sort()).toEqual([
      "claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8",
      "claude-opus-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-6", "claude-sonnet-5",
    ]);
    expect(ids(claude, "deprecated").sort()).toEqual([
      "claude-3-5-haiku-20241022", "claude-3-7-sonnet-20250219", "claude-3-haiku-20240307", "claude-mythos-preview", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-sonnet-4-20250514",
    ]);
  });

  test("names read as people say them", () => {
    expect(find("claude", "claude-opus-5-5")).toMatchObject({ name: "Opus 5.5", family: "opus", generation: "5.5" });
    expect(find("claude", "claude-haiku-4-5-20251001")).toMatchObject({ name: "Haiku 4.5", family: "haiku", generation: "4.5" });
    expect(find("claude", "claude-3-7-sonnet-20250219")).toMatchObject({ name: "Sonnet 3.7", family: "sonnet", generation: "3.7" });
  });

  test("each model accepts the effort levels the Claude API lists for it, not one shared set", () => {
    const five = ["low", "medium", "high", "xhigh", "max"];
    for (const id of ["claude-fable-5-5", "claude-fable-5-1", "claude-fable-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5-5", "claude-sonnet-5", "claude-haiku-5-5"]) {
      expect({ id, levels: find("claude", id)?.reasoning.levels }).toEqual({ id, levels: five });
    }
    // xhigh arrived with Opus 4.7; Opus 4.6 and Sonnet 4.6 stop at max without it.
    expect(find("claude", "claude-opus-4-6")?.reasoning.levels).toEqual(["low", "medium", "high", "max"]);
    expect(find("claude", "claude-sonnet-4-6")?.reasoning.levels).toEqual(["low", "medium", "high", "max"]);
    expect(find("claude", "claude-opus-4-5-20251101")?.reasoning.levels).toEqual(["low", "medium", "high"]);
    // Effort errors on these: the model takes none, so megabrain must not pass one.
    for (const id of ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-haiku-20240307", "claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"]) {
      expect({ id, reasoning: find("claude", id)?.reasoning }).toMatchObject({ id, reasoning: { separateAxis: false, levels: [] } });
    }
  });

  test("the default effort is medium on Opus 5.5 and Haiku 5.5 and high on the other 5.5 models", () => {
    expect(find("claude", "claude-opus-5-5")?.reasoning.default).toBe("medium");
    expect(find("claude", "claude-haiku-5-5")?.reasoning.default).toBe("medium");
    expect(find("claude", "claude-sonnet-5-5")?.reasoning.default).toBe("high");
  });

  test("the current models open 1M windows; Haiku 4.5 and Opus 4.5 stay at 200k", () => {
    for (const id of ["claude-fable-5-5", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) expect(find("claude", id)?.contextWindows).toEqual([200000, 1000000]);
    expect(find("claude", "claude-haiku-4-5-20251001")?.contextWindows).toEqual([200000]);
    expect(find("claude", "claude-opus-4-5-20251101")?.contextWindows).toEqual([200000]);
  });
});

describe("codex", () => {
  const refreshed = refreshCodexModels(fixture("codex-models-cache.json"), of("codex"), "now");

  test("a refresh lists exactly the models codex shows, hiding its internal ones", () => {
    expect(refreshed.map((entry) => entry.model)).toEqual(listedCodex.map((entry) => entry.slug));
    expect(refreshed.map((entry) => entry.model)).not.toContain("gpt-reserve");
    expect(refreshed.map((entry) => entry.model)).not.toContain("codex-auto-review");
  });

  test("each refreshed model has codex's own levels, default effort, window and a readable name", () => {
    for (const source of listedCodex) {
      const entry = refreshed.find((model) => model.model === source.slug);
      expect({ id: source.slug, levels: entry?.reasoning.levels, default: entry?.reasoning.default, windows: entry?.contextWindows }).toEqual({
        id: source.slug,
        levels: source.supported_reasoning_levels.map((level) => level.effort),
        default: source.default_reasoning_level,
        windows: [source.context_window],
      });
    }
    expect(refreshed.find((entry) => entry.model === "gpt-6.1-sol")).toMatchObject({ name: "GPT-6.1 Sol", family: "sol", generation: "6.1", provenance: { kind: "live", command: "~/.codex/models_cache.json", obtainedAt: "now" } });
    expect(refreshed.find((entry) => entry.model === "gpt-5.6-terra")).toMatchObject({ name: "GPT-5.6 Terra", family: "terra", generation: "5.6" });
  });

  test("codex's own words decide current or older; the best-for line is megabrain's", () => {
    expect(ids(refreshed, "current")).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]);
    expect(ids(refreshed, "older")).toEqual(["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    expect(refreshed.find((entry) => entry.model === "gpt-6-astra")?.description).toBe(find("codex", "gpt-6-astra")?.description);
  });

  test("a model the template does not know keeps codex's own description", () => {
    const text = JSON.stringify({ models: [{ slug: "gpt-7-nova", display_name: "GPT-7-Nova", description: "Brand new.", visibility: "list", priority: 1, default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], context_window: 300000 }] });
    expect(refreshCodexModels(text, [], "now")).toEqual([{
      agent: "codex", model: "gpt-7-nova", name: "GPT-7 Nova", family: "nova", generation: "7", status: "current", description: "Brand new.", contextWindow: 300000, contextWindows: [300000],
      reasoning: { separateAxis: true, levels: ["low", "high"], default: "low" }, provenance: { kind: "live", command: "~/.codex/models_cache.json", obtainedAt: "now" },
    }]);
    expect(refreshCodexModels(undefined, [], "now")).toEqual([]);
    expect(refreshCodexModels("not json", [], "now")).toEqual([]);
  });

  test("the shipped table matches codex's list, and keeps the models codex dropped as deprecated", () => {
    const codex = of("codex");
    for (const fresh of refreshed) {
      const entry = codex.find((model) => model.model === fresh.model);
      expect({ id: fresh.model, name: entry?.name, levels: entry?.reasoning.levels, status: entry?.status, windows: entry?.contextWindows }).toEqual({ id: fresh.model, name: fresh.name, levels: fresh.reasoning.levels, status: fresh.status, windows: fresh.contextWindows });
    }
    expect(ids(codex, "deprecated").sort()).toEqual(["gpt-5.2", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini", "gpt-5.5"]);
  });
});

describe("grok", () => {
  const refreshed = refreshGrokModels(fixture("grok-models.txt"), fixture("grok-models-cache.json"), [], "now", of("grok"));

  test("the newest generation is current and the rest older", () => {
    expect(ids(refreshed, "current")).toEqual(["grok-4.7", "grok-4.7-build-fast"]);
    expect(ids(refreshed, "older")).toEqual(["grok-4.6", "grok-4.5"]);
  });

  test("names, families and levels come from grok's cache, the best-for line from megabrain's table", () => {
    expect(refreshed.find((entry) => entry.model === "grok-4.7")).toMatchObject({ name: "Grok 4.7", family: "grok", generation: "4.7", reasoning: { levels: ["low", "medium", "high", "xhigh"], default: "high" } });
    expect(refreshed.find((entry) => entry.model === "grok-4.7-build-fast")).toMatchObject({ family: "grok fast", generation: "4.7" });
    expect(refreshed.find((entry) => entry.model === "grok-4.5")?.reasoning.levels).toEqual(["low", "medium", "high"]);
    expect(refreshed.find((entry) => entry.model === "grok-4.7")?.description).toBe(find("grok", "grok-4.7")?.description);
  });
});

describe("agy", () => {
  const refreshed = refreshAgyModels(fixture("agy-models.txt"), "now", of("agy"));

  test("every model agy lists is current, with megabrain's best-for line and family", () => {
    expect(ids(refreshed, "current")).toEqual(["gemini-4-argon", "gemini-3.8-flash", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b"]);
    expect(refreshed.find((entry) => entry.model === "gemini-3.8-flash")).toMatchObject({ name: "Gemini 3.8 Flash", family: "gemini flash", generation: "3.8" });
    expect(refreshed.find((entry) => entry.model === "claude-opus-5-5")?.description).toBe(find("agy", "claude-opus-5-5")?.description);
  });
});
