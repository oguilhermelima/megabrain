import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { sessionHistory, type HistoryAgent } from "../adapters/session-history.js";
import { resolveLocation } from "../chat/summary-library.js";
import { readSessionTurns } from "../chat/session-log.js";
import { openDatabase } from "../db/db.js";
import { listDispatches } from "../db/queries/dispatches.js";
import { listRepositories } from "../db/queries/repositories.js";
import type { DistillTurn } from "./distill.js";
import type { KnowledgePipeline } from "./pipeline.js";
import { togglesFor } from "./settings.js";
import { openProject } from "./store.js";

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
};

export type ScanResult = { scanned: string[]; processed: number };

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
 */
export async function scanProjects(options: ScanOptions): Promise<ScanResult> {
  const { stateDir, home, environment, pipeline } = options;
  const links = options.dispatchLinks ?? dispatchSessionLinks(environment);
  const result: ScanResult = { scanned: [], processed: 0 };
  for (const repo of options.projects ?? registeredProjects(environment)) {
    const toggles = togglesFor(stateDir, repo);
    if (!toggles.summaries || !toggles.topics || !toggles.sessions) continue;
    result.scanned.push(repo);
    const project = openProject(stateDir, repo);
    const folders = [...new Set([repo, ...await (options.worktrees ?? gitWorktrees)(repo)])];
    for (const cwd of folders) {
      const location = await resolveLocation(cwd);
      for (const session of await sessionHistory(cwd, undefined, { home, stateDir, limit: 10_000 })) {
        if (!READABLE.includes(session.agent)) continue;
        const key = `${session.agent}:${session.id}`;
        const known = project.chatBySession(key);
        const last = session.lastActivityAt ?? session.startedAt ?? "";
        if (known !== null && known.endedAt >= last) continue;
        let turns: DistillTurn[];
        try { turns = (await readSessionTurns({ agent: session.agent as "claude" | "codex", cwd, agentSessionId: session.id }, home)).filter((turn) => turn.parentId === undefined); } catch { continue; }
        const parent = links.get(key) ?? links.get(session.id);
        const outcome = await pipeline.processSession({
          sessionKeys: [key], agent: session.agent, model: null, repo, cwd, branch: location.branch, worktree: location.worktree,
          startedAt: session.startedAt ?? last, endedAt: last, title: session.title, turns: turns.map((turn) => ({ kind: turn.kind, text: turn.text, at: turn.at, ...(turn.tool === undefined ? {} : { tool: turn.tool }) })),
          ...(parent === undefined ? {} : { parentSessionKey: parent }),
        });
        if (outcome.status === "curated" || outcome.status === "worker") result.processed += 1;
      }
    }
  }
  return result;
}
