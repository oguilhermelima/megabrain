import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Chat } from "./store.js";
import type { SummaryEntry, SummaryIndexEntry } from "./summaries.js";

export type SummaryLocation = { repo: string; project: string; worktree: string; branch: string };
export type BranchSummaries = { branch: string; worktree: string; live: boolean; summaries: SummaryEntry[] };
export type ProjectSummaries = { repo: string; project: string; branches: BranchSummaries[] };
export type ListFilter = { repo?: string; branch?: string; limit?: number };
export type SearchFilter = ListFilter;
export type ScoredEntry = SummaryEntry & { score: number };

const NO_BRANCH = "(no branch)";
const CONTEXT_BYTES = 2000;
const CONTEXT_ENTRY_CHARS = 700;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => execFile("git", args, { cwd, timeout: 5000 }, (error, out) => resolve(error === null ? out.trim() : null)));
}

/** Where a folder sits: the repository (the main checkout), the worktree it belongs to and the branch. A folder outside git, or one already removed, stands for itself. */
export async function resolveLocation(cwd: string): Promise<SummaryLocation> {
  const root = await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
  const [worktree, common] = root === null ? [] : root.split("\n");
  if (worktree === undefined || common === undefined || worktree === "") return { repo: cwd, project: basename(cwd), worktree: cwd, branch: NO_BRANCH };
  const repo = basename(common) === ".git" ? dirname(common) : worktree;
  const branch = await git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return { repo, project: basename(repo), worktree, branch: branch === null || branch === "" ? NO_BRANCH : branch };
}

function chatDirectories(stateDir: string): string[] {
  try { return readdirSync(join(stateDir, "chats")); } catch { return []; }
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; }
}

type Stored = Partial<SummaryEntry> & { text: string; updatedAt: string };

function parseLines(path: string): Stored[] {
  let content: string;
  try { content = readFileSync(path, "utf8"); } catch { return []; }
  return content.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line) as Stored]; } catch { return []; } });
}

/** Gives every entry written before branches existed its chat, repo, project, worktree and branch, once. Returns how many it changed. */
export async function migrateSummaries(stateDir: string): Promise<number> {
  const index = readJson<Record<string, SummaryIndexEntry>>(join(stateDir, "chat-summaries-index.json")) ?? {};
  let migrated = 0;
  for (const chatId of chatDirectories(stateDir)) {
    const path = join(stateDir, "chats", chatId, "summaries.jsonl");
    const entries = parseLines(path);
    if (!entries.some((entry) => entry.id === undefined)) continue;
    const chat = readJson<Chat>(join(stateDir, "chats", chatId, "chat.json"));
    if (chat === null) continue;
    const location = await resolveLocation(chat.cwd);
    // A removed worktree no longer answers git; the index kept the branch it had.
    const branch = location.branch === NO_BRANCH ? index[chatId]?.branch ?? NO_BRANCH : location.branch;
    const next = entries.map((entry) => {
      if (entry.id !== undefined) return entry;
      migrated += 1;
      return { ...entry, id: crypto.randomUUID(), chatId, repo: location.repo, project: location.project, worktree: location.worktree, branch, agent: chat.agent, createdAt: entry.updatedAt };
    });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
  return migrated;
}

/** Every entry of every chat, newest first. */
export async function allEntries(stateDir: string): Promise<SummaryEntry[]> {
  await migrateSummaries(stateDir);
  const entries = chatDirectories(stateDir).flatMap((chatId) => parseLines(join(stateDir, "chats", chatId, "summaries.jsonl")).filter((entry) => entry.id !== undefined) as SummaryEntry[]);
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function matches(entry: SummaryEntry, filter: ListFilter): boolean {
  if (filter.branch !== undefined && entry.branch !== filter.branch) return false;
  return filter.repo === undefined || entry.repo === filter.repo || entry.project === filter.repo;
}

/** Summaries grouped by project, then branch; both ordered by their latest activity, entries newest first. */
export async function listSummaries(stateDir: string, filter: ListFilter): Promise<{ projects: ProjectSummaries[] }> {
  const limit = filter.limit ?? 20;
  const projects = new Map<string, ProjectSummaries>();
  // Entries arrive newest first, so the first sight of a project or branch fixes the order.
  for (const entry of (await allEntries(stateDir)).filter((candidate) => matches(candidate, filter))) {
    let project = projects.get(entry.repo);
    if (project === undefined) { project = { repo: entry.repo, project: entry.project, branches: [] }; projects.set(entry.repo, project); }
    let branch = project.branches.find((candidate) => candidate.branch === entry.branch);
    if (branch === undefined) { branch = { branch: entry.branch, worktree: entry.worktree, live: existsSync(entry.worktree), summaries: [] }; project.branches.push(branch); }
    if (branch.summaries.length < limit) branch.summaries.push(entry);
  }
  return { projects: [...projects.values()] };
}

function score(entry: SummaryEntry, terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) {
    const weights: Array<[string | null, number]> = [[entry.title, 3], [entry.branch, 3], [entry.project, 2], [entry.text, 1]];
    const hit = weights.filter(([field]) => field?.toLowerCase().includes(term) === true).reduce((sum, [, weight]) => sum + weight, 0);
    if (hit === 0) return 0;
    total += hit;
  }
  return total;
}

/** Entries holding every word of the text, title and branch hits ranking above body hits. */
export async function searchEntries(stateDir: string, text: string, filter: SearchFilter): Promise<{ results: ScoredEntry[] }> {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { results: [] };
  const scored = (await allEntries(stateDir)).filter((entry) => matches(entry, filter)).map((entry) => ({ ...entry, score: score(entry, terms) })).filter((entry) => entry.score > 0);
  // The sort is stable, so equal scores keep newest first.
  return { results: scored.sort((a, b) => b.score - a.score).slice(0, filter.limit ?? 20) };
}

export async function showEntry(stateDir: string, id: string): Promise<SummaryEntry | null> {
  return (await allEntries(stateDir)).find((entry) => entry.id === id) ?? null;
}

async function mainBranch(repo: string): Promise<string> {
  for (const name of ["main", "master"]) if (await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]) !== null) return name;
  return "main";
}

function clip(text: string, chars: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= chars ? one : `${one.slice(0, Math.max(0, chars - 1)).trimEnd()}…`;
}

/** A short Markdown block for an agent: the latest summaries of this worktree's branch, then of the repository's main branch. Empty when there are none. */
export async function summariesContext(stateDir: string, cwd: string, limit = 3): Promise<string> {
  const location = await resolveLocation(cwd);
  const entries = (await allEntries(stateDir)).filter((entry) => entry.repo === location.repo);
  const main = await mainBranch(location.repo);
  const sections = [{ branch: location.branch, count: limit }, ...(location.branch === main ? [] : [{ branch: main, count: 2 }])]
    .map((section) => ({ ...section, entries: entries.filter((entry) => entry.branch === section.branch).slice(0, section.count) }))
    .filter((section) => section.entries.length > 0);
  if (sections.length === 0) return "";
  const header = `# Recent work summaries (${location.project})\nFor older work run: megabrain summaries search <text>\n`;
  let out = header;
  for (const section of sections) {
    const title = `\n## ${section.branch}\n`;
    if (Buffer.byteLength(out + title) >= CONTEXT_BYTES) break;
    out += title;
    for (const entry of section.entries) {
      const prefix = `- ${entry.createdAt.slice(0, 10)}${entry.title === null || entry.title === "" ? "" : ` ${clip(entry.title, 60)}`}: `;
      const room = CONTEXT_BYTES - Buffer.byteLength(out + prefix) - 1;
      if (room < 40) break;
      // Multi-byte text can outgrow its character count, so the clip is re-checked in bytes.
      let text = clip(entry.text, Math.min(CONTEXT_ENTRY_CHARS, room));
      while (Buffer.byteLength(text) > room) text = clip(text, text.length - 8);
      out += `${prefix}${text}\n`;
    }
  }
  return out;
}
