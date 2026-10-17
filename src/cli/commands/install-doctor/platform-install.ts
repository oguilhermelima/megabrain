import { existsSync, readFileSync } from "node:fs";import { join, resolve } from "node:path";import { failed, ok, type Result } from "../../../core/result.js";import type { ProcessAdapter } from "../../../adapters/proc.js";import { executeTmux } from "../tmux.js";import { resolvePackageRoot } from "../../../core/package-root.js";
import { available, appiumReady } from "./diagnostics.js";import type { Environment } from "./diagnostics.js";import { report } from "./doctor.js";import { writeInstalledState } from "./install-state.js";import type { InstallOptions } from "./install-state.js";
// --- simulator-native / simulator-tv -------------------------------------------------------

export async function installSimulatorNative(processAdapter: ProcessAdapter): Promise<Result<void>> {
  if (!(await available(processAdapter, "appium"))) {
    const install = await processAdapter.run("npm", ["install", "-g", "appium"]);
    if (install.kind !== "ok") return failed("npm install -g appium failed");
  }
  if (!(await appiumReady(processAdapter))) {
    const driver = await processAdapter.run("appium", ["driver", "install", "xcuitest"]);
    if (driver.kind !== "ok") return failed("appium driver install xcuitest failed");
  }
  return ok(undefined);
}

// --- tv-adb ---------------------------------------------------------------------------------

export async function installTvAdb(processAdapter: ProcessAdapter): Promise<Result<void>> {
  if (await available(processAdapter, "adb")) return ok(undefined);
  const platform = await processAdapter.run("uname", ["-s"]);
  const os = platform.kind === "ok" ? platform.value.stdout.trim()
    : process.platform === "darwin" ? "Darwin" : process.platform === "linux" ? "Linux" : "";
  const brewAvailable = os === "Darwin" && await available(processAdapter, "brew");
  const message = brewAvailable
    ? "adb is missing. Install Android platform-tools with: brew install android-platform-tools"
    : "adb is missing. Install Android platform-tools with your OS package manager (for example: apt install adb)";
  return failed(message);
}

// --- simulator-web ----------------------------------------------------------------------------

export type PlaywrightAgent = "claude" | "codex" | "agy";
export const playwrightAgents: readonly PlaywrightAgent[] = ["claude", "codex", "agy"];

export async function playwrightRegistered(agent: PlaywrightAgent, configPath: string, processAdapter: ProcessAdapter): Promise<boolean> {
  if (agent === "codex") {
    const list = await processAdapter.run("codex", ["mcp", "list", "--json"]);
    if (list.kind !== "ok") return false;
    try {
      const parsed = JSON.parse(list.value.stdout) as Array<{ name?: string; transport?: { command?: string; args?: readonly string[] } }>;
      return parsed.some((entry) => {
        const args = (entry.transport?.args ?? []).join(" ");
        return entry.name === "playwright" && entry.transport?.command === "npx" && args.includes("@playwright/mcp@latest") && args.includes("--config") && args.includes(configPath);
      });
    } catch {
      return false;
    }
  }
  const list = await processAdapter.run(agent, ["mcp", "list"]);
  if (list.kind !== "ok") return false;
  const text = list.value.stdout;
  return text.includes("playwright") && text.includes("@playwright/mcp@latest") && text.includes(`--config ${configPath}`);
}

export async function registerPlaywright(agent: PlaywrightAgent, configPath: string, processAdapter: ProcessAdapter): Promise<Result<void>> {
  if (await playwrightRegistered(agent, configPath, processAdapter)) return ok(undefined);
  await processAdapter.run(agent, ["mcp", "remove", "playwright"]);
  const args = agent === "codex"
    ? ["mcp", "add", "playwright", "--", "npx", "-y", "@playwright/mcp@latest", "--config", configPath]
    : ["mcp", "add", "--scope", "user", "playwright", "--", "npx", "-y", "@playwright/mcp@latest", "--config", configPath];
  const result = await processAdapter.run(agent, args);
  if (result.kind !== "ok") return failed(`${agent}: playwright MCP registration failed`);
  return ok(undefined);
}

export async function installSimulatorWeb(environment: Environment, processAdapter: ProcessAdapter, browser: string): Promise<Result<void>> {
  if (!(await available(processAdapter, "node")) || !(await available(processAdapter, "npm"))) {
    return failed(`node and npm are required for pinned Playwright 1.62.1`);
  }
  const script = environment.MEGABRAIN_PLAYWRIGHT_SCRIPT ?? join(resolvePackageRoot(import.meta.url, environment.MEGABRAIN_ROOT), "scripts/playwright-web.mjs");
  if (!existsSync(script)) return failed("node, npm, and the browser setup script are required for simulator-web");
  if (!(await available(processAdapter, "npx"))) return failed("npx is not on PATH");
  const versionCheck = await processAdapter.run("npx", ["-y", "@playwright/mcp@latest", "--version"]);
  if (versionCheck.kind !== "ok") return failed("@playwright/mcp could not be executed by npx");
  const root = environment.MEGABRAIN_PLAYWRIGHT_ROOT ?? `${environment.HOME ?? ""}/.megabrain/playwright`;
  const install = await processAdapter.run("node", [script, "install", "--root", root, "--browser", browser]);
  if (install.kind !== "ok") return failed("browser setup failed; run doctor for prerequisites");
  let manifest: { activeBrowser?: string; profiles?: Record<string, { configPath?: string }> };
  try {
    manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8")) as typeof manifest;
  } catch {
    return failed("browser setup did not write the active MCP config");
  }
  const activeBrowser = manifest.activeBrowser ?? "chromium";
  const configPath = manifest.profiles?.[activeBrowser]?.configPath;
  if (configPath === undefined || configPath === "") return failed("browser setup did not write the active MCP config");
  const failedAgents: string[] = [];
  for (const agent of playwrightAgents) {
    if (!(await available(processAdapter, agent))) continue;
    const result = await registerPlaywright(agent, configPath, processAdapter);
    if (result.kind !== "ok") failedAgents.push(agent);
  }
  if (failedAgents.length > 0) return failed(`playwright MCP registration failed for ${failedAgents.join(", ")}`);
  return ok(undefined);
}

// --- tmux-runtime -----------------------------------------------------------------------------

export async function installTmuxRuntime(environment: Environment, processAdapter: ProcessAdapter, options: InstallOptions): Promise<Result<void>> {
  if (!(await available(processAdapter, "tmux"))) {
    const platform = await processAdapter.run("uname", ["-s"]);
    const os = platform.kind === "ok" ? platform.value.stdout.trim() : "";
    if (os === "Darwin") {
      if (!(await available(processAdapter, "brew"))) return failed("tmux is missing. Install it with: brew install tmux");
      const brew = await processAdapter.run("brew", ["install", "tmux"]);
      if (brew.kind !== "ok") return failed("brew install tmux failed");
    } else if (os === "Linux") {
      return failed("tmux is missing. Install it with your package manager, for example: apt install tmux");
    } else {
      return failed("tmux is missing. Install tmux with your operating system package manager");
    }
  }
  const tuneArgs = options.yes ? ["tune", "--yes"] : ["tune"];
  const tuneResult = await executeTmux(tuneArgs, environment, processAdapter);
  if (tuneResult.kind !== "ok") return failed(tuneResult.kind === "failed" ? tuneResult.error : "tmux tuning failed");
  const wrapperArgs = options.yes ? ["wrapper", "--yes"] : ["wrapper"];
  const wrapperResult = await executeTmux(wrapperArgs, environment, processAdapter);
  if (wrapperResult.kind !== "ok") return failed(wrapperResult.kind === "failed" ? wrapperResult.error : "tmux wrapper failed");
  // WHY: the tmux-runtime doctor reads this flag back to decide "enabled" vs "disabled"
  // (report()'s tmux-runtime branch), so it must be recorded before the after-install
  // doctor re-check below, exactly as the shell set state before its own doctor call.
  writeInstalledState(environment, "tmux-runtime", true, "tmux runtime enabled");
  return ok(undefined);
}

