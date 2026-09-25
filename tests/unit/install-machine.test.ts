import { describe, expect, test } from "bun:test";
import { discoverAgentDirectories } from "../../src/cli/commands/install-machine.js";

describe("discoverAgentDirectories", () => {
  test("resolves Claude and Codex directories from their documented environment variables", () => {
    const directories = discoverAgentDirectories({
      HOME: "/home/example",
      CLAUDE_CONFIG_DIR: "/custom/claude",
      CODEX_HOME: "/custom/codex",
    });

    expect(directories.claude).toEqual({
      config: "/custom/claude",
      globalSkill: "/custom/claude/skills/megabrain/SKILL.md",
      projectSkill: ".claude/skills/megabrain/SKILL.md",
      globalInstructions: "/custom/claude/CLAUDE.md",
    });
    expect(directories.codex).toEqual({
      config: "/custom/codex",
      globalSkill: "/custom/codex/skills/megabrain/SKILL.md",
      projectSkill: ".agents/skills/megabrain/SKILL.md",
      globalInstructions: "/custom/codex/AGENTS.md",
    });
  });

  test("uses documented HOME defaults and agy's embedded config layout", () => {
    const directories = discoverAgentDirectories({ HOME: "/home/example" });

    expect(directories.claude.config).toBe("/home/example/.claude");
    expect(directories.codex.config).toBe("/home/example/.codex");
    expect(directories.agy).toEqual({
      config: "/home/example/.gemini/config",
      globalSkill: "/home/example/.gemini/config/skills/megabrain/SKILL.md",
      projectSkill: ".agents/skills/megabrain/SKILL.md",
      globalInstructions: "/home/example/.gemini/config/AGENTS.md",
    });
  });

  test("omits agents whose config cannot be resolved without HOME", () => {
    expect(discoverAgentDirectories({})).toEqual({});
  });
});
