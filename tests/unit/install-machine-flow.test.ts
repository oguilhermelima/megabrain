import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(parseMachineInstallArgs(["--agents", "claude,agy", "--skill", "project", "--agents-md", "none", "--modules", "worktree,tmux-runtime"])).toEqual({
      agents: ["claude", "agy"],
      skill: "project",
      agentsMd: "none",
      modules: ["worktree", "tmux-runtime"],
      yes: false,
      provided: true,
    });
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
    const args = ["--yes", "--agents", "none", "--skill", "none", "--agents-md", "none", "--modules", "none"];
    const environment = { HOME: home, MEGABRAIN_STATE_DIR: stateDirectory };

    const first = await runMachineInstall(args, environment, processAdapter(), installModule, false);
    expect(first.kind).toBe("ok");
    expect(existsSync(stateFile)).toBe(true);
    const state: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state).toMatchObject({
      orchestration: { installed: true },
      machineInstall: { agents: [], skill: "none", agentsMd: "none", modules: [], version: expect.any(String) },
    });

    const second = await runMachineInstall(args, environment, processAdapter(), installModule, false);
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") expect(second.value).toContain("already current; no changes made");
    expect(installedModules).toBe(0);
  });
});
