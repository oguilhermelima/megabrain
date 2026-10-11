import { appendFile, open, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const LOG_NAME = "delivery-decisions.jsonl";
const MAX_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 60_000;
const STALE_LOCK_MS = 10_000;

type Options = Readonly<{ maxBytes?: number; heartbeatMs?: number; now?: () => number }>;

/**
 * One deliverer's view of the shared decision log.
 *
 * Writes are O_APPEND, so concurrent writers never interleave or lose a line. Rotation is a rename,
 * guarded by an exclusive lock file so two writers cannot both rotate and drop the fresh file: a
 * writer that already holds the old inode keeps appending to it as delivery-decisions.jsonl.1, which
 * is the one previous file we keep. A lock we cannot take just skips rotation for this write.
 */
export function createDecisionLog(root: string, options: Options = {}) {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const now = options.now ?? Date.now;
  const path = resolve(root, LOG_NAME);
  const lockPath = `${path}.lock`;
  let previous: string | undefined;
  let previousWrittenAt = 0;

  async function rotateIfFull(): Promise<void> {
    const size = await stat(path).then((s) => s.size, () => 0);
    if (size < maxBytes) return;
    const held = await open(lockPath, "wx", 0o600).catch(() => undefined);
    if (held === undefined) {
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) await unlink(lockPath).catch(() => undefined);
      return;
    }
    try {
      // Re-check under the lock: another writer may have rotated while we waited.
      const current = await stat(path).then((s) => s.size, () => 0);
      if (current >= maxBytes) await rename(path, `${path}.1`);
    } finally {
      await held.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }

  return {
    async record(entry: Record<string, unknown>): Promise<void> {
      const { timestamp: _timestamp, ...state } = entry;
      const key = JSON.stringify(state);
      const at = now();
      if (key === previous && at - previousWrittenAt < heartbeatMs) return;
      previous = key;
      previousWrittenAt = at;
      const line = `${JSON.stringify({ timestamp: new Date(at).toISOString(), ...state })}\n`;
      try {
        await rotateIfFull();
        await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      } catch {
        // The log is diagnostic only; never let it break a delivery.
      }
    },
  };
}
