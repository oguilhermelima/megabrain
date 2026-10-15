CREATE TABLE repositories (
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  remote TEXT,
  source TEXT NOT NULL CHECK (source IN ('megabrain', 'import')),
  added_at TEXT NOT NULL
);

CREATE INDEX repositories_name ON repositories(name);
