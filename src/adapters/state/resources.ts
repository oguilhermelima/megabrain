import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseHandle } from "../../db/db.js";
import { read, write } from "./shared.js";
import { resolveStateDirectory, type StateEnvironment } from "../../core/state.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const settingPath = (environment: StateEnvironment): string => resolve(resolveStateDirectory(environment), "resource-history-enabled");
export type ResourceSample = Readonly<{ dispatchId: string; agent: string; rssBytes: number; cpuPercent: number }>;

export async function resourceHistoryEnabled(environment: StateEnvironment): Promise<boolean> {
  try { await access(settingPath(environment)); return true; } catch { return false; }
}

export async function setResourceHistory(environment: StateEnvironment, enabled: boolean): Promise<void> {
  const path = settingPath(environment);
  if (!enabled) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "enabled\n", { mode: 0o600 });
}

export function recordResourceSamples(environment: StateEnvironment, handle: DatabaseHandle, samples: readonly ResourceSample[], now = Date.now()): number {
  if (!samples.length || !isEnabledSync(environment)) return 0;
  const valid = samples.filter((sample) => typeof sample.dispatchId === "string" && /^[A-Za-z0-9._-]+$/.test(sample.dispatchId) &&
    typeof sample.agent === "string" && sample.agent !== "" && Number.isSafeInteger(sample.rssBytes) && sample.rssBytes >= 0 &&
    Number.isFinite(sample.cpuPercent) && sample.cpuPercent >= 0);
  const result = write(handle, ({ db }) => {
    db.run("DELETE FROM resource_samples WHERE sampled_at < ?", [now - RETENTION_MS]);
    for (const sample of valid) db.run("INSERT INTO resource_samples (dispatch_id, agent, sampled_at, rss_bytes, cpu_percent) VALUES (?, ?, ?, ?, ?)", [sample.dispatchId, sample.agent, now, sample.rssBytes, sample.cpuPercent]);
    return valid.length;
  });
  return result.kind === "ok" ? result.value : 0;
}

function isEnabledSync(environment: StateEnvironment): boolean {
  try { return requireFileExists(settingPath(environment)); } catch { return false; }
}

function requireFileExists(path: string): boolean {
  // Node's sync existence check keeps the database write in one synchronous transaction.
  return existsSync(path);
}

export function estimateTypicalRssByAgent(handle: DatabaseHandle, now = Date.now()): Readonly<Record<string, number>> {
  const result = read(handle, ({ db }) => db.query<{ agent: string; rss_bytes: number }>(
    "SELECT agent, AVG(rss_bytes) AS rss_bytes FROM resource_samples WHERE sampled_at >= ? GROUP BY agent ORDER BY agent",
  ).all(now - RETENTION_MS).reduce<Record<string, number>>((estimates, row) => { estimates[row.agent] = Math.round(row.rss_bytes); return estimates; }, {}));
  return result.kind === "ok" ? result.value : {};
}
