import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allEntries } from "../chat/summary-library.js";
import type { KnowledgePipeline } from "./pipeline.js";
import { extractRefs, mergeRefs } from "./refs.js";
import { knowledgeRoot, openProject } from "./store.js";

export type BackfillResult = { curated: number; failed: number; skipped: number };

function statePath(stateDir: string): string { return join(knowledgeRoot(stateDir), "backfill.json"); }

function readDone(stateDir: string): Set<string> {
  try { return new Set((JSON.parse(readFileSync(statePath(stateDir), "utf8")) as { done: string[] }).done); } catch { return new Set(); }
}

function writeDone(stateDir: string, done: Set<string>): void {
  mkdirSync(knowledgeRoot(stateDir), { recursive: true, mode: 0o700 });
  const temporary = `${statePath(stateDir)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ done: [...done] })}\n`, { mode: 0o600 });
  renameSync(temporary, statePath(stateDir));
}

/**
 * Feeds the summaries already on disk through the curator once, oldest first. Each finished summary is recorded, so a rerun
 * (after a crash, a failure or on every start) skips it; the first failure stops the run, because a failing model fails the rest too.
 * Summaries of projects whose summaries or topics toggle is off are left alone and not marked done.
 */
export async function backfillSummaries(options: { stateDir: string; pipeline: KnowledgePipeline }): Promise<BackfillResult> {
  const { stateDir, pipeline } = options;
  const done = readDone(stateDir);
  const result: BackfillResult = { curated: 0, failed: 0, skipped: 0 };
  const entries = (await allEntries(stateDir)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const queued: typeof entries = [];
  for (const entry of entries) {
    if (done.has(entry.id) || pipeline.blocked(entry.repo) !== null) { result.skipped += 1; continue; }
    const outcome = await pipeline.curateSummary({
      sessionKeys: [`chat:${entry.chatId}`], chatId: entry.chatId, agent: entry.agent, model: null, repo: entry.repo, cwd: entry.worktree, branch: entry.branch, deferCurator: true,
      worktree: entry.worktree, startedAt: entry.createdAt, endedAt: entry.createdAt, title: entry.title, turns: [],
    }, { title: entry.title, text: entry.text, refs: mergeRefs(extractRefs(entry.text), entry.refs ?? []), keys: [], userTurns: entry.userTurns });
    if (outcome.status !== "curated") { result.failed += 1; break; }
    queued.push(entry);
  }
  const deferred = await pipeline.flushCurators([...new Set(queued.map((entry) => entry.repo))]);
  for (const entry of queued) {
    const chat = openProject(stateDir, entry.repo).chat(entry.chatId);
    if (chat?.curated === true) { done.add(entry.id); result.curated += 1; }
    else if (deferred.has(entry.repo)) result.skipped += 1;
    else result.failed += 1;
  }
  if (queued.length > 0) writeDone(stateDir, done);
  return result;
}
