import { describe, expect, test } from "bun:test";
import { selectChain, type ChainConfig } from "../../src/core/chain.js";
import { executeChain } from "../../src/cli/commands/chain.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("chain command", () => {
  test("lists an empty config as JSON without spawning a process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-test-"));
    try {
      const result = await executeChain(["list", "--json"], { MEGABRAIN_STATE_DIR: directory, HOME: directory });
      expect(result).toEqual({ kind: "ok", value: '{"chains":[],"defaultSteps":[]}\n' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("reports unknown codex limits when the snapshot is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-test-"));
    try {
      const result = await executeChain(["limits", "--json"], { MEGABRAIN_STATE_DIR: directory, HOME: directory });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value).find((row: { provider: string; window: string }) => row.provider === "codex" && row.window === "5h").status).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("reports a stale codex snapshot as unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-test-"));
    const sessions = join(directory, "sessions"); mkdirSync(sessions);
    writeFileSync(join(sessions, "rollout-stale.jsonl"), JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1 } } } }) + "\n");
    try {
      const result = await executeChain(["limits", "--json"], { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_CODEX_SESSIONS_DIR: sessions });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") expect(JSON.parse(result.value).find((row: { provider: string; window: string }) => row.provider === "codex" && row.window === "5h").status).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("reports an incomplete current codex snapshot as unknown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-test-"));
    const sessions = join(directory, "sessions"); mkdirSync(sessions);
    writeFileSync(join(sessions, "rollout-incomplete-usage.jsonl"), readFileSync(join(process.cwd(), "tests/fixtures/codex-rollout-incomplete-usage.jsonl")));
    try {
      const result = await executeChain(["limits", "--json"], { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_CODEX_SESSIONS_DIR: sessions });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const row = JSON.parse(result.value).find((entry: { provider: string; window: string }) => entry.provider === "codex" && entry.window === "5h");
        expect(row).toMatchObject({ status: "unknown", usedPercent: null, resetsAt: null });
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

});
