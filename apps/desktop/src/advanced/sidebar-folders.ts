import type { Placement } from '@/advanced/project-order'

// Folders the person makes in the sidebar to group projects. The top level mixes folders and
// projects in one order; a folder holds an ordered list of project paths and never another folder.
// Folder ids never start with "/", so an order entry is a folder id or an (absolute) project path.
// The layout is saved through `megabrain settings set sidebar-folders`; paths of projects that are
// gone are dropped when it is reconciled with the listed projects.

export interface SidebarFolder {
  id: string
  name: string
  collapsed: boolean
  /** Project paths, in the order shown. */
  projects: string[]
}

export interface SidebarLayout {
  folders: SidebarFolder[]
  /** Folder ids and project paths at the top level, in the order shown. */
  order: string[]
}

export type DropPlacement = Placement | 'into'

export interface LayoutDrop {
  /** A folder id or a project path. */
  key: string
  placement: DropPlacement
}

export const emptyLayout: SidebarLayout = { folders: [], order: [] }

const defaultName = 'New folder'

export const isFolderId = (key: string) => !key.startsWith('/')

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])

/** A saved layout, keeping the well-formed folders and entries; anything else reads as no folders. */
export function parseLayout(value: unknown): SidebarLayout {
  if (!isRecord(value) || !Array.isArray(value.folders) || !Array.isArray(value.order)) return emptyLayout
  const folders: SidebarFolder[] = []
  for (const folder of value.folders) {
    if (!isRecord(folder) || typeof folder.id !== 'string' || folder.id === '' || !isFolderId(folder.id) || typeof folder.name !== 'string') continue
    if (folders.some((known) => known.id === folder.id)) continue
    folders.push({ id: folder.id, name: folder.name, collapsed: folder.collapsed === true, projects: strings(folder.projects) })
  }
  return { folders, order: strings(value.order) }
}

/** What `megabrain settings set sidebar-folders` stores. */
export const serialiseLayout = (layout: SidebarLayout) => JSON.stringify({ version: 1, folders: layout.folders, order: layout.order })

/**
 * The layout limited to the listed projects: stale paths dropped, each project in one place (a
 * folder first), folders the order forgot appended, and projects nobody placed yet appended at the
 * top level in the order they are listed.
 */
export function reconcileLayout(layout: SidebarLayout, paths: string[]): SidebarLayout {
  const present = new Set(paths)
  const placed = new Set<string>()
  const folders = layout.folders.map((folder) => {
    const projects = folder.projects.filter((path) => present.has(path) && !placed.has(path))
    for (const path of projects) placed.add(path)
    return projects.length === folder.projects.length ? folder : { ...folder, projects }
  })
  const ids = new Set(folders.map((folder) => folder.id))
  const seen = new Set<string>()
  const order: string[] = []
  for (const key of layout.order) {
    if (seen.has(key)) continue
    if (isFolderId(key) ? !ids.has(key) : !present.has(key) || placed.has(key)) continue
    seen.add(key)
    order.push(key)
  }
  for (const folder of folders) if (!seen.has(folder.id)) order.push(folder.id)
  for (const path of paths) if (!placed.has(path) && !seen.has(path)) order.push(path)
  return { folders, order }
}

/** Every project path in the order the sidebar shows them, a folder's projects in its place. */
export function flattenLayout(layout: SidebarLayout): string[] {
  const byId = new Map(layout.folders.map((folder) => [folder.id, folder]))
  return layout.order.flatMap((key) => (isFolderId(key) ? (byId.get(key)?.projects ?? []) : [key]))
}

const withFolder = (layout: SidebarLayout, id: string, change: (folder: SidebarFolder) => SidebarFolder): SidebarLayout => ({
  ...layout,
  folders: layout.folders.map((folder) => (folder.id === id ? change(folder) : folder)),
})

/** A new, expanded folder on top; made for a project, it takes the project's place and holds it. */
export function createFolder(layout: SidebarLayout, id: string, name: string, project?: string): SidebarLayout {
  const folder: SidebarFolder = { id, name: name.trim() === '' ? defaultName : name.trim(), collapsed: false, projects: [] }
  const added = { folders: [...layout.folders, folder], order: [id, ...layout.order] }
  if (project === undefined) return added
  const at = layout.order.indexOf(project)
  const placed = at === -1 ? added : { ...added, order: layout.order.map((key) => (key === project ? id : key)) }
  return moveToFolder(placed, project, id)
}

export function renameFolder(layout: SidebarLayout, id: string, name: string): SidebarLayout {
  const trimmed = name.trim()
  return trimmed === '' ? layout : withFolder(layout, id, (folder) => ({ ...folder, name: trimmed }))
}

/** Removes a folder; its projects return to the top level where it was. */
export function deleteFolder(layout: SidebarLayout, id: string): SidebarLayout {
  const folder = layout.folders.find((entry) => entry.id === id)
  if (folder === undefined) return layout
  return { folders: layout.folders.filter((entry) => entry.id !== id), order: layout.order.flatMap((key) => (key === id ? folder.projects : [key])) }
}

export function toggleFolder(layout: SidebarLayout, id: string): SidebarLayout {
  return withFolder(layout, id, (folder) => ({ ...folder, collapsed: !folder.collapsed }))
}

/** The folder holding a project, or null at the top level. */
export const folderOf = (layout: SidebarLayout, path: string) => layout.folders.find((folder) => folder.projects.includes(path)) ?? null

/** The layout without `key` anywhere. */
function without(layout: SidebarLayout, key: string): SidebarLayout {
  return {
    folders: layout.folders.map((folder) => (folder.projects.includes(key) ? { ...folder, projects: folder.projects.filter((path) => path !== key) } : folder)),
    order: layout.order.filter((entry) => entry !== key),
  }
}

const insert = (list: string[], key: string, target: string, placement: Placement) => {
  const index = list.indexOf(target)
  if (index === -1) return [...list, key]
  const next = [...list]
  next.splice(placement === 'before' ? index : index + 1, 0, key)
  return next
}

/** Moves a project to the end of a folder, or (null) to the top level right after the folder it left. */
export function moveToFolder(layout: SidebarLayout, path: string, id: string | null): SidebarLayout {
  const from = folderOf(layout, path)
  if (id === null) {
    if (from === null) return layout
    const rest = without(layout, path)
    return { ...rest, order: insert(rest.order, path, from.id, 'after') }
  }
  if (from?.id === id || !layout.folders.some((folder) => folder.id === id)) return layout
  return withFolder(without(layout, path), id, (folder) => ({ ...folder, projects: [...folder.projects, path] }))
}

/** Drops `source` (a folder id or project path) at `target`; folders stay at the top level. */
export function moveEntry(layout: SidebarLayout, source: string, target: LayoutDrop): SidebarLayout {
  if (source === target.key) return layout
  const sourceIsFolder = isFolderId(source)
  if (target.placement === 'into') {
    if (sourceIsFolder || !isFolderId(target.key)) return layout
    return moveToFolder(layout, source, target.key)
  }
  const placement = target.placement
  const container = isFolderId(target.key) ? null : folderOf(layout, target.key)
  // A folder dropped beside a project inside a folder lands beside that folder.
  if (container !== null && sourceIsFolder) return moveEntry(layout, source, { key: container.id, placement })
  const rest = without(layout, source)
  if (container === null) return { ...rest, order: insert(rest.order, source, target.key, placement) }
  return withFolder(rest, container.id, (folder) => ({ ...folder, projects: insert(folder.projects, source, target.key, placement) }))
}

/** Moves an entry one place up (-1) or down (1) past its next shown neighbour, within its folder or the top level. */
export function stepEntry(layout: SidebarLayout, key: string, step: -1 | 1, shown: Set<string>): SidebarLayout {
  const container = isFolderId(key) ? null : folderOf(layout, key)
  const list = container === null ? layout.order : container.projects
  const visible = list.filter((entry) => entry === key || isFolderId(entry) || shown.has(entry))
  const neighbour = visible[visible.indexOf(key) + step]
  if (!visible.includes(key) || neighbour === undefined) return layout
  return moveEntry(layout, key, { key: neighbour, placement: step === -1 ? 'before' : 'after' })
}

export interface LayoutRow {
  key: string
  /** The folder a project row sits in, or null at the top level. */
  parent: string | null
  folder: boolean
  /** A folder showing its projects. */
  open: boolean
  top: number
  bottom: number
}

/**
 * Where an entry dragged to `y` lands. A project over a folder header goes into it, except over the
 * header's top quarter (before the folder) or a closed folder's bottom quarter (after it); over any
 * other row it lands in that row's half. A folder only sees top-level rows. Below every row it lands
 * after the last top-level entry.
 */
export function layoutDropTarget(rows: LayoutRow[], y: number, dragged: string): LayoutDrop | null {
  const draggingFolder = isFolderId(dragged)
  const candidates = draggingFolder ? rows.filter((row) => row.parent === null) : rows
  const result = (drop: LayoutDrop | null) => (drop === null || drop.key === dragged ? null : drop)
  const last = candidates.at(-1)
  if (last === undefined) return null
  if (y > last.bottom) {
    const topLevel = candidates.filter((row) => row.parent === null).at(-1)
    return topLevel === undefined ? null : result({ key: topLevel.key, placement: 'after' })
  }
  let above: LayoutRow | null = null
  for (const row of candidates) {
    if (y < row.top) break
    above = row
    if (y > row.bottom) continue
    const height = row.bottom - row.top
    if (row.folder && !draggingFolder) {
      if (y < row.top + height / 4) return result({ key: row.key, placement: 'before' })
      if (!row.open && y > row.bottom - height / 4) return result({ key: row.key, placement: 'after' })
      return result({ key: row.key, placement: 'into' })
    }
    return result({ key: row.key, placement: y < row.top + height / 2 ? 'before' : 'after' })
  }
  if (above === null) {
    const first = candidates[0]
    return first === undefined ? null : result({ key: first.key, placement: 'before' })
  }
  return result({ key: above.key, placement: 'after' })
}
