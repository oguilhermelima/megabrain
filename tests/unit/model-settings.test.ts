import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { emptyModelSettings, modelEnabled, parseModelSettings, startModel, type ModelSettings } from "../../src/core/model-settings.js";
import type { Model } from "../../src/core/model.js";
import { failed } from "../../src/core/result.js";

const model = (agent: string, id: string, status: string, levels: string[] = ["low", "high"]): Model => ({
  agent, model: id, status, reasoning: { separateAxis: true, levels }, provenance: { kind: "sourced" },
});

const registry = [
  model("codex", "gpt-6-luna", "current", ["low", "medium", "high"]),
  model("codex", "gpt-6-sol", "older"),
  model("codex", "gpt-5.5", "deprecated"),
  model("claude", "claude-opus-5-5", "current"),
];

describe("model settings", () => {
  test("with nothing saved, current models are on and older or deprecated ones off", () => {
    expect(registry.map((entry) => modelEnabled(emptyModelSettings, entry))).toEqual([true, false, false, true]);
    expect(modelEnabled(emptyModelSettings, { ...registry[0]!, status: undefined })).toBe(true);
  });

  test("a saved toggle wins over the status", () => {
    const settings: ModelSettings = { version: 1, models: { "codex/gpt-6-sol": true, "codex/gpt-6-luna": false }, defaults: {} };
    expect(registry.map((entry) => modelEnabled(settings, entry))).toEqual([false, true, false, true]);
  });

  test("parses a valid file and refuses anything else", () => {
    const saved = { version: 1, models: { "codex/gpt-6-sol": true }, defaults: { codex: { model: "gpt-6-luna", effort: "medium" }, claude: { model: "claude-opus-5-5", effort: null } } };
    expect(parseModelSettings(JSON.stringify(saved))).toEqual({ kind: "ok", value: saved });
    for (const value of [
      "nope",
      JSON.stringify({ version: 2, models: {}, defaults: {} }),
      JSON.stringify({ version: 1, models: { "codex/x": "yes" }, defaults: {} }),
      JSON.stringify({ version: 1, models: { "gemini/x": true }, defaults: {} }),
      JSON.stringify({ version: 1, models: { "codex": true }, defaults: {} }),
      JSON.stringify({ version: 1, models: {}, defaults: { gemini: { model: "x", effort: null } } }),
      JSON.stringify({ version: 1, models: {}, defaults: { codex: { model: "", effort: null } } }),
      JSON.stringify({ version: 1, models: {}, defaults: { codex: { model: "gpt-6-luna", effort: "turbo" } } }),
      JSON.stringify({ version: 1, models: {}, defaults: {}, more: 1 }),
    ]) {
      expect({ value, kind: parseModelSettings(value).kind }).toEqual({ value, kind: "failed" });
    }
  });

  test("a new chat without a model takes the agent's default, with its effort unless one is given", () => {
    const settings: ModelSettings = { version: 1, models: {}, defaults: { codex: { model: "gpt-6-luna", effort: "medium" } } };
    expect(startModel(settings, registry, "codex", undefined, undefined)).toEqual({ model: "gpt-6-luna", effort: "medium" });
    expect(startModel(settings, registry, "codex", undefined, "high")).toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(startModel(settings, registry, "codex", "gpt-6-sol", undefined)).toEqual({ model: "gpt-6-sol", effort: undefined });
    expect(startModel(settings, registry, "claude", undefined, undefined)).toEqual({ model: undefined, effort: undefined });
  });

  test("a default naming a model that is off or gone is ignored, and an effort the model lacks is dropped", () => {
    const off: ModelSettings = { version: 1, models: { "codex/gpt-6-luna": false }, defaults: { codex: { model: "gpt-6-luna", effort: "medium" } } };
    expect(startModel(off, registry, "codex", undefined, undefined)).toEqual({ model: undefined, effort: undefined });
    const gone: ModelSettings = { version: 1, models: {}, defaults: { codex: { model: "gpt-9", effort: null } } };
    expect(startModel(gone, registry, "codex", undefined, undefined)).toEqual({ model: undefined, effort: undefined });
    const noLevel: ModelSettings = { version: 1, models: {}, defaults: { codex: { model: "gpt-6-luna", effort: "max" } } };
    expect(startModel(noLevel, registry, "codex", undefined, undefined)).toEqual({ model: "gpt-6-luna", effort: undefined });
  });
});

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "megabrain-model-settings-"));
  directories.push(base);
  const env = { home: join(base, "home"), state: join(base, "state"), root: join(base, "project") };
  for (const directory of [env.home, env.state, join(env.root, ".megabrain")]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(env.root, ".megabrain", "models.json"), JSON.stringify({ version: 1, models: registry }));
  return env;
}

const processAdapter: ProcessAdapter = {
  async run(command) { return failed(`${command} unavailable`); },
  async startDetached() { return failed("not used"); },
  invocationCount() { return 0; },
};

const run = (args: readonly string[], env: ReturnType<typeof sandbox>) => route(args, { environment: { HOME: env.home, MEGABRAIN_STATE_DIR: env.state, MEGABRAIN_ROOT: env.root }, processAdapter });

describe("megabrain settings get|set models", () => {
  const saved = { version: 1, models: { "codex/gpt-6-sol": true, "claude/claude-opus-5-5": false }, defaults: { codex: { model: "gpt-6-sol", effort: "high" } } };

  test("reads nothing saved, then round-trips a private file", async () => {
    const env = sandbox();
    expect(await run(["settings", "get", "models"], env)).toEqual({ kind: "ok", value: `${JSON.stringify(emptyModelSettings)}\n` });
    expect(await run(["settings", "set", "models", JSON.stringify(saved)], env)).toEqual({ kind: "ok", value: "models: 2 toggled, 1 agent default\n" });
    expect(await run(["settings", "get", "models"], env)).toEqual({ kind: "ok", value: `${JSON.stringify(saved)}\n` });
    expect(statSync(join(env.state, "model-settings.json")).mode & 0o777).toBe(0o600);
    expect((await run(["settings", "set", "models", "{}"], env)).kind).toBe("failed");
    expect(await run(["settings", "get", "models"], env)).toEqual({ kind: "ok", value: `${JSON.stringify(saved)}\n` });
  });

  test("the settings read says which models are on, after the saved toggles", async () => {
    const env = sandbox();
    const before = await run(["settings", "--json", "--only", "models"], env);
    if (before.kind !== "ok") throw new Error(before.error);
    expect((JSON.parse(before.value) as { models: { model: string; enabled: boolean }[] }).models.map((entry) => [entry.model, entry.enabled])).toEqual([
      ["gpt-6-luna", true], ["gpt-6-sol", false], ["gpt-5.5", false], ["claude-opus-5-5", true],
    ]);
    expect((await run(["settings", "set", "models", JSON.stringify(saved)], env)).kind).toBe("ok");
    const after = await run(["settings", "--json", "--only", "models"], env);
    if (after.kind !== "ok") throw new Error(after.error);
    expect((JSON.parse(after.value) as { models: { model: string; enabled: boolean }[] }).models.map((entry) => [entry.model, entry.enabled])).toEqual([
      ["gpt-6-luna", true], ["gpt-6-sol", true], ["gpt-5.5", false], ["claude-opus-5-5", false],
    ]);
  });
});
