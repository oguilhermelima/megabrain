import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

// Captured layouts (frontmatter copied from the operator's real installs, /Users/gui redacted to
// /Users/operator): Grok 1.0.52 reads ~/.grok/skills (here a symlink, as installed), its bundled
// skills and the project's .grok/skills; agy 1.4.0 reads ~/.gemini/config/skills, its built-in skills
// and .agents/skills between the folder and the repository root. The ship and deploy skills are made up.
async function captured(agent: "grok" | "agy"): Promise<{ home: string; repo: string }> {
  const root = await mkdtemp(join(tmpdir(), `megabrain-${agent}-command-fixture-`));
  roots.push(root);
  await cp(join(process.cwd(), "tests", "fixtures", "commands", agent), root, { recursive: true, verbatimSymlinks: true });
  // Git will not keep a .git folder inside the fixture, so the repository root is marked here.
  await mkdir(join(root, "repo", ".git"));
  return { home: join(root, "home"), repo: join(root, "repo") };
}

async function listed(agent: string, cwd: string, home: string): Promise<Array<Record<string, unknown>>> {
  const result = await executeCommands(["--agent", agent, "--cwd", cwd, "--json"], { HOME: home });
  expect(result.kind).toBe("ok");
  return JSON.parse(result.kind === "ok" ? result.value : "[]") as Array<Record<string, unknown>>;
}

describe("Grok and agy command discovery", () => {
  test("lists Grok's built-in commands and its user, bundled and project skills", async () => {
    const { home, repo } = await captured("grok");
    const commands = await listed("grok", join(repo, "app"), home);
    const names = (source: string) => commands.filter((command) => command.source === source).map((command) => command.name);
    expect(names("builtin")).toEqual(expect.arrayContaining(["model", "new", "compact", "skills", "exit"]));
    expect(commands).toContainEqual(expect.objectContaining({ name: "model", source: "builtin", description: "Switch to a different model" }));
    expect(names("skill").sort()).toEqual(["code-review", "orca-cli", "review", "ship"]);
    expect(commands.find((command) => command.name === "orca-cli")?.description).toStartWith("Use the public `orca` CLI to operate Orca-managed worktrees, folder contexts, terminals,");
  });

  test("lists agy's built-in commands and its global, built-in and workspace skills", async () => {
    const { home, repo } = await captured("agy");
    const commands = await listed("agy", join(repo, "packages", "web"), home);
    const names = (source: string) => commands.filter((command) => command.source === source).map((command) => command.name);
    expect(names("builtin")).toEqual(expect.arrayContaining(["help", "clear", "model", "resume", "skills"]));
    expect(names("skill").sort()).toEqual(["agy-customizations", "deploy", "megabrain", "run-workflow"]);
    expect(commands.find((command) => command.name === "megabrain")?.description).toStartWith("Use megabrain to delegate work to other coding agents");
  });

  test("an agent with nothing on disk still answers with its built-in commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-empty-command-fixture-"));
    roots.push(root);
    for (const agent of ["grok", "agy"]) expect((await listed(agent, root, root)).length).toBeGreaterThan(0);
  });

  test("reads a folded description written over several lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-folded-command-fixture-"));
    roots.push(root);
    const skill = join(root, ".claude", "skills", "folded");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: folded\ndescription: >-\n  First line\n  second line.\nother: x\n---\nBody");
    expect(await listed("claude", root, root)).toContainEqual({ name: "folded", description: "First line second line.", source: "skill" });
  });

  test("follows a symlinked Claude skill folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "megabrain-linked-command-fixture-"));
    roots.push(root);
    await mkdir(join(root, "shared", "linked"), { recursive: true });
    await writeFile(join(root, "shared", "linked", "SKILL.md"), "---\nname: linked\ndescription: Linked skill\n---\nBody");
    await mkdir(join(root, ".claude", "skills"), { recursive: true });
    await symlink(join(root, "shared", "linked"), join(root, ".claude", "skills", "linked"));
    expect(await listed("claude", root, root)).toContainEqual({ name: "linked", description: "Linked skill", source: "skill" });
  });
});
