// Branches being archived or restored from the sidebar, by worktree path. A row leaves the list the
// moment the person confirms, stays away while megabrain archives it and until the projects list no
// longer names it, and comes back at once if megabrain refuses. Undo (unarchive) keeps it away until
// megabrain has recreated the worktree; the next projects read then brings it back.

export interface ArchiveTarget {
  repo: string
  branch: string
  path: string
}

export interface ArchiveEntry extends ArchiveTarget {
  status: 'archiving' | 'archived' | 'restoring'
}

export type ArchiveMap = Readonly<Record<string, ArchiveEntry>>

function without(map: ArchiveMap, path: string): ArchiveMap {
  if (!(path in map)) return map
  const { [path]: _gone, ...rest } = map
  return rest
}

function withStatus(map: ArchiveMap, path: string, status: ArchiveEntry['status']): ArchiveMap {
  const entry = map[path]
  return entry === undefined ? map : { ...map, [path]: { ...entry, status } }
}

/** The same map while that branch is already on its way, so a second confirm does nothing. */
export function beginArchive(map: ArchiveMap, target: ArchiveTarget): ArchiveMap {
  if (target.path in map) return map
  return { ...map, [target.path]: { ...target, status: 'archiving' } }
}

export function archiveDone(map: ArchiveMap, path: string): ArchiveMap {
  return withStatus(map, path, 'archived')
}

/** Refused or failed: the row comes back. */
export function archiveFailed(map: ArchiveMap, path: string): ArchiveMap {
  return without(map, path)
}

/** Undo; the archived entry may already be gone once the list caught up. */
export function beginRestore(map: ArchiveMap, target: ArchiveTarget): ArchiveMap {
  return { ...map, [target.path]: { ...target, status: 'restoring' } }
}

export function restoreDone(map: ArchiveMap, path: string): ArchiveMap {
  return without(map, path)
}

/** The branch stays archived; the row stays away. */
export function restoreFailed(map: ArchiveMap, path: string): ArchiveMap {
  return withStatus(map, path, 'archived')
}

/** Drops archived entries the list no longer names; running ones stay whatever it says. */
export function reconcileArchives<P extends { worktrees: { path: string }[] }>(map: ArchiveMap, projects: P[]): ArchiveMap {
  const listed = new Set(projects.flatMap((project) => project.worktrees.map((worktree) => worktree.path)))
  const stale = Object.values(map).filter((entry) => entry.status === 'archived' && !listed.has(entry.path))
  return stale.reduce((next, entry) => without(next, entry.path), map)
}

/** The projects without the rows being archived; the same array, and the same projects, where nothing changes. */
export function withoutArchived<P extends { worktrees: { path: string }[] }>(projects: P[], map: ArchiveMap): P[] {
  if (Object.keys(map).length === 0) return projects
  let changed = false
  const next = projects.map((project) => {
    const kept = project.worktrees.filter((worktree) => !(worktree.path in map))
    if (kept.length === project.worktrees.length) return project
    changed = true
    return { ...project, worktrees: kept }
  })
  return changed ? next : projects
}
