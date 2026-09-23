import { describe, expect, test } from "bun:test";
import {
  addModel,
  formatModelList,
  refreshAgyModels,
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

  test("refreshes agy ids, sorts and infers embedded levels", () => {
    expect(refreshAgyModels(["noise", "gemini-z-high", "gemini-a-low", "gemini-z-high"], "now")).toEqual([
      { agent: "agy", model: "gemini-a-low", reasoning: { separateAxis: false, levels: ["low"] }, provenance: { kind: "live", command: "agy models", obtainedAt: "now" } },
      { agent: "agy", model: "gemini-z-high", reasoning: { separateAxis: false, levels: ["high"] }, provenance: { kind: "live", command: "agy models", obtainedAt: "now" } },
    ]);
  });

  test("formats the human-readable registry table", () => {
    expect(formatModelList(registry)).toContain("AGENT      MODEL");
    expect(formatModelList(registry)).toContain("codex      separate");
  });
});
