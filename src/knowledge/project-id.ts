import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { resolveLocation } from "../chat/summary-library.js";

// A project's knowledge lives under $MEGABRAIN_STATE_DIR/knowledge/<project-id>/. The id is the
// repository folder's name, as a lowercase slug, plus the first 12 hex digits of the SHA-256 of its
// real path, so it reads at a glance, survives a symlinked path, and two repositories that share a
// folder name never share a folder. Every knowledge writer derives it here.

export type KnowledgeProject = Readonly<{ repo: string; name: string; id: string }>;

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The knowledge folder name of a repository: its main checkout's path, not a linked worktree's. */
export function projectId(repo: string): string {
  const real = realPath(repo);
  const slug = basename(real).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "project";
  return `${slug}-${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
}

/** The project a folder belongs to: a linked worktree's is its main checkout; a folder outside git stands for itself. */
export async function resolveProject(path: string): Promise<KnowledgeProject> {
  const { repo } = await resolveLocation(realPath(path));
  const real = realPath(repo);
  return { repo: real, name: basename(real), id: projectId(real) };
}
