ALTER TABLE outbox ADD COLUMN lease_holder TEXT;
ALTER TABLE outbox ADD COLUMN detail TEXT;

CREATE TABLE waiters (
  dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL,
  parent_session_id TEXT,
  parent_host TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE nudge_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  pointer TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX nudge_events_dispatch_idx ON nudge_events(dispatch_id, id);
