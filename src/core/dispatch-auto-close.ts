import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const AUTO_CLOSE_GRACE_MS = 120_000;

export type AutoCloseEnvironment = Readonly<{ MEGABRAIN_STATE_DIR?: string; HOME?: string }>;

function settingsPath(environment: AutoCloseEnvironment): string {
  return join(environment.MEGABRAIN_STATE_DIR ?? join(environment.HOME ?? process.cwd(), ".megabrain"), "terminal-settings.json");
}

async function settings(environment: AutoCloseEnvironment): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(settingsPath(environment), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

export async function dispatchAutoCloseEnabled(environment: AutoCloseEnvironment): Promise<boolean> {
  return (await settings(environment)).autoCloseDispatches !== false;
}

export async function setDispatchAutoCloseEnabled(environment: AutoCloseEnvironment, enabled: boolean): Promise<void> {
  const path = settingsPath(environment);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...await settings(environment), autoCloseDispatches: enabled })}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export type AutoCloseCandidate = Readonly<{
  state: string;
  runtime: string;
  keepOpen: boolean;
  enabled: boolean;
  acknowledgedAt: string | null;
  now: number;
  viewedSinceDone: boolean;
}>;

export function mayAutoCloseDispatch(candidate: AutoCloseCandidate): boolean {
  if (candidate.state !== "done" || candidate.runtime !== "tmux" || candidate.keepOpen || !candidate.enabled || candidate.viewedSinceDone) return false;
  if (candidate.acknowledgedAt === null) return false;
  const acknowledgedAt = Date.parse(candidate.acknowledgedAt);
  return Number.isFinite(acknowledgedAt) && candidate.now - acknowledgedAt >= AUTO_CLOSE_GRACE_MS;
}

function timestamp(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
}

/** Rows are tmux client_created|client_activity values; pane output is deliberately ignored. */
export function tmuxClientsViewedSinceDone(output: string, doneAt: string): boolean | undefined {
  const done = Date.parse(doneAt);
  if (!Number.isFinite(done)) return undefined;
  for (const line of output.split("\n").filter((row) => row !== "")) {
    const [createdRaw, activityRaw] = line.split("|");
    const created = createdRaw === undefined ? undefined : timestamp(createdRaw);
    const activity = activityRaw === undefined ? undefined : timestamp(activityRaw);
    if (created === undefined || activity === undefined) return undefined;
    // A client attached to this session is viewing the dispatch even if it has been idle
    // since before the done message. Timestamps only matter for clients that attach later.
    if (created >= 0 && activity >= 0) return true;
  }
  return false;
}
