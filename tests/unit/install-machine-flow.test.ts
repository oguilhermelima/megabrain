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

  test("omits default modules whose detectable runtime prerequisites are absent", async () => {
    expect(await resolveDefaultModules({ HOME: "/home/example" }, processAdapter())).toEqual(["orchestration-hooks"]);
    expect(await resolveDefaultModules({ HOME: "/home/example" }, processAdapter(["tmux", "superset", "orca"]))).toEqual([
      "tmux-runtime", "orchestration", "orchestration-hooks", "worktree",
    ]);
    expect(await resolveDefaultModules({ HOME: "/home/example" }, processAdapter(["superset"]))).toEqual([
      "orchestration", "orchestration-hooks",
    ]);
  });

  test("keeps installing after a module fails, persists successes, and retries only failures", async () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const stateDirectory = join(root, "state");
    const skill = join(home, ".claude/skills/megabrain/SKILL.md");
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: stateDirectory };
    const args = ["--yes", "--agents", "claude", "--modules", "orchestration,worktree"];
    const calls: string[] = [];
    let orchestrationFailures = 1;
    const installModule = async (module: string) => {
      calls.push(module);
      if (module === "orchestration" && orchestrationFailures > 0) {
        orchestrationFailures -= 1;
        return failed("no orchestration runtime is available");
      }
      return ok("installed");
    };

    const first = await runMachineInstall(args, environment, processAdapter(["claude"]), installModule, false);
    expect(first.kind).toBe("failed");
    if (first.kind === "failed") {
      expect(first.error).toContain("orchestration: no orchestration runtime is available");
      expect(first.error).toContain("machine install summary: configured worktree; failed orchestration");
    }
    expect(calls).toEqual(["orchestration", "worktree"]);
    expect(existsSync(skill)).toBe(true);
    const firstState = JSON.parse(readFileSync(join(stateDirectory, "state.json"), "utf8")) as Record<string, unknown>;
    expect(firstState.machineInstall).toMatchObject({
      agents: ["claude"],
      skill: "global",
      modules: ["worktree"],
      requestedModules: ["orchestration", "worktree"],
    });

    writeFileSync(skill, "keep the already configured skill\n");
    const second = await runMachineInstall(args, environment, processAdapter(["claude"]), installModule, false);
    expect(second.kind).toBe("ok");
    expect(calls).toEqual(["orchestration", "worktree", "orchestration"]);
    expect(readFileSync(skill, "utf8")).toBe("keep the already configured skill\n");

    const third = await runMachineInstall(args, environment, processAdapter(["claude"]), installModule, false);
    expect(third.kind).toBe("ok");
    if (third.kind === "ok") expect(third.value).toContain("already current; no changes made");
    expect(calls).toEqual(["orchestration", "worktree", "orchestration"]);
  });

  test("reports default modules skipped for missing prerequisites and explicit selection still attempts them", async () => {
    const root = temporaryDirectory();
    const environment = { HOME: join(root, "home"), MEGABRAIN_STATE_DIR: join(root, "state") };
    let attempts = 0;
    const installModule = async (module: string) => {
      attempts += 1;
      return module === "orchestration" ? failed("no orchestration runtime is available") : ok("installed");
    };

    const defaultResult = await runMachineInstall(["--yes", "--agents", "none"], environment, processAdapter(), installModule, false);
    expect(defaultResult.kind).toBe("ok");
    if (defaultResult.kind === "ok") {
      expect(defaultResult.value).toContain("orchestration skipped: no orca, superset, or tmux runtime detected");
      expect(defaultResult.exitCode ?? 0).toBe(0);
    }
    expect(attempts).toBe(1);

    const noOp = await runMachineInstall(["--yes", "--agents", "none"], environment, processAdapter(), installModule, false);
    expect(noOp.kind).toBe("ok");
    if (noOp.kind === "ok") {
      expect(noOp.value).toContain("orchestration skipped: no orca, superset, or tmux runtime detected");
      expect(noOp.value).toContain("already current; no changes made");
      expect(noOp.exitCode ?? 0).toBe(0);
    }
    expect(attempts).toBe(1);

    const explicit = await runMachineInstall(["--yes", "--agents", "none", "--modules", "orchestration"], environment, processAdapter(), installModule, false);
    expect(explicit.kind).toBe("failed");
    if (explicit.kind === "failed") {
      expect(explicit.error).toContain("failed orchestration");
      expect(explicit.exitCode).toBe(1);
    }
    expect(attempts).toBe(2);
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
