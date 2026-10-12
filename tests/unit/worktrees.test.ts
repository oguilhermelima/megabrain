import { describe, expect, test } from "bun:test";
import { guardedOpenDatabase } from "./state-db-guard.js";
import { latestSchemaVersion } from "../../src/db/db.js";
import { insertWorktree, finishWorktree, getWorktree, listWorktrees } from "../../src/db/queries/worktrees.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("worktree registry", () => {
  test("schema 9 stores worktree parent relations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "megabrain-worktrees-"));
    const opened = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(latestSchemaVersion).toBe(12);
      expect(opened.value.db.query<{ name: string }>("PRAGMA table_info(worktrees)").all().map(({ name }) => name)).toEqual([
        "path", "repo", "repo_name", "branch", "created_at", "created_by", "purpose", "origin", "finished_at", "parent_branch",
      ]);
    } finally {
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("schema 8 upgrade backs up the existing registry before adding parent relations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "megabrain-worktrees-v8-"));
    const opened = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    opened.value.db.run("INSERT INTO worktrees (path, repo, repo_name, branch, created_at, origin) VALUES (?, ?, ?, ?, ?, ?)", ["/trees/old", "/repos/app", "app", "old", "2026-01-01T00:00:00.000Z", "created"]);
    opened.value.db.run("DELETE FROM schema_migrations WHERE version > 8");
    opened.value.db.run("DROP TABLE resource_samples");
    opened.value.db.exec("DROP INDEX IF EXISTS worktrees_repo_parent_branch; ALTER TABLE worktrees DROP COLUMN parent_branch;");
    opened.value.db.exec("PRAGMA user_version = 8");
    opened.value.close();
    const upgraded = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(upgraded.kind).toBe("ok");
    if (upgraded.kind !== "ok") throw new Error(upgraded.error);
    try {
      expect(upgraded.value.db.query<{ parent_branch: string | null }>("SELECT parent_branch FROM worktrees WHERE path = ?").get("/trees/old")).toEqual({ parent_branch: null });
      expect(upgraded.value.db.query<{ user_version: number }>("PRAGMA user_version").get()?.user_version).toBe(12);
      expect(upgraded.value.db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('outbox', 'resource_samples') ORDER BY name").all()).toEqual([
        { name: "outbox" },
        { name: "resource_samples" },
      ]);
      const backups = await (await import("node:fs/promises")).readdir(join(directory, "backups"));
      expect(backups.length).toBeGreaterThan(0);
    } finally {
      upgraded.value.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("records worktree lifecycle and preserves creation metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "megabrain-worktrees-"));
    const opened = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      const record = { path: "/trees/feature", repo: "/repos/project", repoName: "Project", branch: "feature", createdAt: "2026-01-01T00:00:00.000Z", createdBy: "session-1", purpose: "Implement feature", origin: "created" as const };
      insertWorktree(opened.value.db, record);
      expect(getWorktree(opened.value.db, record.path)).toMatchObject({ ...record, finishedAt: null });
      finishWorktree(opened.value.db, record.path, "2026-01-02T00:00:00.000Z");
      expect(listWorktrees(opened.value.db)).toMatchObject([{ ...record, finishedAt: "2026-01-02T00:00:00.000Z" }]);
    } finally {
      opened.value.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
