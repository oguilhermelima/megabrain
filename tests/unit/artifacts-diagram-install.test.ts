import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProcessAdapter } from "../../src/adapters/proc.js";
import { executeDoctor, executeInstall } from "../../src/cli/commands/install-doctor.js";
import { DIAGRAM_DESIGN_COMMIT } from "../../src/cli/commands/artifacts-diagram-install.js";

// The module never reaches the network here: MEGABRAIN_DIAGRAM_DESIGN_SOURCE names a tarball built
// below in the shape GitHub's codeload serves (one top folder, the skill under skills/diagram-design).

const adapter = createProcessAdapter();
const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true }); });

function fakeSource(root: string): string {
  const top = join(root, "source", `diagram-design-${DIAGRAM_DESIGN_COMMIT}`);
  mkdirSync(join(top, "skills", "diagram-design", "references"), { recursive: true });
  writeFileSync(join(top, "LICENSE"), "MIT License\n\nCopyright (c) 2025 Cathryn Lavery\n");
  writeFileSync(join(top, "THIRD_PARTY_LICENSES.md"), "# Third-party licenses\n");
  writeFileSync(join(top, "README.md"), "not part of the skill\n");
  writeFileSync(join(top, "skills", "diagram-design", "SKILL.md"), "---\nname: diagram-design\n---\n\n# Diagram Design\n");
  writeFileSync(join(top, "skills", "diagram-design", "references", "type-flowchart.md"), "# Flowchart\n");
  const tarball = join(root, "diagram-design.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", join(root, "source"), `diagram-design-${DIAGRAM_DESIGN_COMMIT}`]);
  return tarball;
}

/** A temp HOME where Claude and Codex are configured and agy and Grok are not. */
function sandbox(agents: readonly string[] = [".claude", ".codex"]) {
  const root = mkdtempSync(join(tmpdir(), "mb-artifacts-diagram-"));
  roots.push(root);
  const home = join(root, "home");
  for (const agent of agents) mkdirSync(join(home, agent), { recursive: true });
  const environment = { PATH: process.env.PATH, HOME: home, MEGABRAIN_STATE_DIR: join(root, "state"), MEGABRAIN_DIAGRAM_DESIGN_SOURCE: fakeSource(root) };
  return { root, home, environment };
}

const claudeSkill = (home: string) => join(home, ".claude", "skills", "diagram-design");
const codexSkill = (home: string) => join(home, ".codex", "skills", "diagram-design");

async function doctor(environment: Record<string, string | undefined>) {
  const result = await executeDoctor(["artifacts-diagram", "--json"], environment, adapter);
  if (result.kind !== "ok") throw new Error("doctor failed to run");
  return JSON.parse(result.value) as { module: string; status: string; reason: string };
}

describe("artifacts-diagram module", () => {
  test("the pinned commit is a full SHA", () => {
    expect(DIAGRAM_DESIGN_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });

  test("install copies the skill and its licences for every configured agent, and only those", async () => {
    const { home, environment } = sandbox();
    const result = await executeInstall(["artifacts-diagram"], environment, adapter);
    expect(result.kind).toBe("ok");
    for (const target of [claudeSkill(home), codexSkill(home)]) {
      expect(readFileSync(join(target, "SKILL.md"), "utf8")).toContain("# Diagram Design");
      expect(readFileSync(join(target, "LICENSE"), "utf8")).toContain("Cathryn Lavery");
      expect(existsSync(join(target, "THIRD_PARTY_LICENSES.md"))).toBe(true);
      expect(existsSync(join(target, "references", "type-flowchart.md"))).toBe(true);
      expect(existsSync(join(target, "README.md"))).toBe(false);
    }
    expect(existsSync(join(home, ".gemini"))).toBe(false);
    expect(existsSync(join(home, ".grok"))).toBe(false);
  });

  test("agy and Grok get the skill in their own skill folders when configured", async () => {
    const { home, environment } = sandbox([".gemini/config", ".grok"]);
    expect((await executeInstall(["artifacts-diagram"], environment, adapter)).kind).toBe("ok");
    expect(existsSync(join(home, ".gemini", "config", "skills", "diagram-design", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".grok", "skills", "diagram-design", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("the installed skill tells agents to save diagrams with megabrain artifact create", async () => {
    const { home, environment } = sandbox();
    await executeInstall(["artifacts-diagram"], environment, adapter);
    expect(readFileSync(join(claudeSkill(home), "SKILL.md"), "utf8")).toContain("megabrain artifact create");
  });

  test("doctor is missing before install, ok after, and names the pinned commit", async () => {
    const { environment } = sandbox();
    expect((await doctor(environment)).status).toBe("missing");
    await executeInstall(["artifacts-diagram"], environment, adapter);
    const after = await doctor(environment);
    expect(after.status).toBe("ok");
    expect(after.reason).toContain(DIAGRAM_DESIGN_COMMIT.slice(0, 12));
  });

  test("doctor is misconfigured when one agent's copy is gone", async () => {
    const { home, environment } = sandbox();
    await executeInstall(["artifacts-diagram"], environment, adapter);
    rmSync(codexSkill(home), { recursive: true, force: true });
    const report = await doctor(environment);
    expect(report.status).toBe("misconfigured");
    expect(report.reason).toContain("codex");
  });

  test("a diagram-design skill megabrain did not install is left alone by install and revert", async () => {
    const { home, environment } = sandbox();
    mkdirSync(claudeSkill(home), { recursive: true });
    writeFileSync(join(claudeSkill(home), "SKILL.md"), "the person's own copy\n");
    expect((await executeInstall(["artifacts-diagram"], environment, adapter)).kind).toBe("ok");
    expect(readFileSync(join(claudeSkill(home), "SKILL.md"), "utf8")).toBe("the person's own copy\n");
    expect(existsSync(join(codexSkill(home), "SKILL.md"))).toBe(true);
    expect((await executeInstall(["artifacts-diagram", "--revert"], environment, adapter)).kind).toBe("ok");
    expect(readFileSync(join(claudeSkill(home), "SKILL.md"), "utf8")).toBe("the person's own copy\n");
    expect(existsSync(codexSkill(home))).toBe(false);
  });

  test("revert removes only the module's copies and keeps the rest of each skills folder", async () => {
    const { home, environment } = sandbox();
    mkdirSync(join(home, ".claude", "skills", "megabrain"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "megabrain", "SKILL.md"), "megabrain\n");
    await executeInstall(["artifacts-diagram"], environment, adapter);
    const reverted = await executeInstall(["artifacts-diagram", "--revert"], environment, adapter);
    expect(reverted.kind).toBe("ok");
    expect(existsSync(claudeSkill(home))).toBe(false);
    expect(existsSync(codexSkill(home))).toBe(false);
    expect(readFileSync(join(home, ".claude", "skills", "megabrain", "SKILL.md"), "utf8")).toBe("megabrain\n");
    expect((await doctor(environment)).status).toBe("missing");
  });

  test("a reinstall replaces the module's own copy", async () => {
    const { home, environment } = sandbox();
    await executeInstall(["artifacts-diagram"], environment, adapter);
    writeFileSync(join(claudeSkill(home), "stale.md"), "left from an older version\n");
    expect((await executeInstall(["artifacts-diagram"], environment, adapter)).kind).toBe("ok");
    expect(existsSync(join(claudeSkill(home), "stale.md"))).toBe(false);
  });

  test("install fails without touching any agent when the source is missing", async () => {
    const { home, environment } = sandbox();
    const result = await executeInstall(["artifacts-diagram"], { ...environment, MEGABRAIN_DIAGRAM_DESIGN_SOURCE: join(home, "nope.tar.gz") }, adapter);
    expect(result.kind).toBe("failed");
    expect(existsSync(join(home, ".claude", "skills"))).toBe(false);
  });

  test("install fails when no agent is configured", async () => {
    const { environment } = sandbox([]);
    const result = await executeInstall(["artifacts-diagram"], environment, adapter);
    expect(result.kind).toBe("failed");
  });
});
