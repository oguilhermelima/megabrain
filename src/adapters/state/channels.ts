import { nextRetryAt } from "../../core/delivery-channel.js";
import { type Result } from "../../core/result.js";
import type { DatabaseAdapter, DatabaseHandle } from "../../db/db.js";
import { read, write } from "./shared.js";

export type DeliveryChannelRecord = Readonly<{
  agent: string;
  channel: string;
  status: "working" | "broken";
  agentVersion: string | null;
  failures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  retryAfter: string | null;
  updatedAt: string;
}>;

export type ChannelResult = Readonly<{
  agent: string;
  channel: string;
  agentVersion: string;
  now?: number;
} & ({ ok: true } | { ok: false; error: string })>;

type ChannelRow = {
  agent: string;
  channel: string;
  status: "working" | "broken";
  agent_version: string | null;
  failures: number;
  last_error: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  retry_after: string | null;
  updated_at: string;
};

const toRecord = (row: ChannelRow): DeliveryChannelRecord => ({
  agent: row.agent,
  channel: row.channel,
  status: row.status,
  agentVersion: row.agent_version,
  failures: row.failures,
  lastError: row.last_error,
  lastSuccessAt: row.last_success_at,
  lastFailureAt: row.last_failure_at,
  retryAfter: row.retry_after,
  updatedAt: row.updated_at,
});

export function getDeliveryChannel(handle: DatabaseHandle, agent: string, channel: string): Result<DeliveryChannelRecord | undefined> {
  return read(handle, ({ db }) => {
    const row = db.query<ChannelRow>("SELECT * FROM delivery_channels WHERE agent = ? AND channel = ?").get(agent, channel);
    return row === null ? undefined : toRecord(row);
  });
}

export function queryDeliveryChannels(db: DatabaseAdapter): DeliveryChannelRecord[] {
  return db.query<ChannelRow>("SELECT * FROM delivery_channels ORDER BY agent, channel").all().map(toRecord);
}

export function listDeliveryChannels(handle: DatabaseHandle): Result<DeliveryChannelRecord[]> {
  return read(handle, ({ db }) => queryDeliveryChannels(db));
}

export function recordChannelResult(handle: DatabaseHandle, result: ChannelResult): Result<DeliveryChannelRecord> {
  return write(handle, ({ db }) => {
    const now = result.now ?? Date.now();
    const at = new Date(now).toISOString();
    const previous = db.query<ChannelRow>("SELECT * FROM delivery_channels WHERE agent = ? AND channel = ?").get(result.agent, result.channel);
    const failures = result.ok ? 0 : (previous?.failures ?? 0) + 1;
    const row: ChannelRow = {
      agent: result.agent,
      channel: result.channel,
      status: result.ok ? "working" : "broken",
      agent_version: result.agentVersion,
      failures,
      last_error: result.ok ? previous?.last_error ?? null : result.error.slice(0, 500),
      last_success_at: result.ok ? at : previous?.last_success_at ?? null,
      last_failure_at: result.ok ? previous?.last_failure_at ?? null : at,
      retry_after: result.ok ? null : new Date(nextRetryAt(failures, now)).toISOString(),
      updated_at: at,
    };
    db.run(
      `INSERT INTO delivery_channels (agent, channel, status, agent_version, failures, last_error, last_success_at, last_failure_at, retry_after, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent, channel) DO UPDATE SET status = excluded.status, agent_version = excluded.agent_version, failures = excluded.failures,
         last_error = excluded.last_error, last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at,
         retry_after = excluded.retry_after, updated_at = excluded.updated_at`,
      [row.agent, row.channel, row.status, row.agent_version, row.failures, row.last_error, row.last_success_at, row.last_failure_at, row.retry_after, row.updated_at],
    );
    return toRecord(row);
  });
}
