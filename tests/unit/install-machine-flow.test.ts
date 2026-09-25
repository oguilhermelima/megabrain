import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMachineInstallArgs, resolveDefaultModules, runMachineInstall } from "../../src/cli/commands/install-machine.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "megabrain-machine-state-"));
  temporaryDirectories.push(directory);
  return directory;
}

function processAdapter(available: readonly string[] = []): ProcessAdapter {
  return {
    async run(command, args) {
      if (command === "which" && available.includes(args[0] ?? "")) return ok({ stdout: `/bin/${args[0]}`, stderr: "", exitCode: 0 });
      return failed(`${command} unavailable`);
    },
    async startDetached() { return failed("not used"); },
    invocationCount() { return 0; },
  };
}

describe("machine install options", () => {
  test("parses explicit selection options and rejects malformed combinations", () => {
    expect(parseMachineInstallArgs(["--agents", "claude,agy", "--skill", "project", "--modules", "worktree,tmux-runtime"])).toEqual({
      agents: ["claude", "agy"],
      skill: "project",
      modules: ["worktree", "tmux-runtime"],
      yes: false,
      provided: true,
    });
    expect(parseMachineInstallArgs(["--agents-md", "global"])).toMatchObject({ kind: "failed", error: "unknown install option: --agents-md" });
    expect(parseMachineInstallArgs(["--modules", "none,worktree"]).kind).toBe("failed");
    expect(parseMachineInstallArgs(["--agents", "gemini"]).kind).toBe("failed");
  });

  test("uses install.sh's module defaults and only adds detected integrations", async () => {
    expect(await resolveDefaultModules({ HOME: "/home/example" }, processAdapter())).toEqual(["orchestration", "orchestration-hooks"]);
    expect(await resolveDefaultModules({ HOME: "/home/example" }, processAdapter(["tmux", "superset"]))).toEqual([
      "tmux-runtime", "orchestration", "orchestration-hooks", "worktree",
    ]);
  });

  test("requires --yes or explicit setup flags when input is not interactive", async () => {
    const result = await runMachineInstall([], { HOME: "/tmp/home" }, processAdapter(), async () => ok(""), false);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") expect(result.error).toContain("--agents");
  });

  test("persists the full selection in existing state and makes a matching rerun a no-op", async () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const stateDirectory = join(root, "state");
    const stateFile = join(stateDirectory, "state.json");
    await Bun.write(stateFile, JSON.stringify({ orchestration: { installed: true } }));
    let installedModules = 0;
    const installModule = async () => {
      installedModules += 1;
      return ok("installed");
    };
    const args = ["--yes", "--agents", "none", "--skill", "none", "--modules", "none"];
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: stateDirectory };

    const first = await runMachineInstall(args, environment, processAdapter(), installModule, false);
    expect(first.kind).toBe("ok");
    expect(existsSync(stateFile)).toBe(true);
    const state: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state).toMatchObject({
      orchestration: { installed: true },
      machineInstall: { agents: [], skill: "none", modules: [], version: expect.any(String) },
    });

    const second = await runMachineInstall(args, environment, processAdapter(), installModule, false);
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") expect(second.value).toContain("already current; no changes made");
    expect(installedModules).toBe(0);
  });

  test("installs skills and modules without creating or changing agent instructions", async () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const codexHome = join(root, "codex");
    const claudeConfig = join(root, "claude");
    const stateDirectory = join(root, "state");
    const project = join(root, "project");
    const codexInstructions = join(codexHome, "AGENTS.md");
    const claudeInstructions = join(claudeConfig, "CLAUDE.md");
    mkdirSync(project, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeConfig, { recursive: true });
    writeFileSync(codexInstructions, "User-authored Codex instructions\n");
    writeFileSync(claudeInstructions, "User-authored Claude instructions\n");
    await Bun.write(join(stateDirectory, "state.json"), JSON.stringify({
      machineInstall: { agents: [], skill: "none", agentsMd: "project", modules: [], version: "old" },
    }));
    const environment = {
      HOME: home,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeConfig,
      MEGABRAIN_STATE_DIR: stateDirectory,
    };

    const result = await runMachineInstall(
      ["--yes", "--agents", "claude,codex,agy", "--skill", "global"],
      environment,
      processAdapter(["claude", "codex", "agy"]),
      async () => ok("installed"),
      false,
    );

    expect(result.kind).toBe("ok");
    expect(existsSync(join(claudeConfig, "skills/megabrain/SKILL.md"))).toBe(true);
    expect(existsSync(join(codexHome, "skills/megabrain/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".gemini/config/skills/megabrain/SKILL.md"))).toBe(true);
    expect(existsSync(claudeInstructions)).toBe(true);
    expect(readFileSync(claudeInstructions, "utf8")).toBe("User-authored Claude instructions\n");
    expect(readFileSync(codexInstructions, "utf8")).toBe("User-authored Codex instructions\n");
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
    const state: unknown = JSON.parse(readFileSync(join(stateDirectory, "state.json"), "utf8"));
    expect(state).toMatchObject({ machineInstall: { agents: ["claude", "codex", "agy"], skill: "global" } });
    expect(JSON.stringify(state)).not.toContain("agentsMd");
  });
});
