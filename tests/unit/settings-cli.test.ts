import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed } from "../../src/core/result.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function sandbox(): { readonly home: string; readonly state: string; readonly root: string } {
  const base = mkdtempSync(join(tmpdir(), "megabrain-settings-cli-"));
  directories.push(base);
  const home = join(base, "home");
  const state = join(base, "state");
  const root = join(base, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(root, ".megabrain"), { recursive: true });
  writeFileSync(join(root, ".megabrain", "models.json"), JSON.stringify({
    version: 1,
    models: [{
      agent: "codex",
      model: "model-known",
      reasoning: { separateAxis: true, levels: ["low", "high"] },
      provenance: { kind: "curated", method: "manual curation", obtainedAt: "2026-10-15T00:00:00.000Z" },
    }],
  }));
  return { home, state, root };
}

const processAdapter: ProcessAdapter = {
  async run(command) { return failed(`${command} unavailable`); },
  async startDetached() { return failed("not used in settings tests"); },
  invocationCount() { return 0; },
};

async function run(args: readonly string[], env: ReturnType<typeof sandbox>) {
  return route(args, {
    environment: { HOME: env.home, MEGABRAIN_STATE_DIR: env.state, MEGABRAIN_ROOT: env.root },
    processAdapter,
  });
}

async function settings(env: ReturnType<typeof sandbox>): Promise<Record<string, unknown>> {
  const result = await run(["settings", "--json"], env);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error(result.error);
  return JSON.parse(result.value) as Record<string, unknown>;
}

describe("megabrain settings", () => {
  test("returns the desktop schema keys with empty settings", async () => {
    const env = sandbox();
    const value = await settings(env);

    // Keep these field names aligned with apps/desktop/src/api/schema.ts.
    expect(Object.keys(value).sort()).toEqual(["chains", "limits", "models", "resources", "supervisor", "terminal"]);
    expect(Object.keys(value.resources as object).sort()).toEqual(["historyEnabled", "policy"]);
    expect(Object.keys(value.limits as object).sort()).toEqual(["enabledProviders", "notice", "readings"]);
    expect(Object.keys(value.terminal as object).sort()).toEqual(["available", "default", "detected"]);
    expect(value.resources).toEqual({ historyEnabled: false, policy: null });
    expect(value.limits).toMatchObject({ enabledProviders: [], notice: { enabled: false, intervalSeconds: 3600 } });
    const limits = await run(["chain", "limits", "--json"], env);
    expect(limits.kind).toBe("ok");
    if (limits.kind === "ok") expect(value.limits && (value.limits as { readings: unknown[] }).readings).toEqual(JSON.parse(limits.value));
    expect(value.chains).toEqual([]);
    expect(value.supervisor).toEqual({ running: false, pid: null });
  });

  test("reflects resource, usage, chain, and terminal writes on the next read", async () => {
    const env = sandbox();
    expect((await run(["resources", "policy", "set", "--max-agents", "4", "--min-available-mib", "2048", "--max-pressure", "elevated", "--max-container-suites", "2"], env)).kind).toBe("ok");
    expect((await run(["resources", "enable"], env)).kind).toBe("ok");
    expect((await run(["chain", "limits", "--notice-on", "--notice-interval", "720", "--disable", "grok"], env)).kind).toBe("ok");
    expect((await run(["chain", "save", "desktop", "--when", JSON.stringify({ parentAgent: "codex" }), "--steps", JSON.stringify([{ agent: "codex", model: "model-known", effort: "high" }]), "--json"], env)).kind).toBe("ok");
    expect((await run(["terminal", "default", "kitty"], env)).kind).toBe("ok");

    const value = await settings(env);
    expect(value.resources).toEqual({
      historyEnabled: true,
      policy: { maxAgents: 4, minAvailableMib: 2048, maxPressure: "elevated", maxContainerSuites: 2 },
    });
    expect(value.limits).toMatchObject({
      enabledProviders: [],
      notice: { enabled: true, intervalSeconds: 720 },
    });
    expect(value.chains).toEqual([{ name: "desktop", when: { parentAgent: "codex" }, steps: [{ agent: "codex", model: "model-known", effort: "high" }] }]);
    expect(value.terminal).toMatchObject({ default: "kitty" });
  });

  test("uses null for each unset policy field and can clear policy and terminal default", async () => {
    const env = sandbox();
    expect((await run(["resources", "policy", "set", "--max-agents", "3"], env)).kind).toBe("ok");
    expect((await settings(env)).resources).toEqual({
      historyEnabled: false,
      policy: { maxAgents: 3, minAvailableMib: null, maxPressure: null, maxContainerSuites: null },
    });
    expect((await run(["resources", "policy", "off"], env)).kind).toBe("ok");
    expect((await run(["terminal", "default", "--clear"], env)).kind).toBe("ok");
    expect((await settings(env)).resources).toEqual({ historyEnabled: false, policy: null });
    expect((await settings(env)).terminal).toMatchObject({ default: null });
  });
});

describe("chain save", () => {
  test("creates and replaces a chain without an editor", async () => {
    const env = sandbox();
    const first = ["chain", "save", "desktop", "--when", "{}", "--steps", JSON.stringify([{ agent: "codex", model: "model-known", effort: "low" }]), "--json"];
    expect((await run(first, env)).kind).toBe("ok");
    const replacement = ["chain", "save", "desktop", "--when", JSON.stringify({ parentAgent: "codex" }), "--steps", JSON.stringify([{ agent: "codex", model: "model-known", effort: "high" }]), "--json"];
    expect((await run(replacement, env)).kind).toBe("ok");
    expect((await settings(env)).chains).toEqual([{ name: "desktop", when: { parentAgent: "codex" }, steps: [{ agent: "codex", model: "model-known", effort: "high" }] }]);
  });

  test("rejects unknown models unless explicitly allowed", async () => {
    const env = sandbox();
    const args = ["chain", "save", "custom", "--when", "{}", "--steps", JSON.stringify([{ agent: "codex", model: "unregistered" }])];
    const refused = await run(args, env);
    expect(refused.kind).toBe("failed");
    if (refused.kind === "failed") expect(refused.error).toContain("unknown model");
    expect((await run([...args, "--allow-unknown-model"], env)).kind).toBe("ok");
    expect((await settings(env)).chains).toEqual([{ name: "custom", when: {}, steps: [{ agent: "codex", model: "unregistered", unvalidated: true }] }]);
  });
});

describe("settings write errors", () => {
  test("returns one-line failures for invalid settings writes", async () => {
    const env = sandbox();
    const writes = [
      ["resources", "policy", "set"],
      ["chain", "limits", "--disable", "codex"],
      ["chain", "save", "invalid", "--when", "{}", "--steps", JSON.stringify([{ agent: "codex", model: "unregistered" }])],
      ["chain", "delete", "missing", "--json"],
      ["model", "refresh", "codex"],
      ["terminal", "default", "putty"],
    ];
    for (const args of writes) {
      const result = await run(args, env);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error.split(/\r?\n/)).toHaveLength(1);
    }
  });

  test("reports supervisor stop and start outcomes without invoking real processes", async () => {
    const env = sandbox();
    const stop = await run(["supervise", "--stop"], env);
    expect(stop.kind).toBe("ok");
    const start = await run(["supervise"], env);
    expect(start.kind).toBe("ok");
  });
});
