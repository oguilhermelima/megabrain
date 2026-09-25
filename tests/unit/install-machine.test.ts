import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentInstructions, installAgentSkills } from "../../src/cli/commands/install-machine.js";
import { discoverAgentDirectories } from "../../src/core/agent-directories.js";
import { skillTargetPaths } from "../../src/core/skill.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "megabrain-install-machine-"));
  temporaryDirectories.push(directory);
  return directory;
}

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

  test("copies the package skill to selected global or project agent directories", () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    const packageSkill = join(root, "package", "skills", "megabrain", "SKILL.md");
    mkdirSync(join(root, "package", "skills", "megabrain"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(packageSkill, "megabrain skill\n");
    const directories = discoverAgentDirectories({ HOME: home });

    const globalResult = installAgentSkills(packageSkill, ["claude", "agy"], "global", directories, project);
    expect(globalResult).toEqual([directories.claude?.globalSkill, directories.agy?.globalSkill]);
    expect(readFileSync(join(home, ".claude/skills/megabrain/SKILL.md"), "utf8")).toBe("megabrain skill\n");
    expect(readFileSync(join(home, ".gemini/config/skills/megabrain/SKILL.md"), "utf8")).toBe("megabrain skill\n");
    expect(skillTargetPaths({ HOME: home })).toContain(join(home, ".gemini/config/skills/megabrain/SKILL.md"));

    installAgentSkills(packageSkill, ["codex", "agy"], "project", directories, project);
    expect(readFileSync(join(project, ".agents/skills/megabrain/SKILL.md"), "utf8")).toBe("megabrain skill\n");
  });

  test("inserts and updates the megabrain pointer without changing other instructions", () => {
    const root = temporaryDirectory();
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(project, { recursive: true });
    const directories = discoverAgentDirectories({ HOME: home });
    const pointer = "# megabrain recipes";
    const projectFile = join(project, "AGENTS.md");
    writeFileSync(projectFile, "# Existing rules\n\nKeep this text.\n");

    installAgentInstructions(["claude", "codex", "agy"], "global", directories, project, pointer);
    installAgentInstructions([], "project", directories, project, pointer);

    expect(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8")).toBe(`${pointer}\n`);
    expect(readFileSync(join(home, ".codex/AGENTS.md"), "utf8")).toBe(`${pointer}\n`);
    expect(readFileSync(join(home, ".gemini/config/AGENTS.md"), "utf8")).toBe(`${pointer}\n`);
    expect(readFileSync(projectFile, "utf8")).toBe(`${pointer}\n# Existing rules\n\nKeep this text.\n`);

    writeFileSync(projectFile, "# megabrain recipes old\n\nKeep this text.\n");
    installAgentInstructions([], "project", directories, project, pointer);
    expect(readFileSync(projectFile, "utf8")).toBe(`${pointer}\n\nKeep this text.\n`);
  });
});
