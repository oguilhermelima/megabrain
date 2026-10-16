// Where new worktrees are created: the choice for every project and an optional one per project,
// saved as JSON through `megabrain settings set worktree-location`. The CLI owns the meaning; this
// reads the shape and shows an example path before anything is created.

export type WorktreeMode = "megabrain" | "repo" | "custom";
export type WorktreeLayout = "flat" | "nested";

export interface Placement {
  mode: WorktreeMode;
  /** Only for `custom`; null means the shared worktrees folder the app already used. */
  customRoot: string | null;
  layout: WorktreeLayout;
}

export interface WorktreeLocation extends Placement {
  version: 1;
  /** Repository path to its own placement. */
  projects: Record<string, Placement>;
}

/** Today's behaviour: the shared folder, one folder per worktree. Nothing moves. */
export const defaultWorktreeLocation: WorktreeLocation = {
  version: 1,
  mode: "custom",
  customRoot: null,
  layout: "flat",
  projects: {},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function placementOf(value: unknown): Placement | null {
  if (!isRecord(value)) return null;
  const { mode, customRoot, layout } = value;
  if (mode !== "megabrain" && mode !== "repo" && mode !== "custom") return null;
  if (layout !== "flat" && layout !== "nested") return null;
  return {
    mode,
    customRoot:
      typeof customRoot === "string" && customRoot !== "" ? customRoot : null,
    layout,
  };
}

/** What `settings get worktree-location` printed; a value that is missing or unusable is the default. */
export function parseWorktreeLocation(raw: unknown): WorktreeLocation {
  const global = placementOf(raw);
  if (global === null || !isRecord(raw)) return defaultWorktreeLocation;
  const projects: Record<string, Placement> = {};
  if (isRecord(raw.projects)) {
    for (const [path, entry] of Object.entries(raw.projects)) {
      const placement = placementOf(entry);
      if (placement !== null) projects[path] = placement;
    }
  }
  return { version: 1, ...global, projects };
}

export const overrideCount = (location: WorktreeLocation): number =>
  Object.keys(location.projects).length;

export const withOverride = (
  location: WorktreeLocation,
  path: string,
  placement: Placement,
): WorktreeLocation => ({
  ...location,
  projects: { ...location.projects, [path]: placement },
});

export function withoutOverride(
  location: WorktreeLocation,
  path: string,
): WorktreeLocation {
  const { [path]: _removed, ...rest } = location.projects;
  return { ...location, projects: rest };
}

const exampleBranch = "feat-example";

/** The folder a new worktree for `feat/example` would get, written the way the CLI lays it out. */
export function examplePath(
  placement: Placement,
  project: { path: string; name: string },
): string {
  if (placement.mode === "repo")
    return `${project.path}/.worktrees/${exampleBranch}`;
  if (placement.mode === "megabrain")
    return `~/.megabrain/worktrees/${project.name}/${exampleBranch}`;
  const base = placement.customRoot ?? "<shared worktrees folder>";
  return placement.layout === "nested"
    ? `${base}/${project.name}/${exampleBranch}`
    : `${base}/${exampleBranch}`;
}
