import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sessionHistory, type HistoryAgent, type HistorySession } from "../adapters/session-history.js";
import { resolveLocation } from "../chat/summary-library.js";
import { readSessionTurns } from "../chat/session-log.js";
import { openDatabase } from "../db/db.js";
import { listDispatches } from "../db/queries/dispatches.js";
import { listRepositories } from "../db/queries/repositories.js";
import type { DistillTurn } from "./distill.js";
import type { KnowledgePipeline } from "./pipeline.js";
import { togglesFor } from "./settings.js";
import { knowledgeRoot, openProject } from "./store.js";

type Environment = Readonly<Record<string, string | undefined>>;

/** Agents whose own logs hold readable turns; grok and agy sessions are listed by history but have no turn reader yet. */
const READABLE: readonly HistoryAgent[] = ["claude", "codex"];

export type ScanOptions = {
  stateDir: string;
  home: string;
  environment: Environment;
  pipeline: KnowledgePipeline;
  /** Repository paths to scan; defaults to the registered repositories. */
  projects?: string[];
  /** Child session key ("<agent>:<id>") to parent session key, from the dispatch records. */
  dispatchLinks?: Map<string, string>;
  /** Folders besides the repository whose sessions belong to it; defaults to its git worktrees. */
  worktrees?: (repo: string) => Promise<string[]>;
  now?: () => Date;
  /** Take sessions active since this instant instead of since each project's stored horizon; the stored horizon does not move. */
  since?: Date;
  /** Most sessions sent to the model in one scan, newest first; the rest wait for the next scan. */
  maxSessions?: number;
  /** Count what a scan would do and call no model, write no knowledge and store no horizon. */
  dryRun?: boolean;
};

export type ScanProjectPlan = { repo: string; inHorizon: number; older: number; estimatedCalls: number };
export type ScanResult = { scanned: string[]; processed: number; projects: ScanProjectPlan[] };

/** A project is looked at back this far the first time the scanner sees it. */
export const LOOKBACK_DAYS = 7;
/** Sessions summarised per scan across all projects. */
export const SESSIONS_PER_SCAN = 20;
/** One summary call and one curator call. */
const CALLS_PER_SESSION = 2;
const DAY_MS = 86_400_000;

const horizonFile = (stateDir: string): string => join(knowledgeRoot(stateDir), "scan.json");

function readHorizons(stateDir: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(horizonFile(stateDir), "utf8"));
    const horizons = typeof value === "object" && value !== null ? (value as { horizons?: unknown }).horizons : undefined;
    return typeof horizons === "object" && horizons !== null ? horizons as Record<string, string> : {};
  } catch { return {}; }
}

/** The instant before which the scanner ignores a project's sessions, or null before its first scan. */
export function scanHorizon(stateDir: string, repo: string): string | null {
  return readHorizons(stateDir)[repo] ?? null;
}

function storeHorizon(stateDir: string, repo: string, horizon: string): void {
  mkdirSync(knowledgeRoot(stateDir), { recursive: true, mode: 0o700 });
  const temporary = `${horizonFile(stateDir)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ horizons: { ...readHorizons(stateDir), [repo]: horizon } })}\n`, { mode: 0o600 });
  renameSync(temporary, horizonFile(stateDir));
}

type Candidate = { repo: string; cwd: string; session: HistorySession; key: string; last: string; at: number; parent: string | undefined };

function gitWorktrees(repo: string): Promise<string[]> {
  return new Promise((done) => execFile("git", ["worktree", "list", "--porcelain"], { cwd: repo, timeout: 5000 }, (error, out) => done(error === null ? out.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice(9))) : [])));
}

/** The registered repositories, read from the state database. */
export function registeredProjects(environment: Environment): string[] {
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return [];
  try { return listRepositories(opened.value.db).map((record) => record.path); } finally { opened.value.close(); }
}

/** Dispatch workers' sessions mapped to the sessions that dispatched them. */
export function dispatchSessionLinks(environment: Environment): Map<string, string> {
  const links = new Map<string, string>();
  const opened = openDatabase(environment);
  if (opened.kind !== "ok") return links;
  try {
    for (const record of listDispatches(opened.value.db, { includeArchived: true })) {
      const child = record.agentThreadId, parent = record.parentAgentThreadId ?? record.parentSessionId;
      if (typeof child === "string" && typeof parent === "string" && child !== "" && parent !== "") links.set(`${typeof record.agent === "string" ? record.agent : "claude"}:${child}`, parent);
    }
  } finally { opened.value.close(); }
  return links;
}

/**
 * Reads, read-only, the sessions the agents logged inside each enabled project and hands new or grown ones to the pipeline.
 * A project without summaries, topics and sessions all on is not looked at, and its logs are never opened.
 * Only sessions active after the project's horizon are taken (now minus a week, fixed the first time the project is scanned),
 * and at most `maxSessions` of them per scan, newest first; dispatch workers cost no model call and are not counted.
 */
export async function scanProjects(options: ScanOptions): Promise<ScanResult> {
  const { stateDir, home, environment, pipeline } = options;
  const now = options.now ?? (() => new Date());
  const links = options.dispatchLinks ?? dispatchSessionLinks(environment);
  const result: ScanResult = { scanned: [], processed: 0, projects: [] };
  const candidates: Candidate[] = [];
  const plans = new Map<string, ScanProjectPlan>();
  for (const repo of options.projects ?? registeredProjects(environment)) {
    const toggles = togglesFor(stateDir, repo);
    if (!toggles.summaries || !toggles.topics || !toggles.sessions) continue;
    result.scanned.push(repo);
    let horizon = scanHorizon(stateDir, repo);
    if (horizon === null) {
      horizon = new Date(now().getTime() - LOOKBACK_DAYS * DAY_MS).toISOString();
      if (options.dryRun !== true) storeHorizon(stateDir, repo, horizon);
    }
    const cutoff = options.since?.getTime() ?? Date.parse(horizon);
    const plan: ScanProjectPlan = { repo, inHorizon: 0, older: 0, estimatedCalls: 0 };
    plans.set(repo, plan);
    const project = openProject(stateDir, repo);
    const folders = [...new Set([repo, ...await (options.worktrees ?? gitWorktrees)(repo)])];
    for (const cwd of folders) {
      for (const session of await sessionHistory(cwd, undefined, { home, stateDir, limit: 10_000 })) {
        if (!READABLE.includes(session.agent)) continue;
        const key = `${session.agent}:${session.id}`;
        const last = session.lastActivityAt ?? session.startedAt ?? "";
        const known = project.chatBySession(key);
        if (known !== null && known.endedAt >= last) continue;
        const at = Date.parse(last) || 0;
        if (at < cutoff) { plan.older += 1; continue; }
        plan.inHorizon += 1;
        candidates.push({ repo, cwd, session, key, last, at, parent: links.get(key) ?? links.get(session.id) });
      }
    }
  }
  candidates.sort((a, b) => b.at - a.at);
  let budget = options.maxSessions ?? SESSIONS_PER_SCAN;
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (candidate.parent === undefined) {
      if (budget <= 0) continue;
      budget -= 1;
      (plans.get(candidate.repo) as ScanProjectPlan).estimatedCalls += CALLS_PER_SESSION;
    }
    selected.push(candidate);
  }
  result.projects = [...plans.values()];
  if (options.dryRun === true) return result;
  for (const { repo, cwd, session, key, last, parent } of selected) {
    const location = await resolveLocation(cwd);
    let turns: DistillTurn[];
    try { turns = (await readSessionTurns({ agent: session.agent as "claude" | "codex", cwd, agentSessionId: session.id }, home)).filter((turn) => turn.parentId === undefined); } catch { continue; }
    const outcome = await pipeline.processSession({
      sessionKeys: [key], agent: session.agent, model: null, repo, cwd, branch: location.branch, worktree: location.worktree,
      startedAt: session.startedAt ?? last, endedAt: last, title: session.title, turns: turns.map((turn) => ({ kind: turn.kind, text: turn.text, at: turn.at, ...(turn.tool === undefined ? {} : { tool: turn.tool }) })),
      ...(parent === undefined ? {} : { parentSessionKey: parent }),
    });
    if (outcome.status === "curated" || outcome.status === "worker") result.processed += 1;
  }
  return result;
}
