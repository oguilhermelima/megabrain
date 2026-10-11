import { describe, expect, test } from "bun:test";
import { guardedOpenDatabase } from "./state-db-guard.js";
import { latestSchemaVersion } from "../../src/db/db.js";
import { insertWorktree, finishWorktree, getWorktree, listWorktrees } from "../../src/db/queries/worktrees.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("worktree registry", () => {
  test("schema 8 stores provenance, purpose and finish time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "megabrain-worktrees-"));
    const opened = guardedOpenDatabase({ MEGABRAIN_STATE_DIR: directory });
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") throw new Error(opened.error);
    try {
      expect(latestSchemaVersion).toBe(8);
      expect(opened.value.db.query<{ name: string }>("PRAGMA table_info(worktrees)").all().map(({ name }) => name)).toEqual([
        "path", "repo", "repo_name", "branch", "created_at", "created_by", "purpose", "origin", "finished_at",
      ]);
    } finally {
      opened.value.close();
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
