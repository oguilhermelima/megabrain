CREATE TABLE resource_samples (
  id INTEGER PRIMARY KEY,
  dispatch_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  rss_bytes INTEGER NOT NULL CHECK (rss_bytes >= 0),
  cpu_percent REAL NOT NULL CHECK (cpu_percent >= 0)
);
CREATE INDEX resource_samples_agent_time ON resource_samples(agent, sampled_at);
CREATE INDEX resource_samples_dispatch_time ON resource_samples(dispatch_id, sampled_at);
