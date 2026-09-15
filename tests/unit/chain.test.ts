import { describe, expect, test } from "bun:test";
import { selectChain, type ChainConfig } from "../../src/core/chain.js";

const step = { agent: "codex", model: "m", effort: "high" };
const config: ChainConfig = {
  chains: {
    parent: { when: { parentAgent: "codex" }, steps: [step] },
    specific: { when: { parentAgent: "codex", parentEffort: "high" }, steps: [{ ...step, agent: "agy" }] },
  },
  defaultSteps: [{ ...step, agent: "claude" }],
};

describe("chain selection", () => {
  test("prefers explicit chain and most-specific match", () => {
    expect(selectChain(config, "parent", { agent: "codex", effort: "high" }).name).toBe("parent");
    expect(selectChain(config, undefined, { agent: "codex", effort: "high" }).name).toBe("specific");
  });
  test("uses defaults for unknown parent and no match", () => {
    const modelOnly: ChainConfig = { ...config, chains: { model: { when: { parentModel: "known" }, steps: [step] } } };
    expect(selectChain(modelOnly, undefined, { agent: "codex", model: "unknown" }).kind).toBe("default");
    expect(selectChain(config, undefined, { agent: "agy" }).name).toBe("defaultSteps");
  });
  test("reports equal-specificity ambiguity", () => {
    const ambiguous: ChainConfig = { ...config, chains: { a: config.chains.parent, b: config.chains.parent } };
    expect(selectChain(ambiguous, undefined, { agent: "codex" })).toEqual({ kind: "ambiguous", candidates: ["a", "b"] });
  });
});
