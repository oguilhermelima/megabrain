import { describe, expect, test } from "bun:test";
import { selectChain, type ChainConfig } from "../../src/core/chain.js";
import { executeChain } from "../../src/cli/commands/chain.js";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";
import type { ModelRegistry } from "../../src/core/model.js";

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

function registry(models: ModelRegistry["models"]): ModelRegistry { return { version: 1, models }; }

describe("chain validation reads the state model registry", () => {
  test("accepts a model registered only in the state registry (not the template)", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-chain-registry-root-"));
    const state = mkdtempSync(join(tmpdir(), "megabrain-chain-registry-state-"));
    try {
      mkdirSync(join(root, ".megabrain"), { recursive: true });
      writeFileSync(join(root, ".megabrain/models.json"), JSON.stringify(registry([
        { agent: "codex", model: "gpt-5.5", reasoning: { separateAxis: true, levels: ["low"] }, provenance: { kind: "sourced" } },
      ])));
      writeFileSync(join(state, "models.json"), JSON.stringify(registry([
        { agent: "codex", model: "gpt-6-luna", reasoning: { separateAxis: true, levels: ["high"] }, provenance: { kind: "curated", method: "manual curation", obtainedAt: "2026-09-23" } },
      ])));
      const environment = { MEGABRAIN_STATE_DIR: state, HOME: state, MEGABRAIN_ROOT: root };
      const result = await executeChain(["add", "uses-state-model", "--when", "{}", "--steps", JSON.stringify([{ agent: "codex", model: "gpt-6-luna", effort: "high" }])], environment);
      expect(result.kind).toBe("ok");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
  });

  test("accepts a model present only in the template, copied into state the way model.ts copies it", async () => {
    const root = mkdtempSync(join(tmpdir(), "megabrain-chain-registry-root-"));
    const state = mkdtempSync(join(tmpdir(), "megabrain-chain-registry-state-"));
    try {
      mkdirSync(join(root, ".megabrain"), { recursive: true });
      writeFileSync(join(root, ".megabrain/models.json"), JSON.stringify(registry([
        { agent: "codex", model: "gpt-6-luna", reasoning: { separateAxis: true, levels: ["high"] }, provenance: { kind: "sourced" } },
      ])));
      const environment = { MEGABRAIN_STATE_DIR: state, HOME: state, MEGABRAIN_ROOT: root };
      const result = await executeChain(["add", "uses-template-model", "--when", "{}", "--steps", JSON.stringify([{ agent: "codex", model: "gpt-6-luna", effort: "high" }])], environment);
      expect(result.kind).toBe("ok");
      // model.ts's readRegistry copies the template into the state file on first
      // use; validateConfig must go through the same copy, not read the template directly.
      expect(JSON.parse(readFileSync(join(state, "models.json"), "utf8"))).toEqual(JSON.parse(readFileSync(join(root, ".megabrain/models.json"), "utf8")));
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
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

  // These two prove `chain limits` reads through core/chain-limits.ts (the same
  // reader chain run uses) instead of its own shortcut: each fails against the
  // shortcut and passes once limits() is switched over.
  test("keeps a complete window current even when a sibling window in the same snapshot is incomplete", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-test-"));
    const sessions = join(directory, "sessions"); mkdirSync(sessions);
    writeFileSync(join(sessions, "rollout-incomplete-usage.jsonl"), readFileSync(join(process.cwd(), "tests/fixtures/codex-rollout-incomplete-usage.jsonl")));
    try {
      // The fixture's 5h window is missing used_percent (already proven unknown
      // above) but its weekly window is complete. The old codexRows shortcut
      // forced every codex row to unknown whenever any one window was
      // incomplete; the shared reader resolves each window independently,
      // matching megabrain_chain_limit_read being called once per window.
      const result = await executeChain(["limits", "--json"], { MEGABRAIN_STATE_DIR: directory, HOME: directory, MEGABRAIN_CODEX_SESSIONS_DIR: sessions });
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const weekly = JSON.parse(result.value).find((entry: { provider: string; window: string }) => entry.provider === "codex" && entry.window === "weekly");
        expect(weekly).toMatchObject({ status: "current", usedPercent: 18 });
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("reports a live claude window when the provider is opted in via usageLimits.liveProviders", async () => {
    const directory = mkdtempSync(join(tmpdir(), "megabrain-chain-test-"));
    try {
      // The old codexRows shortcut hardcoded claude/agy as always "not enabled",
      // ignoring usageLimits.liveProviders and the processAdapter entirely; the
      // shared reader honours the opt-in and makes the live call.
      writeFileSync(join(directory, "chains.json"), JSON.stringify({ chains: {}, defaultSteps: [], usageLimits: { liveProviders: ["claude"], cacheTtlSeconds: 30, timeoutSeconds: 5, notice: { enabled: false, intervalSeconds: 3600 } } }));
      const process: ProcessAdapter = {
        async run(command) {
          if (command === "security") return ok({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: 9999999999 } }), stderr: "", exitCode: 0 });
          if (command === "curl") return ok({ stdout: `${JSON.stringify({ five_hour: { utilization: 11.0, resets_at: "2026-09-07T10:00:00Z" }, seven_day: { utilization: 48.0, resets_at: "2026-09-10T16:00:00Z" } })}\nMEGABRAIN_HTTP_STATUS:200`, stderr: "", exitCode: 0 });
          return ok({ stdout: "", stderr: "", exitCode: 0 });
        },
        async startDetached() { return failed("not used"); },
        invocationCount() { return 0; },
      };
      const result = await executeChain(["limits", "--json"], { MEGABRAIN_STATE_DIR: directory, HOME: directory }, process);
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        const claude5h = JSON.parse(result.value).find((entry: { provider: string; window: string }) => entry.provider === "claude" && entry.window === "5h");
        expect(claude5h).toMatchObject({ status: "current", usedPercent: 11, source: "live" });
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
