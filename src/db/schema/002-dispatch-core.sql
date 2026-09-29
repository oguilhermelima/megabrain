CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('spawning', 'running', 'waiting_for_reply', 'done', 'failed', 'orphaned', 'closed', 'circuit_broken')),
  owner_session_id TEXT,
  parent_host TEXT,
  parent_terminal_id TEXT,
  agent TEXT,
  model TEXT,
  effort TEXT,
  worktree_path TEXT,
  branch TEXT,
  host TEXT,
  runtime TEXT,
  child_host TEXT,
  tmux_session_id TEXT,
  tmux_session TEXT,
  tmux_pane TEXT,
  terminal_id TEXT,
  agent_thread_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  extra TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX dispatches_owner_state_idx ON dispatches(owner_session_id, state);
CREATE INDEX dispatches_archived_at_idx ON dispatches(archived_at);
CREATE INDEX dispatches_tmux_identity_idx ON dispatches(tmux_session_id, tmux_pane);
CREATE INDEX dispatches_terminal_id_idx ON dispatches(terminal_id);

CREATE TABLE messages (
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  "from" TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  body TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  idempotency_key TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(dispatch_id, seq)
);

CREATE UNIQUE INDEX messages_idempotency_key_idx ON messages(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX messages_dispatch_idx ON messages(dispatch_id, seq);

CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  message_seq INTEGER,
  message_seqs TEXT NOT NULL,
  consumer TEXT,
  generation INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  fenced_at TEXT,
  extra TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX deliveries_dispatch_status_idx ON deliveries(dispatch_id, status);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT REFERENCES dispatches(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  transport TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE leases (
  key TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE terminals (
  terminal_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE install_state (
  module_id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  value TEXT NOT NULL,
  registry_extra TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(agent, model)
);

CREATE TABLE tmux_sessions (
  session_name TEXT PRIMARY KEY,
  stable_session_id TEXT,
  value TEXT NOT NULL
);

CREATE UNIQUE INDEX tmux_sessions_stable_id_idx ON tmux_sessions(stable_session_id) WHERE stable_session_id IS NOT NULL;
