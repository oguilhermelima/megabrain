import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "./private-json.js";
import { resolveStateDirectory, type StateEnvironment } from "./state.js";

// A branch put away: its folder is gone, the branch stays, and this is what unarchive needs to bring it back.
export type ArchivedWorktree = {
  repo: string;
  branch: string;
  head: string;
  archivedAt: string;
  parent: string | null;
  pullRequest: { number: number; state: string; url: string } | null;
  path: string;
};

const archiveFile = (environment: StateEnvironment) => join(resolveStateDirectory(environment), "archived-worktrees.json");

export async function readArchivedWorktrees(environment: StateEnvironment): Promise<ArchivedWorktree[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(archiveFile(environment), "utf8"));
    const items = typeof raw === "object" && raw !== null ? (raw as { items?: unknown }).items : undefined;
    return Array.isArray(items) ? items.filter((item): item is ArchivedWorktree => typeof item?.repo === "string" && typeof item.branch === "string" && typeof item.path === "string") : [];
  } catch { return []; }
}

export async function writeArchivedWorktrees(environment: StateEnvironment, items: readonly ArchivedWorktree[]): Promise<void> {
  await writePrivateJson(archiveFile(environment), { version: 1, items });
}
