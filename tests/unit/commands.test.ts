import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCommands } from "../../src/cli/commands/commands.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent command discovery", () => {
  test("reads user and project Claude commands and skills from frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-command-fixture-"));
    roots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    const userCommands = join(home, ".claude", "commands", "nested");
    const projectSkills = join(cwd, ".claude", "skills", "review-skill");
    await mkdir(userCommands, { recursive: true });
    await mkdir(join(cwd, ".claude", "commands"), { recursive: true });
    await mkdir(projectSkills, { recursive: true });
    await writeFile(join(userCommands, "inspect.md"), "---\ndescription: Inspect code\nargument-hint: <path>\n---\nBody");
    await writeFile(join(cwd, ".claude", "commands", "local.md"), "---\ndescription: Local command\n---\nBody");
    await writeFile(join(projectSkills, "SKILL.md"), "---\nname: Review\ndescription: Review changes\n---\nBody");

    const result = await executeCommands(["--agent", "claude", "--cwd", cwd, "--json"], { HOME: home });
    expect(result.kind).toBe("ok");
    const commands = JSON.parse(result.kind === "ok" ? result.value : "[]") as Array<Record<string, unknown>>;
    expect(commands).toContainEqual({ name: "nested:inspect", description: "Inspect code", source: "user", argumentHint: "<path>" });
    expect(commands).toContainEqual({ name: "local", description: "Local command", source: "project", argumentHint: null });
    expect(commands).toContainEqual({ name: "Review", description: "Review changes", source: "skill" });
    expect(commands.some((command) => command.source === "builtin")).toBe(true);
  });

  test("reads Codex prompts from the user's prompt folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-codex-command-fixture-"));
    roots.push(root);
    const prompts = join(root, ".codex", "prompts");
    await mkdir(prompts, { recursive: true });
    await writeFile(join(prompts, "explain.md"), "---\ndescription: Explain a change\n---\nPrompt");
    const result = await executeCommands(["--agent", "codex", "--cwd", root, "--json"], { HOME: root });
    expect(result.kind).toBe("ok");
    expect(JSON.parse(result.kind === "ok" ? result.value : "[]")).toContainEqual({ name: "explain", description: "Explain a change", source: "user" });
  });
});
