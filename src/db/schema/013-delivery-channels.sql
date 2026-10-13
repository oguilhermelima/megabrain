CREATE TABLE IF NOT EXISTS delivery_channels (
  agent TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('working', 'broken')),
  agent_version TEXT,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  last_error TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  retry_after TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent, channel)
);
