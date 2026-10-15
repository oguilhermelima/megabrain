CREATE TABLE IF NOT EXISTS repository_pull_requests (
  repository_path TEXT PRIMARY KEY REFERENCES repositories(path) ON DELETE CASCADE,
  value_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
