CREATE TABLE hidden_items (
  kind TEXT NOT NULL CHECK (kind IN ('repo', 'worktree')),
  path TEXT NOT NULL,
  PRIMARY KEY (kind, path)
);
