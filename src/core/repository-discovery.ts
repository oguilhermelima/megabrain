// Finds git repositories on disk that megabrain does not know yet, for the desktop's import screen
// (`repo discover`). The walk is shallow on purpose: each root's children and grandchildren, never
// into a repository, a hidden folder or node_modules, so a home folder full of checkouts answers in
// well under a second. A linked worktree (whose .git is a file) belongs to some main checkout and is
// never offered on its own.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProcessAdapter } from "../adapters/proc.js";

export type DiscoveredRepository = Readonly<{
  name: string;
  path: string;
  /** The checked-out branch; null when HEAD is detached. */
  branch: string | null;
  /** origin's URL; null when there is none. */
  remote: string | null;
  /** The committer date of HEAD as ISO 8601 in UTC; null for a repository without commits. */
  lastCommitAt: string | null;
  /** The root the walk found it under. */
  root: string;
}>;

/** Folders people keep checkouts in, under the home folder. */
export const commonRoots = ["Workspaces", "Developer", "Projects", "code", "src"] as const;

const skipped = new Set(["node_modules", "Library", "Applications", "Pictures", "Music", "Movies"]);

/** The default roots: the common folders, then the parent of every registered repository; duplicates dropped. */
export function defaultRoots(home: string, registered: readonly string[]): string[] {
  return unique([...commonRoots.map((name) => join(home, name)), ...registered.map((path) => dirname(path))]);
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function real(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** A main checkout has a .git folder; a linked worktree or a submodule has a .git file. */
function isMainCheckout(path: string): boolean {
  return isDirectory(join(path, ".git"));
}

function children(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !skipped.has(entry.name))
      .map((entry) => join(path, entry.name));
  } catch { return []; }
}

/** Main checkouts at most `depth` levels below root, the root itself included; never inside a checkout. */
export function walkRepositories(root: string, depth: number): string[] {
  const found: string[] = [];
  const visit = (path: string, level: number): void => {
    if (isMainCheckout(path)) {
      found.push(path);
      return;
    }
    if (level >= depth) return;
    for (const child of children(path)) visit(child, level + 1);
  };
  visit(root, 0);
  return found;
}

/** The branch HEAD names, read from the file so no process starts; null when detached. */
export function headBranch(gitDirectory: string): string | null {
  try {
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match?.[1] ?? null;
  } catch { return null; }
}

/** origin's url from .git/config; null when there is no origin. */
export function originUrl(gitDirectory: string): string | null {
  let text: string;
  try { text = readFileSync(join(gitDirectory, "config"), "utf8"); } catch { return null; }
  let inOrigin = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return null;
}

async function lastCommitAt(path: string, process: ProcessAdapter): Promise<string | null> {
  const result = await process.run("git", ["-C", path, "log", "-1", "--format=%ct"], { timeoutMs: 5_000 });
  if (result.kind !== "ok") return null;
  const seconds = Number(result.value.stdout.trim());
  return result.value.stdout.trim() === "" || !Number.isFinite(seconds) ? null : new Date(seconds * 1000).toISOString();
}

/** Runs `work` over items with at most `limit` running at once, keeping the order. */
async function mapLimited<T, U>(items: readonly T[], limit: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/**
 * Repositories under the roots that are not registered, newest commit first (then by name). Roots
 * that do not exist are skipped; a repository two roots both reach is listed once, under the first.
 */
export async function discoverRepositories(options: Readonly<{ roots: readonly string[]; registered: readonly string[]; depth?: number }>, process: ProcessAdapter): Promise<DiscoveredRepository[]> {
  const known = new Set(options.registered.map((path) => real(path) ?? path));
  const seen = new Set<string>();
  const candidates: { path: string; root: string }[] = [];
  for (const root of unique(options.roots)) {
    if (!existsSync(root) || !isDirectory(root)) continue;
    for (const found of walkRepositories(root, options.depth ?? 2)) {
      const path = real(found) ?? found;
      if (known.has(path) || seen.has(path)) continue;
      seen.add(path);
      candidates.push({ path, root });
    }
  }
  const repositories = await mapLimited(candidates, 8, async ({ path, root }): Promise<DiscoveredRepository> => {
    const gitDirectory = join(path, ".git");
    return { name: basename(path), path, branch: headBranch(gitDirectory), remote: originUrl(gitDirectory), lastCommitAt: await lastCommitAt(path, process), root };
  });
  return repositories.sort((left, right) => (right.lastCommitAt ?? "").localeCompare(left.lastCommitAt ?? "") || left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}
