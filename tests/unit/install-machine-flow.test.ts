import { describe, expect, test } from "bun:test";
import { parseMachineInstallArgs, resolveDefaultModules, runMachineInstall } from "../../src/cli/commands/install-machine.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { failed, ok } from "../../src/core/result.js";

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
});
