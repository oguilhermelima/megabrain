import { parseRowOrder, type RowOrder } from '@/advanced/row-model'

const collapsedKey = 'megabrain.sidebar.hidden'

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(collapsedKey) === '1'
  } catch {
    return false
  }
}

export function writeSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(collapsedKey, collapsed ? '1' : '0')
  } catch {
    // Remembered collapse state is a convenience; starting expanded is fine.
  }
}

// What the sidebar folded and the order the person dragged each worktree's rows into, saved through
// `megabrain settings set sidebar-state` so a restart keeps both. Folders and the top-level order of
// projects and folders live in sidebar-folders. Projects fold by path, stacks by `stack:<worktree
// path>`, a worktree's own rows by `worktree:<worktree path>` (state saved before worktrees folded has
// none, so they read as open); rows are ordered by their keys, per worktree path.

export interface SidebarState {
  collapsed: string[]
  rows: RowOrder
}

export const stackFoldKey = (worktreePath: string) => `stack:${worktreePath}`
export const worktreeFoldKey = (worktreePath: string) => `worktree:${worktreePath}`

/** Every fold key the projects have now: each project's path, and each worktree's stack and rows. */
export function foldKeys(projects: readonly { path: string; worktrees: readonly { path: string }[] }[]): Set<string> {
  return new Set(projects.flatMap((project) => [project.path, ...project.worktrees.flatMap((worktree) => [stackFoldKey(worktree.path), worktreeFoldKey(worktree.path)])]))
}

export const emptySidebarState: SidebarState = { collapsed: [], rows: {} }

const version = 1

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** What `settings get sidebar-state` printed, keeping what is usable; anything else is nothing saved. */
export function parseSidebarState(raw: unknown): SidebarState {
  if (!isRecord(raw) || raw.version !== version || !Array.isArray(raw.collapsed) || !isRecord(raw.rows)) return emptySidebarState
  const rows: RowOrder = {}
  for (const [path, keys] of Object.entries(raw.rows)) if (Array.isArray(keys)) rows[path] = strings(keys)
  return { collapsed: strings(raw.collapsed), rows }
}

export function serialiseSidebarState(state: SidebarState): string {
  return JSON.stringify({ version, collapsed: state.collapsed, rows: state.rows })
}

/** The state this viewer's storage kept before the CLI held it (the collapsed keys and the row order), to seed it once. */
export function legacySidebarState(collapsed: string | null, rows: string | null): SidebarState {
  let folded: string[] = []
  try {
    folded = collapsed === null ? [] : strings(JSON.parse(collapsed) as unknown)
  } catch {
    folded = []
  }
  return { collapsed: folded, rows: parseRowOrder(rows) }
}

export const isEmptySidebarState = (state: SidebarState) => state.collapsed.length === 0 && Object.keys(state.rows).length === 0

/** The state without what no longer exists: fold keys no project or stack has, and orders of worktrees that are gone. */
export function pruneSidebarState(state: SidebarState, live: { collapsible: ReadonlySet<string>; worktrees: ReadonlySet<string> }): SidebarState {
  const rows: RowOrder = {}
  for (const [path, keys] of Object.entries(state.rows)) if (live.worktrees.has(path) && keys.length > 0) rows[path] = keys
  return { collapsed: state.collapsed.filter((key) => live.collapsible.has(key)), rows }
}
