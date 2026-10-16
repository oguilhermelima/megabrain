import { isAbsolute, join } from "node:path";
import { failed, ok, type Result } from "./result.js";

export type WorktreeMode = "megabrain" | "repo" | "custom";
export type WorktreeLayout = "flat" | "nested";
export type WorktreePlacement = { mode: WorktreeMode; customRoot: string | null; layout: WorktreeLayout };
export type WorktreeLocation = { version: 1 } & WorktreePlacement & { projects: Record<string, WorktreePlacement> };

/** Nothing moves for a person who never opens the setting: custom, the stored shared root, flat. */
export const defaultWorktreeLocation: WorktreeLocation = { version: 1, mode: "custom", customRoot: null, layout: "flat", projects: {} };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasOnlyKeys = (value: object, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key));

function parsePlacement(value: unknown, label: string): Result<WorktreePlacement> {
  if (!isRecord(value)) return failed(`worktree-location: ${label} must be an object`, 2);
  const { mode, customRoot, layout } = value;
  if (mode !== "megabrain" && mode !== "repo" && mode !== "custom") return failed(`worktree-location: ${label} mode must be megabrain, repo or custom`, 2);
  if (layout !== "flat" && layout !== "nested") return failed(`worktree-location: ${label} layout must be flat or nested`, 2);
  if (customRoot !== null && (typeof customRoot !== "string" || !isAbsolute(customRoot))) return failed(`worktree-location: ${label} customRoot must be null or an absolute path`, 2);
  return ok({ mode, customRoot, layout });
}

export function parseWorktreeLocation(raw: string): Result<WorktreeLocation> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failed("worktree-location: not valid JSON", 2); }
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "mode", "customRoot", "layout", "projects"]) || value.version !== 1 || !isRecord(value.projects)) {
    return failed("worktree-location: expected { version: 1, mode, customRoot, layout, projects }", 2);
  }
  const global = parsePlacement(value, "the default");
  if (global.kind !== "ok") return global;
  const projects: Record<string, WorktreePlacement> = {};
  for (const [path, entry] of Object.entries(value.projects)) {
    if (!isAbsolute(path)) return failed(`worktree-location: project key ${path} must be an absolute path`, 2);
    const placement = parsePlacement(entry, `the override for ${path}`);
    if (placement.kind !== "ok") return placement;
    projects[path] = placement.value;
  }
  return ok({ version: 1, ...global.value, projects });
}

/** The override for this repository, else the global choice. */
export function placementFor(location: WorktreeLocation, repoPath: string): WorktreePlacement {
  return location.projects[repoPath] ?? location;
}

/** The folder that holds `name`'s worktree. `sharedRoot` is the legacy worktree-root file, used by custom mode without a root. */
export function worktreeParent(placement: WorktreePlacement, input: { repoPath: string; repoName: string; stateDir: string; sharedRoot: string }): string {
  if (placement.mode === "repo") return join(input.repoPath, ".worktrees");
  if (placement.mode === "megabrain") return join(input.stateDir, "worktrees", input.repoName);
  const base = placement.customRoot ?? input.sharedRoot;
  return placement.layout === "nested" ? join(base, input.repoName) : base;
}
