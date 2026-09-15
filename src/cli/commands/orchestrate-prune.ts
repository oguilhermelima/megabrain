import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { failed, ok, type Result } from "../../core/result.js";
import { parsePruneArgs, pruneDecision, type PruneOptions } from "../../core/orchestrate-prune.js";
import { dispatchArchiveDirectory, liveDispatchDirectories } from "../../adapters/dispatch-store.js";
import { resolveStateDirectory } from "../../core/state.js";

type RecordValue = Record<string, unknown>;
type Environment = Readonly<Record<string, string | undefined>>;
type Entry = Readonly<{ id: string; meta: RecordValue; directory: string }>;
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function entries(root: string): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const directory of await liveDispatchDirectories(root)) {
    try { const meta = JSON.parse(await readFile(`${directory}/meta.json`, "utf8")) as RecordValue; if (typeof meta.dispatchId === "string") result.push({ id: meta.dispatchId, meta, directory }); } catch { /* shell ignores unreadable metadata */ }
  }
  return result;
}

export async function executeOrchestratePrune(args: readonly string[], environment: Environment): Promise<Result<string>> {
  if (args[0] === "-h" || args[0] === "--help") return ok("Usage: megabrain orchestrate prune [--older-than <days>] [--state <list>] [--archive|--delete] [--dry-run] [--json]\n");
  const parsed = parsePruneArgs(args); if (parsed.kind !== "ok") return parsed;
  const options: PruneOptions = parsed.value; const root = resolveStateDirectory(environment); const now = new Date(); const month = now.toISOString().slice(0, 7);
  const archived: Array<{ dispatchId: string; path: string }> = []; const deleted: string[] = []; const skipped: Array<{ dispatchId: string; state: string | null; reason: string }> = [];
  for (const entry of await entries(root)) {
    const decision = pruneDecision(entry.meta, options, now);
    if (!decision.eligible) { skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: decision.reason ?? "not eligible" }); continue; }
    if (options.mode === "archive") {
      const target = dispatchArchiveDirectory(root, month, entry.id); archived.push({ dispatchId: entry.id, path: target });
      if (!options.dryRun) { try { await mkdir(`${root}/dispatches/archive/${month}`, { recursive: true }); await rename(entry.directory, target); } catch { archived.pop(); skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: "could not archive dispatch" }); } }
    } else { deleted.push(entry.id); if (!options.dryRun) { try { await rm(entry.directory, { recursive: true, force: true }); } catch { deleted.pop(); skipped.push({ dispatchId: entry.id, state: typeof entry.meta.state === "string" ? entry.meta.state : null, reason: "could not delete dispatch" }); } } }
  }
  const result = { mode: options.mode, dryRun: options.dryRun, olderThanDays: options.olderThan, archived, deleted, skipped };
  if (options.json) return ok(json({ ...result, archived: archived.length, deleted: deleted.length, skipped: skipped.length, archivedDispatches: archived, deletedDispatches: deleted, skippedDispatches: skipped }));
  const lines = [`mode: ${options.mode}`, `dry-run: ${options.dryRun}`, `older-than-days: ${options.olderThan}`];
  for (const item of options.mode === "archive" ? archived : deleted.map((dispatchId) => ({ dispatchId }))) lines.push(`${options.dryRun ? "would" : ""} ${options.mode}: ${item.dispatchId}`.replace(/^ /, ""));
  lines.push(`skipped: ${skipped.length}`, ...skipped.map((item) => `skipped: ${item.dispatchId} (${item.reason})`)); return ok(`${lines.join("\n")}\n`);
}
