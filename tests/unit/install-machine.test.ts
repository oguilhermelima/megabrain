import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentSkills, parseMachineInstallArgs, retireLegacyChannels } from "../../src/cli/commands/install-machine.js";
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
    });
    expect(directories.codex).toEqual({
      config: "/custom/codex",
      globalSkill: "/custom/codex/skills/megabrain/SKILL.md",
      projectSkill: ".agents/skills/megabrain/SKILL.md",
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

});

describe("grok as an installable agent", () => {
  test("resolves Grok's skill directories from GROK_HOME or HOME", () => {
    expect(discoverAgentDirectories({ HOME: "/home/example" }).grok).toEqual({
      config: "/home/example/.grok",
      globalSkill: "/home/example/.grok/skills/megabrain/SKILL.md",
      projectSkill: ".grok/skills/megabrain/SKILL.md",
    });
    expect(discoverAgentDirectories({ HOME: "/home/example", GROK_HOME: "/custom/grok" }).grok?.globalSkill).toBe("/custom/grok/skills/megabrain/SKILL.md");
  });

  test("--agents accepts grok and installs its skill", () => {
    expect(parseMachineInstallArgs(["--agents", "grok,claude"])).toMatchObject({ agents: ["grok", "claude"] });
    const root = temporaryDirectory();
    const home = join(root, "home");
    const packageSkill = join(root, "package", "skills", "megabrain", "SKILL.md");
    mkdirSync(join(root, "package", "skills", "megabrain"), { recursive: true });
    writeFileSync(packageSkill, "megabrain skill\n");
    const directories = discoverAgentDirectories({ HOME: home });
    installAgentSkills(packageSkill, ["grok"], "global", directories, root);
    expect(readFileSync(join(home, ".grok/skills/megabrain/SKILL.md"), "utf8")).toBe("megabrain skill\n");
    expect(skillTargetPaths({ HOME: home })).toContain(join(home, ".grok/skills/megabrain/SKILL.md"));
  });

  test("never asks Grok about legacy plugins it never had", async () => {
    const calls: string[] = [];
    const adapter = {
      async run(command: string, args: readonly string[]) { calls.push(`${command} ${args.join(" ")}`); return { kind: "ok" as const, value: { stdout: "", stderr: "", exitCode: 0 } }; },
      async startDetached() { return { kind: "failed" as const, error: "unavailable", exitCode: 1 }; },
      invocationCount: () => 0,
    };
    expect((await retireLegacyChannels(["grok"], adapter, true, undefined)).kind).toBe("ok");
    expect(calls.filter((call) => call.startsWith("grok "))).toEqual([]);
  });
});
