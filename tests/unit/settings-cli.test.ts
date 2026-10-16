import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { route } from "../../src/cli/router.js";
import { failed, ok } from "../../src/core/result.js";

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
      name: "Known model",
      contextWindows: [272000],
      current: true,
      reasoning: { separateAxis: true, levels: ["low", "high"] },
      provenance: { kind: "curated", method: "manual curation", obtainedAt: "2026-10-15T00:00:00.000Z" },
    }],
  }));
  return { home, state, root };
}

let claudeUsageRequests = 0;
const processAdapter: ProcessAdapter = {
  async run(command) {
    if (command === "security") return ok({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: "token", expiresAt: 9999999999 } }), stderr: "", exitCode: 0 });
    if (command === "curl") {
      claudeUsageRequests += 1;
      return ok({ stdout: `${JSON.stringify({ five_hour: { utilization: 30, resets_at: "2030-01-01T00:00:00Z" }, seven_day: { utilization: 40, resets_at: "2030-01-02T00:00:00Z" } })}\nMEGABRAIN_HTTP_STATUS:200`, stderr: "", exitCode: 0 });
    }
    return failed(`${command} unavailable`);
  },
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
    expect(Object.keys(value).sort()).toEqual(["chains", "limits", "models", "resources", "supervisor", "terminal", "terminalEngine"]);
    expect(value.terminalEngine).toBe("native");
    expect(Object.keys(value.supervisor as object).sort()).toEqual(["pid", "running"]);
    expect(Object.keys(value.resources as object).sort()).toEqual(["historyEnabled", "policy"]);
    expect(Object.keys(value.limits as object).sort()).toEqual(["enabledProviders", "notice", "readings"]);
    expect(Object.keys((value.limits as { notice: object }).notice).sort()).toEqual(["enabled", "intervalSeconds"]);
    expect(Object.keys(value.terminal as object).sort()).toEqual(["available", "default", "detected"]);
    const firstReading = (value.limits as { readings: Record<string, unknown>[] }).readings[0];
    expect(Object.keys(firstReading ?? {}).sort()).toContain("provider");
    expect(Object.keys(firstReading ?? {}).sort()).toContain("window");
    expect(Object.keys(firstReading ?? {}).sort()).toContain("status");
    expect(Object.keys(firstReading ?? {}).sort()).toContain("usedPercent");
    expect(Object.keys(firstReading ?? {}).sort()).toContain("resetsAt");
    expect(Object.keys(firstReading ?? {}).sort()).toContain("fetchedAt");
    expect(Object.keys(firstReading ?? {}).sort()).toContain("reason");
    expect(value.models).toEqual([{ agent: "codex", model: "model-known", name: "Known model", contextWindows: [272000], current: true, reasoning: { levels: ["low", "high"] } }]);
    expect(value.resources).toEqual({ historyEnabled: false, policy: null });
    expect(value.limits).toMatchObject({ enabledProviders: [], notice: { enabled: false, intervalSeconds: 3600 } });
    const limits = await run(["chain", "limits", "--json"], env);
    expect(limits.kind).toBe("ok");
    if (limits.kind === "ok") expect(value.limits && (value.limits as { readings: unknown[] }).readings).toEqual(JSON.parse(limits.value));
    expect(value.chains).toEqual([]);
    expect(value.supervisor).toEqual({ running: false, pid: null });
  });

  test("settings and chain limits reuse one live Claude reading for 60 seconds", async () => {
    const env = sandbox();
    claudeUsageRequests = 0;
    writeFileSync(join(env.state, "chains.json"), JSON.stringify({ chains: {}, defaultSteps: [], usageLimits: { liveProviders: ["claude"] } }));
    const first = await settings(env);
    const second = await settings(env);
    const limits = await run(["chain", "limits", "--json"], env);
    expect(second.limits).toEqual(first.limits);
    expect(limits.kind).toBe("ok");
    expect(claudeUsageRequests).toBe(1);
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

  test("persists the terminal engine as state-dir JSON and reads it back", async () => {
    const env = sandbox();
    expect((await settings(env)).terminalEngine).toBe("native");
    expect((await run(["settings", "set", "terminal-engine", "tmux"], env)).kind).toBe("ok");
    expect((await settings(env)).terminalEngine).toBe("tmux");
    expect((await run(["settings", "set", "terminal-engine", "native"], env)).kind).toBe("ok");
    expect((await settings(env)).terminalEngine).toBe("native");
    expect((await run(["settings", "set", "terminal-engine", "unknown"], env)).kind).toBe("failed");
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

describe("settings sidebar-folders", () => {
  const layout = { version: 1, folders: [{ id: "work", name: "Work", collapsed: true, projects: ["/repo/a", "/repo/b"] }], order: ["work", "/repo/c"] };

  async function read(env: ReturnType<typeof sandbox>): Promise<unknown> {
    const result = await run(["settings", "get", "sidebar-folders"], env);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(result.error);
    return JSON.parse(result.value) as unknown;
  }

  test("reads an empty layout before anything was saved", async () => {
    expect(await read(sandbox())).toEqual({ version: 1, folders: [], order: [] });
  });

  test("stores the layout as a private state-dir file and reads it back", async () => {
    const env = sandbox();
    expect((await run(["settings", "set", "sidebar-folders", JSON.stringify(layout)], env)).kind).toBe("ok");
    expect(await read(env)).toEqual(layout);
    const file = join(env.state, "sidebar-settings.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(layout);
  });

  test("replaces the whole layout on each write", async () => {
    const env = sandbox();
    expect((await run(["settings", "set", "sidebar-folders", JSON.stringify(layout)], env)).kind).toBe("ok");
    const next = { version: 1, folders: [], order: ["/repo/a"] };
    expect((await run(["settings", "set", "sidebar-folders", JSON.stringify(next)], env)).kind).toBe("ok");
    expect(await read(env)).toEqual(next);
  });

  test("refuses anything that is not a layout and keeps the saved one", async () => {
    const env = sandbox();
    expect((await run(["settings", "set", "sidebar-folders", JSON.stringify(layout)], env)).kind).toBe("ok");
    const refused = [
      "not json",
      JSON.stringify([]),
      JSON.stringify({ version: 2, folders: [], order: [] }),
      JSON.stringify({ version: 1, folders: [{ id: "a", name: "A", collapsed: false }], order: [] }),
      JSON.stringify({ version: 1, folders: [{ id: "a", name: "", collapsed: false, projects: [] }], order: [] }),
      JSON.stringify({ version: 1, folders: [{ id: "/a", name: "A", collapsed: false, projects: [] }], order: [] }),
      JSON.stringify({ version: 1, folders: [{ id: "a", name: "A", collapsed: false, projects: [] }, { id: "a", name: "B", collapsed: false, projects: [] }], order: [] }),
      JSON.stringify({ version: 1, folders: [{ id: "a", name: "A", collapsed: "no", projects: [] }], order: [] }),
      JSON.stringify({ version: 1, folders: [{ id: "a", name: "A", collapsed: false, projects: [3] }], order: [] }),
      JSON.stringify({ version: 1, folders: [], order: [7] }),
      JSON.stringify({ version: 1, folders: [], order: [], extra: true }),
    ];
    for (const value of refused) {
      const result = await run(["settings", "set", "sidebar-folders", value], env);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error.split(/\r?\n/)).toHaveLength(1);
    }
    expect((await run(["settings", "set", "sidebar-folders"], env)).kind).toBe("failed");
    expect(await read(env)).toEqual(layout);
  });

  test("reads an empty layout when the saved file is damaged", async () => {
    const env = sandbox();
    writeFileSync(join(env.state, "sidebar-settings.json"), "{broken");
    expect(await read(env)).toEqual({ version: 1, folders: [], order: [] });
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
