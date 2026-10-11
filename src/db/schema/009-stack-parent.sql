ALTER TABLE worktrees ADD COLUMN parent_branch TEXT;

CREATE INDEX IF NOT EXISTS worktrees_repo_parent_branch ON worktrees(repo, parent_branch);
