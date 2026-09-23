import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { executeInstall } from "../../src/cli/commands/install-doctor.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok, type Result } from "../../src/core/result.js";

const repoRoot = resolve(import.meta.dir, "../..");

type RunResult = Result<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
type Handler = (args: readonly string[]) => RunResult | Promise<RunResult>;

// A fake ProcessAdapter: exact "<command> <args...>" keys win, a bare command name is a
// fallback for handlers that need to see every invocation (e.g. "date"), "which" honours the
// `unavailableCommands` list, and anything else fails loudly rather than silently succeeding —
// so a step this test never mocks shows up as a failure, not a false "ok".
function fakeProcess(handlers: Record<string, Handler | string> = {}, unavailableCommands: readonly string[] = []): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "which") {
        const target = args[0];
        if (unavailableCommands.includes(target)) return failed(`${target} unavailable`);
        return ok({ stdout: `/usr/bin/${target}`, stderr: "", exitCode: 0 });
      }
      const key = [command, ...args].join(" ");
      const handler = handlers[key] ?? handlers[command];
      if (typeof handler === "function") return handler(args);
      if (typeof handler === "string") return ok({ stdout: handler, stderr: "", exitCode: 0 });
      return failed(`${key} unavailable`);
    },
    async startDetached() {
      return failed("detached process unavailable");
    },
    invocationCount: () => 0,
  };
}

function tmpHome(prefix: string): string {
  return mkdtempSync(join("/tmp", `megabrain-install-${prefix}-`));
}

describe("executeInstall", () => {
  test("refuses without a module id when there is no interactive terminal", async () => {
    const result = await executeInstall([], { HOME: tmpHome("no-tty") }, fakeProcess());
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toBe("install without a module id requires an interactive terminal");
  });

  test("refuses an unknown module id", async () => {
    const result = await executeInstall(["not-a-module"], { HOME: tmpHome("unknown") }, fakeProcess());
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toBe("unknown module: not-a-module");
    expect(result.exitCode).toBe(2);
  });

  test("refuses --revert for a module that cannot be reverted", async () => {
    const home = tmpHome("revert-refused");
    const result = await executeInstall(["skill-sync", "--revert"], { HOME: home, MEGABRAIN_STATE_DIR: home }, fakeProcess());
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toBe("module cannot be reverted: skill-sync");
    expect(result.exitCode).toBe(2);
  });

  test("reports already installed without attempting any external step", async () => {
    const home = tmpHome("already");
    const process = fakeProcess({ "orca status --json": "{}" });
    const result = await executeInstall(["orchestration", "--yes"], { HOME: home, MEGABRAIN_STATE_DIR: home }, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("expected success");
    expect(result.value).toBe("orchestration: already installed\n");
  });

  test("orchestration and worktree install as a pure doctor alias and fail when nothing is usable", async () => {
    const home = tmpHome("orchestration-alias");
    const result = await executeInstall(["orchestration", "--yes"], { HOME: home, MEGABRAIN_STATE_DIR: home }, fakeProcess());
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toContain("orchestration: missing");
  });

  test("tv-adb names the missing dependency and the fix command instead of a generic refusal", async () => {
    const home = tmpHome("tv-adb");
    const process = fakeProcess({}, ["adb"]);
    const result = await executeInstall(["tv-adb", "--yes"], { HOME: home, MEGABRAIN_STATE_DIR: home }, process);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toBe("tv-adb: adb is missing. Install Android platform-tools with: brew install android-platform-tools");
  });

  test("simulator-native installs appium and the xcuitest driver, and the doctor report reflects it afterward", async () => {
    const home = tmpHome("simulator-native");
    let appiumOnPath = false;
    let driverInstalled = false;
    const process = fakeProcess({
      "uname -s": "Darwin",
      "npm install -g appium": () => {
        appiumOnPath = true;
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      "appium driver install xcuitest": () => {
        driverInstalled = true;
        return ok({ stdout: "", stderr: "", exitCode: 0 });
      },
      "appium driver list --installed": () => driverInstalled
        ? ok({ stdout: "xcuitest@latest [installed]", stderr: "", exitCode: 0 })
        : failed("no drivers installed"),
    }, ["appium"]);
    const wrapped: ProcessAdapter = {
      ...process,
      async run(command, args) {
        if (command === "which" && args[0] === "appium") {
          return appiumOnPath ? ok({ stdout: "/usr/local/bin/appium", stderr: "", exitCode: 0 }) : failed("appium unavailable");
        }
        return process.run(command, args);
      },
    };
    const result = await executeInstall(["simulator-native", "--yes"], { HOME: home, MEGABRAIN_STATE_DIR: home }, wrapped);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    expect(result.value).toContain("simulator-native: ok");
    expect(appiumOnPath).toBe(true);
    expect(driverInstalled).toBe(true);
  });

  test("simulator-native fails the whole install when npm install -g appium fails, never reporting success", async () => {
    const home = tmpHome("simulator-native-fail");
    const process = fakeProcess({
      "uname -s": "Darwin",
      "npm install -g appium": () => failed("npm install -g appium failed: network error"),
    }, ["appium"]);
    const result = await executeInstall(["simulator-native", "--yes"], { HOME: home, MEGABRAIN_STATE_DIR: home }, process);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toBe("simulator-native: npm install -g appium failed");
  });

  test("simulator-web registers agents with a -- separator before npx (defect B) and fails outright when registration fails", async () => {
    const home = tmpHome("simulator-web");
    const playwrightRoot = join(home, "playwright");
    mkdirSync(playwrightRoot, { recursive: true });
    const registeredCalls: string[][] = [];
    const installKey = `node ${repoRoot}/scripts/playwright-web.mjs install --root ${playwrightRoot} --browser both`;
    const addKey = "claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest --config /config/chromium.json";
    const process = fakeProcess({
      [installKey]: "",
      "claude mcp list": "",
      "claude mcp remove playwright": "",
      [addKey]: (args) => {
        registeredCalls.push(["claude", ...args]);
        return failed("claude mcp add: error: unknown option '-y'");
      },
      "npx -y @playwright/mcp@latest --version": "1.62.1",
    }, ["codex", "agy", "cursor", "cursor-agent"]);
    writeFileSync(join(playwrightRoot, "manifest.json"), JSON.stringify({ activeBrowser: "chromium", profiles: { chromium: { configPath: "/config/chromium.json" } } }));
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_PLAYWRIGHT_ROOT: playwrightRoot, MEGABRAIN_ROOT: repoRoot };
    const result = await executeInstall(["simulator-web", "--yes"], environment, process);
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") throw new Error("expected failure");
    expect(result.error).toContain("simulator-web:");
    expect(result.error).toContain("playwright MCP registration failed for claude");
    expect(registeredCalls).toHaveLength(1);
    expect(registeredCalls[0]).toEqual(["claude", "mcp", "add", "--scope", "user", "playwright", "--", "npx", "-y", "@playwright/mcp@latest", "--config", "/config/chromium.json"]);
  });

  test("simulator-web installs and registers an agent successfully, exiting ok", async () => {
    const home = tmpHome("simulator-web-ok");
    const playwrightRoot = join(home, "playwright");
    mkdirSync(playwrightRoot, { recursive: true });
    writeFileSync(join(playwrightRoot, "manifest.json"), JSON.stringify({ activeBrowser: "chromium", profiles: { chromium: { configPath: "/config/chromium.json" } } }));
    const installKey = `node ${repoRoot}/scripts/playwright-web.mjs install --root ${playwrightRoot} --browser both`;
    const doctorKey = `node ${repoRoot}/scripts/playwright-web.mjs doctor --root ${playwrightRoot}`;
    const addKey = "claude mcp add --scope user playwright -- npx -y @playwright/mcp@latest --config /config/chromium.json";
    const process = fakeProcess({
      [installKey]: "",
      [doctorKey]: JSON.stringify({ status: "ok", reason: "browser profile is current" }),
      "npx -y @playwright/mcp@latest --version": "1.62.1",
      "claude mcp list": "",
      "claude mcp remove playwright": "",
      [addKey]: "",
    }, ["codex", "agy", "cursor", "cursor-agent"]);
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_PLAYWRIGHT_ROOT: playwrightRoot, MEGABRAIN_ROOT: repoRoot };
    const result = await executeInstall(["simulator-web", "--yes"], environment, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(`expected success, got: ${JSON.stringify(result)}`);
  });

  test("orchestration-hooks repairs an available agent's hook config and leaves an unavailable agent untouched", async () => {
    const home = tmpHome("hooks-install");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const process = fakeProcess({}, ["codex", "agy", "cursor", "cursor-agent"]);
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: repoRoot };
    const result = await executeInstall(["orchestration-hooks", "--yes"], environment, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    const written = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    const hooks = written.hooks as { Stop: Array<{ hooks: Array<{ command: string }> }> };
    expect(hooks.Stop[0].hooks[0].command).toContain("megabrain-turn-end.sh");
    expect(hooks.Stop[0].hooks[0].command).toContain("MEGABRAIN_HOOK_AGENT=claude");
  });

  test("orchestration-hooks install backs up an existing config, and --revert restores it", async () => {
    const home = tmpHome("hooks-revert");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo original" }] }] } };
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(original));
    const process = fakeProcess({}, ["codex", "agy", "cursor", "cursor-agent"]);
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: repoRoot };
    const installResult = await executeInstall(["orchestration-hooks", "--yes"], environment, process);
    expect(installResult.kind).toBe("ok");
    const afterInstall = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(afterInstall)).not.toBe(JSON.stringify(original));
    const revertResult = await executeInstall(["orchestration-hooks", "--revert"], environment, process);
    expect(revertResult.kind).toBe("ok");
    const afterRevert = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as Record<string, unknown>;
    expect(afterRevert).toEqual(original);
  });

  test("tmux-runtime installs with --yes, writing real tuning and wrapper files and recording the module as enabled", async () => {
    const home = tmpHome("tmux-runtime");
    const process = fakeProcess({}); // "tmux" itself is left available via "which"; no running server, so tune never sources it.
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: repoRoot, SHELL: "/bin/zsh" };
    const result = await executeInstall(["tmux-runtime", "--yes"], environment, process);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error(`expected success, got: ${JSON.stringify(result)}`);
    expect(result.value).toContain("tmux-runtime: ok");
    const tuningInstalled = readFileSync(join(home, ".megabrain", "tmux", "megabrain.tmux.conf"), "utf8");
    expect(tuningInstalled.length).toBeGreaterThan(0);
    const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
    expect(zshrc).toContain("megabrain tmux wrapper");
    const state = JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as Record<string, { installed?: boolean }>;
    expect(state["tmux-runtime"]?.installed).toBe(true);
  });

  test("skill-sync install repairs a drifted registered copy from the installed source", async () => {
    const home = tmpHome("skill-sync");
    // scanSkillSync resolves one of its targets relative to the current working directory
    // (".claude/skills/megabrain/SKILL.md"), so this test must run from an empty directory —
    // otherwise it silently picks up this checkout's own real, checked-in skill copy.
    const originalCwd = process.cwd();
    process.chdir(home);
    try {
      const targetDir = join(home, ".claude", "plugins", "cache", "megabrain-local", "megabrain", "fixture", "skills", "megabrain");
      mkdirSync(targetDir, { recursive: true });
      const targetPath = join(targetDir, "SKILL.md");
      writeFileSync(targetPath, "stale content that does not match the installed source\n");
      const environment = { HOME: home, MEGABRAIN_STATE_DIR: home, MEGABRAIN_ROOT: repoRoot };
      // skill-sync has no --yes confirmation gate in the shell either: module_skill_sync_install
      // always repairs immediately, so a drifted copy is enough to prove the step ran for real.
      const result = await executeInstall(["skill-sync", "--yes"], environment, fakeProcess());
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") throw new Error(`expected success, got: ${JSON.stringify(result)}`);
      expect(result.value).toBe("skill-sync: ok (skill copies current: 1)\n");
      const sourceContent = readFileSync(join(repoRoot, "skills", "megabrain", "SKILL.md"), "utf8");
      expect(readFileSync(targetPath, "utf8")).toBe(sourceContent);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
