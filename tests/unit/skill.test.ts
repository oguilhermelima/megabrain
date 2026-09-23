import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installSkillSync,
  reconcileSkills,
  reconcileSkillsAtStartup,
  shouldReconcileSkillsAtStartup,
  skillSyncDoctor,
} from "../../src/core/skill.js";

type Fixture = {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly source: string;
  readonly target: string;
};

function fixture(sourceContent: string, targetContent: string | undefined): Fixture {
  const root = mkdtempSync("/tmp/megabrain-skill-root-");
  const home = mkdtempSync("/tmp/megabrain-skill-home-");
  const state = mkdtempSync("/tmp/megabrain-skill-state-");
  const source = join(root, "skills/megabrain/SKILL.md");
  mkdirSync(join(root, "skills/megabrain"), { recursive: true });
  writeFileSync(source, sourceContent);
  const targetDirectory = join(home, ".claude/plugins/cache/megabrain-local/megabrain/0.1.0/skills/megabrain");
  const target = join(targetDirectory, "SKILL.md");
  if (targetContent !== undefined) {
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(target, targetContent);
  }
  return { environment: { HOME: home, MEGABRAIN_ROOT: root, MEGABRAIN_STATE_DIR: state }, source, target };
}

describe("shouldReconcileSkillsAtStartup", () => {
  test("runs for an ordinary command", () => {
    expect(shouldReconcileSkillsAtStartup(["context", "--json"])).toBe(true);
    expect(shouldReconcileSkillsAtStartup([])).toBe(true);
  });

  test("skips when the doctor command is first", () => {
    expect(shouldReconcileSkillsAtStartup(["doctor"])).toBe(false);
    expect(shouldReconcileSkillsAtStartup(["doctor", "skill-sync"])).toBe(false);
  });

  test("does not skip doctor appearing after the first argument", () => {
    expect(shouldReconcileSkillsAtStartup(["context", "doctor"])).toBe(true);
  });

  test("skips when --help appears anywhere in the arguments", () => {
    expect(shouldReconcileSkillsAtStartup(["worktree", "create", "--help"])).toBe(false);
    expect(shouldReconcileSkillsAtStartup(["--help"])).toBe(false);
  });
});

describe("reconcileSkills", () => {
  test("repairs a drifted target", () => {
    const { environment, source, target } = fixture("source content\n", "drifted content\n");
    const scan = reconcileSkills(environment);
    expect(scan.targetCount).toBe(1);
    expect(scan.repairedCount).toBe(1);
    expect(scan.driftCount).toBe(0);
    expect(scan.failureCount).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(readFileSync(source, "utf8"));
  });

  test("is a no-op when the target already matches", () => {
    const { environment } = fixture("same content\n", "same content\n");
    const scan = reconcileSkills(environment);
    expect(scan).toMatchObject({ targetCount: 1, repairedCount: 0, driftCount: 0, failureCount: 0 });
  });

  test("reports a missing installed skill source without a target scan", () => {
    const { environment } = fixture("source content\n", "same content\n");
    const emptyRoot = mkdtempSync("/tmp/megabrain-skill-empty-");
    const scan = reconcileSkills({ ...environment, MEGABRAIN_ROOT: emptyRoot });
    expect(scan.targetCount).toBe(0);
    expect(scan.failureCount).toBe(1);
    expect(scan.error).toContain("installed skill source is missing");
    expect(scan.diagnostics.some((line) => line.includes("installed skill source is missing"))).toBe(true);
  });

  test("reports zero targets when no copies are registered", () => {
    const { environment } = fixture("source content\n", undefined);
    const scan = reconcileSkills(environment);
    expect(scan).toMatchObject({ targetCount: 0, driftCount: 0, repairedCount: 0, failureCount: 0 });
  });

  test("reports an unwritable target directory without failing the scan silently", () => {
    const { environment, target } = fixture("source content\n", "drifted content\n");
    const targetDirectory = join(target, "..");
    const originalMode = statSync(targetDirectory).mode;
    try {
      chmodSync(targetDirectory, 0o555);
      const scan = reconcileSkills(environment);
      expect(scan.failureCount).toBe(1);
      expect(scan.repairedCount).toBe(0);
      expect(scan.error).toContain("skill target is not writable");
      expect(scan.diagnostics.some((line) => line.includes("skill target is not writable"))).toBe(true);
    } finally {
      chmodSync(targetDirectory, originalMode);
    }
  });
});

describe("skillSyncDoctor", () => {
  test("reports drift as a status without repairing it", () => {
    const { environment, source, target } = fixture("source content\n", "drifted content\n");
    const result = skillSyncDoctor(environment);
    expect(result.status).toBe("misconfigured");
    expect(result.reason).toContain("skill drift detected in 1 target(s)");
    expect(readFileSync(target, "utf8")).not.toBe(readFileSync(source, "utf8"));
  });

  test("reports ok when there are no registered copies", () => {
    const { environment } = fixture("source content\n", undefined);
    const result = skillSyncDoctor(environment);
    expect(result).toMatchObject({ status: "ok", reason: "no registered skill copies found" });
  });

  test("reports the current copy count", () => {
    const { environment } = fixture("same content\n", "same content\n");
    const result = skillSyncDoctor(environment);
    expect(result).toMatchObject({ status: "ok", reason: "skill copies current: 1" });
  });

  test("trusts a matching stamp over the target's actual content", () => {
    const { environment, target } = fixture("same length!\n", "same length!\n");
    const first = skillSyncDoctor(environment);
    expect(first).toMatchObject({ status: "ok", reason: "skill copies current: 1" });

    const before = statSync(target);
    writeFileSync(target, "corrupted!!!\n");
    utimesSync(target, before.atime, before.mtime);
    expect(statSync(target).size).toBe(before.size);

    const second = skillSyncDoctor(environment);
    expect(second).toMatchObject({ status: "ok", reason: "skill copies current: 1" });
  });
});

describe("installSkillSync", () => {
  test("repairs drift the same way reconcileSkills does", () => {
    const { environment, source, target } = fixture("source content\n", "drifted content\n");
    const scan = installSkillSync(environment);
    expect(scan.repairedCount).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(readFileSync(source, "utf8"));
  });
});

describe("reconcileSkillsAtStartup", () => {
  test("resolves without diagnostics when nothing needs attention", async () => {
    const { environment } = fixture("same content\n", "same content\n");
    const diagnostics = await reconcileSkillsAtStartup(environment);
    expect(diagnostics).toBeUndefined();
  });

  test("resolves with a diagnostic instead of throwing when repair fails", async () => {
    const { environment, target } = fixture("source content\n", "drifted content\n");
    const targetDirectory = join(target, "..");
    const originalMode = statSync(targetDirectory).mode;
    try {
      chmodSync(targetDirectory, 0o555);
      const diagnostics = await reconcileSkillsAtStartup(environment);
      expect(diagnostics).toBeDefined();
      expect(diagnostics ?? "").toContain("skill target is not writable");
    } finally {
      chmodSync(targetDirectory, originalMode);
    }
  });
});
