CREATE TABLE IF NOT EXISTS worktrees (
  path TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  purpose TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('created', 'adopted', 'discovered')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS worktrees_repo_created_at ON worktrees(repo, created_at);
