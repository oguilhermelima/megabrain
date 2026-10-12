CREATE TABLE dispatches_with_queue_state (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'spawning', 'running', 'waiting_for_reply', 'done', 'failed', 'orphaned', 'closed', 'circuit_broken')),
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
  extra TEXT NOT NULL DEFAULT '{}',
  parent_agent_thread_id TEXT,
  agent_pid INTEGER,
  chat_name TEXT
);

INSERT INTO dispatches_with_queue_state
  (id, state, owner_session_id, parent_host, parent_terminal_id, agent, model, effort, worktree_path, branch, host, runtime, child_host, tmux_session_id, tmux_session, tmux_pane, terminal_id, agent_thread_id, created_at, updated_at, archived_at, version, extra, parent_agent_thread_id, agent_pid, chat_name)
SELECT
  id, state, owner_session_id, parent_host, parent_terminal_id, agent, model, effort, worktree_path, branch, host, runtime, child_host, tmux_session_id, tmux_session, tmux_pane, terminal_id, agent_thread_id, created_at, updated_at, archived_at, version, extra, parent_agent_thread_id, agent_pid, chat_name
FROM dispatches;

DROP TABLE dispatches;
ALTER TABLE dispatches_with_queue_state RENAME TO dispatches;

CREATE INDEX dispatches_owner_state_idx ON dispatches(owner_session_id, state);
CREATE INDEX dispatches_archived_at_idx ON dispatches(archived_at);
CREATE INDEX dispatches_tmux_identity_idx ON dispatches(tmux_session_id, tmux_pane);
CREATE INDEX dispatches_terminal_id_idx ON dispatches(terminal_id);
