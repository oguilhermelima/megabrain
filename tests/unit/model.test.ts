import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  addModel,
  contextWindowOf,
  parseModelRegistry,
  formatModelList,
  refreshAgyModels,
  refreshGrokModels,
  upgradeRegistry,
  validateReasoning,
  type ModelRegistry,
} from "../../src/core/model.js";

const registry: ModelRegistry = {
  version: 1,
  models: [
    { agent: "codex", model: "separate", reasoning: { separateAxis: true, levels: ["low", "high"] }, provenance: { kind: "sourced" } },
    { agent: "agy", model: "embedded-high", reasoning: { separateAxis: false, levels: ["high"] }, provenance: { kind: "live" } },
  ],
};

describe("validateReasoning", () => {
  test("requires and accepts a supported separate effort", () => {
    expect(validateReasoning(registry, "codex", "separate", "high")).toEqual({ kind: "valid" });
    expect(validateReasoning(registry, "codex", "separate", undefined)).toEqual({
      kind: "invalid",
      message: "model 'separate' for agent 'codex' requires a separate reasoning level",
    });
    expect(validateReasoning(registry, "codex", "separate", "medium").kind).toBe("invalid");
  });

  test("rejects effort for an embedded model and unknown models", () => {
    expect(validateReasoning(registry, "agy", "embedded-high", "high").message).toContain("effort as part");
    expect(validateReasoning(registry, "agy", "embedded-high", undefined)).toEqual({ kind: "valid" });
    expect(validateReasoning(registry, "codex", "missing", undefined)).toEqual({ kind: "unknown" });
  });
});

describe("registry operations", () => {
  test("adds a curated model and rejects invalid input", () => {
    const added = addModel(registry, "claude", "new-model", "low,high", "2026-09-14");
    expect(added.kind).toBe("ok");
    if (added.kind === "ok") {
      expect(added.value.models.at(-1)).toEqual({
        agent: "claude",
        model: "new-model",
        reasoning: { separateAxis: true, levels: ["low", "high"] },
        provenance: { kind: "curated", method: "manual curation", obtainedAt: "2026-09-14" },
      });
    }
    expect(addModel(registry, "unknown", "model", "low", "now").kind).toBe("invalid");
    expect(addModel(registry, "codex", "", "low", "now").kind).toBe("invalid");
    expect(addModel(registry, "codex", "model", "low,,high", "now").kind).toBe("invalid");
    expect(addModel(registry, "codex", "separate", "low", "now").kind).toBe("invalid");
  });

  test("upgrades missing entries but preserves curated entries", () => {
    const template: ModelRegistry = {
      version: 1,
      models: [
        { agent: "codex", model: "separate", reasoning: { separateAxis: true, levels: ["low", "high"] }, provenance: { kind: "sourced" } },
        { agent: "claude", model: "template", reasoning: { separateAxis: true, levels: ["medium"] }, provenance: { kind: "sourced" } },
      ],
    };
    const upgraded = upgradeRegistry({ ...registry, models: [{ ...registry.models[0], provenance: { kind: "curated", obtainedAt: "old" } }] }, template);
    expect(upgraded.models).toHaveLength(2);
    expect(upgraded.models[0].provenance).toEqual({ kind: "curated", obtainedAt: "old" });
    expect(upgraded.models[1].agent).toBe("claude");
  });

  test("carries the template's status into a non-curated row and leaves a curated row alone", () => {
    const template: ModelRegistry = {
      version: 1,
      models: [
        { agent: "codex", model: "separate", reasoning: { separateAxis: true, levels: ["low", "high"] }, provenance: { kind: "sourced" }, status: "retired" },
      ],
    };
    const sourcedState: ModelRegistry = { ...registry, models: [{ ...registry.models[0], provenance: { kind: "sourced" } }] };
    const upgraded = upgradeRegistry(sourcedState, template);
    expect(upgraded.models[0].status).toBe("retired");

    const curatedState: ModelRegistry = { ...registry, models: [{ ...registry.models[0], provenance: { kind: "curated", obtainedAt: "old" } }] };
    const untouched = upgradeRegistry(curatedState, template);
    expect(untouched.models[0].status).toBeUndefined();
  });

  test("folds agy's listing into one model per base id with its reasoning levels", () => {
    const listing = readFileSync(new URL("../fixtures/models/agy-models.txt", import.meta.url), "utf8");
    const models = refreshAgyModels(listing, "now");
    expect(models.map((entry) => [entry.model, entry.name, entry.reasoning.levels])).toEqual([
      ["gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
      ["gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]],
      ["claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high"]],
      ["claude-sonnet-5-5", "Claude Sonnet 5.5", ["low", "medium", "high"]],
      ["gpt-oss-120b", "GPT-OSS 120B", ["medium"]],
    ]);
    expect(models.every((entry) => entry.agent === "agy" && entry.reasoning.separateAxis)).toBe(true);
    expect(models[0]?.provenance).toEqual({ kind: "live", command: "agy models", obtainedAt: "now" });
  });

  test("an agy id without a level runs at none and a thinking variant is a level of its base", () => {
    const listing = "claude-sonnet-4-6\tClaude Sonnet 4.6\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\nclaude-opus-4-6\tClaude Opus 4.6\nnoise line\n";
    expect(refreshAgyModels(listing, "now").map((entry) => [entry.model, entry.reasoning.levels])).toEqual([
      ["claude-sonnet-4-6", ["none"]],
      ["claude-opus-4-6", ["none", "thinking"]],
    ]);
    expect(refreshAgyModels("Fetching available models...\n", "now")).toEqual([]);
  });

  test("refreshes grok from its listing, with levels, names and windows from grok's own model cache", () => {
    const listing = readFileSync(new URL("../fixtures/models/grok-models.txt", import.meta.url), "utf8");
    const cache = readFileSync(new URL("../fixtures/models/grok-models-cache.json", import.meta.url), "utf8");
    const models = refreshGrokModels(listing, cache, [], "now");
    expect(models.map((entry) => [entry.model, entry.name, entry.reasoning.levels, entry.contextWindows])).toEqual([
      ["grok-4.7", "Grok 4.7", ["low", "medium", "high", "xhigh"], [256000, 500000]],
      ["grok-4.7-build-fast", "Grok 4.7 Fast", ["low", "medium", "high", "xhigh"], [256000, 500000]],
      ["grok-4.6", "Grok 4.6", ["low", "medium", "high", "xhigh"], [256000, 500000]],
      ["grok-4.5", "Grok 4.5", ["low", "medium", "high"], [256000, 500000]],
    ]);
    expect(models[0]).toMatchObject({ agent: "grok", contextWindow: 256000, description: "SpaceXAI's latest frontier model", reasoning: { separateAxis: true }, provenance: { kind: "live", command: "grok models", obtainedAt: "now" } });
  });

  test("without grok's cache a refresh keeps the levels it knows and falls back to the common ones", () => {
    const listing = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.5\n";
    const known = [{ agent: "grok", model: "grok-4.5", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "live" } }];
    expect(refreshGrokModels(listing, undefined, known, "now")).toEqual([
      { agent: "grok", model: "grok-4.7", family: "grok", generation: "4.7", status: "current", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "live", command: "grok models", obtainedAt: "now" } },
      { agent: "grok", model: "grok-4.7-build-fast", family: "grok fast", generation: "4.7", status: "current", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "live", command: "grok models", obtainedAt: "now" } },
      { agent: "grok", model: "grok-4.5", family: "grok", generation: "4.5", status: "older", reasoning: { separateAxis: true, levels: ["low", "medium", "high"] }, provenance: { kind: "live", command: "grok models", obtainedAt: "now" } },
    ]);
    expect(refreshGrokModels("not logged in", "{}", [], "now")).toEqual([]);
  });

  test("grok models can be added by hand and need a separate reasoning level", () => {
    const added = addModel(registry, "grok", "grok-5", "low,high", "now");
    expect(added.kind).toBe("ok");
  });

  test("the shipped registry template carries the grok models with their measured levels and windows", () => {
    const template = parseModelRegistry(readFileSync(new URL("../../.megabrain/models.json", import.meta.url), "utf8"));
    const grok = (template?.models ?? []).filter((entry) => entry.agent === "grok");
    expect(grok.map((entry) => entry.model).sort()).toEqual(["grok-4.5", "grok-4.6", "grok-4.7", "grok-4.7-build-fast"]);
    expect(grok.find((entry) => entry.model === "grok-4.7")?.reasoning.levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(grok.find((entry) => entry.model === "grok-4.5")?.reasoning.levels).toEqual(["low", "medium", "high"]);
    expect(grok.every((entry) => entry.reasoning.separateAxis)).toBe(true);
    expect(grok.every((entry) => JSON.stringify(entry.contextWindows) === "[256000,500000]")).toBe(true);
  });

  test("the shipped registry template carries agy's models folded, as agy 1.4.0 lists them", () => {
    const template = parseModelRegistry(readFileSync(new URL("../../.megabrain/models.json", import.meta.url), "utf8"));
    const listing = readFileSync(new URL("../fixtures/models/agy-models.txt", import.meta.url), "utf8");
    const agy = (template?.models ?? []).filter((entry) => entry.agent === "agy");
    expect(agy.map((entry) => [entry.model, entry.reasoning.levels])).toEqual(refreshAgyModels(listing, "now").map((entry) => [entry.model, entry.reasoning.levels]));
  });

  test("formats the human-readable registry table", () => {
    expect(formatModelList(registry)).toContain("AGENT      MODEL");
    expect(formatModelList(registry)).toContain("codex      separate");
  });
});

describe("context window", () => {
  const windowed: ModelRegistry = {
    version: 1,
    models: [
      { agent: "claude", model: "with-window", reasoning: { separateAxis: true, levels: ["low"] }, provenance: { kind: "sourced" }, contextWindow: 1000000 },
      { agent: "claude", model: "without-window", reasoning: { separateAxis: true, levels: ["low"] }, provenance: { kind: "sourced" } },
      { agent: "claude", model: "bad-window", reasoning: { separateAxis: true, levels: ["low"] }, provenance: { kind: "sourced" }, contextWindow: -5 },
    ],
  };

  test("is read from the registry entry and is absent when unknown, invalid or unregistered", () => {
    expect(contextWindowOf(windowed, "claude", "with-window")).toBe(1000000);
    expect(contextWindowOf(windowed, "claude", "without-window")).toBeUndefined();
    expect(contextWindowOf(windowed, "claude", "bad-window")).toBeUndefined();
    expect(contextWindowOf(windowed, "claude", "missing")).toBeUndefined();
    expect(contextWindowOf(windowed, "codex", "with-window")).toBeUndefined();
  });

  test("a non-curated row takes the template window and a curated row keeps its own", () => {
    const state: ModelRegistry = { version: 1, models: [{ ...windowed.models[1], provenance: { kind: "sourced" } }] };
    const template: ModelRegistry = { version: 1, models: [{ ...windowed.models[1], contextWindow: 1000000 }] };
    expect(contextWindowOf(upgradeRegistry(state, template), "claude", "without-window")).toBe(1000000);
    const curated: ModelRegistry = { version: 1, models: [{ ...windowed.models[1], provenance: { kind: "curated", obtainedAt: "old" } }] };
    expect(contextWindowOf(upgradeRegistry(curated, template), "claude", "without-window")).toBeUndefined();
  });

  test("the shipped registry sets the measured 1M window for the Claude models megabrain launches", () => {
    const shipped = parseModelRegistry(readFileSync(new URL("../../.megabrain/models.json", import.meta.url), "utf8"));
    if (shipped === undefined) throw new Error("shipped registry does not parse");
    expect(contextWindowOf(shipped, "claude", "claude-opus-5-5")).toBe(1000000);
    expect(contextWindowOf(shipped, "claude", "claude-sonnet-5")).toBe(1000000);
    expect(contextWindowOf(shipped, "claude", "claude-sonnet-5-5")).toBe(1000000);
    expect(contextWindowOf(shipped, "claude", "claude-haiku-4-5-20251001")).toBe(200000);
    expect(contextWindowOf(shipped, "claude", "claude-opus-4-1-20250805")).toBeUndefined();
  });

  test("the shipped models expose names and supported context windows, and leave main versus older to the app", () => {
    const shipped = parseModelRegistry(readFileSync(new URL("../../.megabrain/models.json", import.meta.url), "utf8"));
    if (shipped === undefined) throw new Error("shipped registry does not parse");
    for (const id of ["claude-haiku-5-5", "claude-fable-5-5"]) {
      const entry = shipped.models.find((model) => model.agent === "claude" && model.model === id);
      expect(entry).toMatchObject({ name: expect.any(String), contextWindows: [200000, 1000000] });
      expect(entry?.reasoning.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
    expect(shipped.models.find((model) => model.agent === "claude" && model.model === "claude-opus-5-5")).toMatchObject({ name: "Opus 5.5", contextWindows: [200000, 1000000] });
    expect(shipped.models.find((model) => model.agent === "claude" && model.model === "claude-haiku-4-5-20251001")).toMatchObject({ contextWindows: [200000] });
    expect(shipped.models.some((model) => "current" in model)).toBe(false);
    expect(shipped.models.filter((model) => model.agent === "codex").every((model) => Array.isArray(model.contextWindows) && model.contextWindows.length > 0)).toBe(true);
  });
});
