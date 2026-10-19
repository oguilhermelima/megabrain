import { describe, expect, test } from "bun:test";
import { agentCommand } from "../../src/adapters/agent-command.js";
import type { ProcessAdapter } from "../../src/adapters/proc.js";
import { executeAgent } from "../../src/cli/commands/agent.js";
import { failed, ok } from "../../src/core/result.js";

// Answers `command -v <agent>` for the agents in `installed`; anything else is not on PATH.
function fakeProcess(installed: readonly string[]): ProcessAdapter {
  return {
    run: async (_command, args) => {
      const script = args.at(-1) ?? "";
      const found = installed.find((agent) => script.endsWith(` ${agent}`));
      return found === undefined ? failed("not found", 1) : ok({ stdout: `/bin/${found}\n`, stderr: "", exitCode: 0 });
    },
    startDetached: async () => failed("a TUI is never started here"),
    invocationCount: () => 0,
  };
}

const all = fakeProcess(["claude", "codex", "grok", "agy"]);

describe("agent command", () => {
  test("every agent starts its own TUI with permission prompts skipped", async () => {
    expect(await agentCommand("claude", {}, all)).toEqual(["claude", "--dangerously-skip-permissions"]);
    expect(await agentCommand("codex", {}, all)).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false"]);
    expect(await agentCommand("grok", {}, all)).toEqual(["grok", "--always-approve"]);
    expect(await agentCommand("agy", {}, all)).toEqual(["agy", "--dangerously-skip-permissions"]);
  });

  test("model and effort use the flags each CLI really accepts", async () => {
    const options = { model: "m1", effort: "high" };
    expect(await agentCommand("claude", options, all)).toEqual(["claude", "--dangerously-skip-permissions", "--model", "m1", "--effort", "high"]);
    expect(await agentCommand("codex", options, all)).toEqual(["codex", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false", "-c", "model=m1", "-c", "model_reasoning_effort=high"]);
    expect(await agentCommand("grok", options, all)).toEqual(["grok", "--always-approve", "-m", "m1", "--reasoning-effort", "high"]);
    expect(await agentCommand("agy", options, all)).toEqual(["agy", "--dangerously-skip-permissions", "--model", "m1-high"]);
  });

  test("a model alone leaves effort out", async () => {
    expect(await agentCommand("claude", { model: "m1" }, all)).toEqual(["claude", "--dangerously-skip-permissions", "--model", "m1"]);
  });

  test("an agent that is not installed is refused by name", async () => {
    await expect(agentCommand("grok", {}, fakeProcess(["claude"]))).rejects.toThrow("grok is not installed");
  });

  test("an unknown agent is refused", async () => {
    await expect(agentCommand("gemini", {}, all)).rejects.toThrow("unknown agent: gemini");
  });
});

describe("agent command line", () => {
  test("agent update has its own help text", async () => {
    const result = await executeAgent(["update", "codex", "--help"], {}, all);
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.value : "").toContain("agent update [<codex|claude|grok|agy|all>] [--check] [--json]");
  });

  test("--json prints the agent and its argv", async () => {
    const result = await executeAgent(["command", "codex", "--model", "m1", "--effort", "low", "--json"], {}, all);
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.kind === "ok" ? result.value : "null")).toEqual({
      agent: "codex",
      argv: ["codex", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false", "-c", "model=m1", "-c", "model_reasoning_effort=low"],
      builtin: ["codex", "--dangerously-bypass-approvals-and-sandbox", "-c", "check_for_update_on_startup=false"],
    });
  });

  test("a missing CLI exits 1 with a clear message", async () => {
    const result = await executeAgent(["command", "agy", "--json"], {}, fakeProcess([]));
    expect(result).toMatchObject({ kind: "failed", exitCode: 1 });
    expect(result.kind === "failed" ? result.error : "").toContain("agy is not installed");
  });

  test("bad usage exits 2", async () => {
    for (const args of [["command"], ["command", "gemini"], ["command", "claude", "--model"], ["command", "claude", "--bogus"], ["other", "claude"]]) {
      expect(await executeAgent(args, {}, all)).toMatchObject({ kind: "failed", exitCode: 2 });
    }
  });
});
