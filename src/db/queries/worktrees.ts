import type { DatabaseAdapter } from "../db.js";

export type WorktreeOrigin = "created" | "adopted" | "discovered";
export type WorktreeRecord = Readonly<{
  path: string;
  repo: string;
  branch: string;
  createdAt: string;
  createdBy: string | null;
  purpose: string | null;
  origin: WorktreeOrigin;
  finishedAt: string | null;
}>;

type WorktreeRow = Readonly<{
  path: string; repo: string; branch: string; created_at: string; created_by: string | null;
  purpose: string | null; origin: WorktreeOrigin; finished_at: string | null;
}>;

function fromRow(row: WorktreeRow): WorktreeRecord {
  return { path: row.path, repo: row.repo, branch: row.branch, createdAt: row.created_at, createdBy: row.created_by, purpose: row.purpose, origin: row.origin, finishedAt: row.finished_at };
}

export function insertWorktree(db: DatabaseAdapter, worktree: WorktreeRecord): void {
  db.run("INSERT INTO worktrees (path, repo, branch, created_at, created_by, purpose, origin, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [worktree.path, worktree.repo, worktree.branch, worktree.createdAt, worktree.createdBy, worktree.purpose, worktree.origin, worktree.finishedAt]);
}

export function upsertWorktree(db: DatabaseAdapter, worktree: WorktreeRecord): void {
  db.run("INSERT INTO worktrees (path, repo, branch, created_at, created_by, purpose, origin, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET repo = excluded.repo, branch = excluded.branch, created_by = excluded.created_by, purpose = excluded.purpose, origin = excluded.origin, finished_at = excluded.finished_at", [worktree.path, worktree.repo, worktree.branch, worktree.createdAt, worktree.createdBy, worktree.purpose, worktree.origin, worktree.finishedAt]);
}

export function getWorktree(db: DatabaseAdapter, path: string): WorktreeRecord | undefined {
  const row = db.query<WorktreeRow>("SELECT * FROM worktrees WHERE path = ?").get(path);
  return row === null ? undefined : fromRow(row);
}

export function listWorktrees(db: DatabaseAdapter, repo?: string): WorktreeRecord[] {
  const rows = repo === undefined
    ? db.query<WorktreeRow>("SELECT * FROM worktrees ORDER BY path").all()
    : db.query<WorktreeRow>("SELECT * FROM worktrees WHERE repo = ? ORDER BY path").all(repo);
  return rows.map(fromRow);
}

export function finishWorktree(db: DatabaseAdapter, path: string, finishedAt: string): boolean {
  return db.run("UPDATE worktrees SET finished_at = ? WHERE path = ? AND finished_at IS NULL", [finishedAt, path]).changes > 0;
}
