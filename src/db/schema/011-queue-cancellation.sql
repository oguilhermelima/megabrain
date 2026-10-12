ALTER TABLE outbox RENAME TO outbox_before_queue_cancellation;

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT REFERENCES dispatches(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'suppressed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  transport TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lease_holder TEXT,
  detail TEXT
);

INSERT INTO outbox (id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at, lease_holder, detail)
SELECT id, dispatch_id, target_kind, target, payload, status, attempts, lease_until, transport, created_at, updated_at, lease_holder, detail
FROM outbox_before_queue_cancellation;

DROP TABLE outbox_before_queue_cancellation;
