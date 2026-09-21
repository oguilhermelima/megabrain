CREATE TABLE native_sessions (
  udid TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  PRIMARY KEY (udid, bundle_id)
);

CREATE TABLE native_sessions_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
