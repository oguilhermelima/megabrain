import { closePane, paneList, singlePane, type PaneLeaf } from '@/panes/pane-model'
import { focusGroup, joinItems, openLayoutItem, shownPanes, splitBeside, type Layout } from '@/panes/split-groups'

export type AppControlRequest =
  | { action: 'open'; target: string; split?: 'right' | 'down'; beside?: string; focus?: boolean }
  | { action: 'split'; direction: 'right' | 'down'; target?: string }
  | { action: 'join'; pane: string; with: string }
  | { action: 'close-pane'; pane: string }
  | { action: 'layout' }
  | { action: 'status' }

export type AppControlIds = { pane(): string; group(): string; launcher(): string }
export type AppControlResult = Layout | LayoutListing | { status: 'already-joined'; layout: Layout }
export type LayoutListing = { panes: Array<{ id: string; target: string; focused: boolean }>; focused: string }

function itemFor(target: string): string {
  if (/^(chat|session|terminal|worktree|project|page|file|url|code):/.test(target)) {
    if (target.startsWith('url:')) throw new Error('the desktop app does not have a browser pane for URL targets')
    if (target.startsWith('file:')) throw new Error('file targets must include a worktree Code target')
    if (target.startsWith('worktree:') || target.startsWith('project:')) return `project:${target.slice(target.indexOf(':') + 1)}`
    if (target.startsWith('page:')) {
      const page = target.slice('page:'.length).split('/', 1)[0]
      const sub = target.slice('page:'.length).split('/').slice(1).join('/')
      return page === 'artifacts' ? `artifact:${sub || 'home'}` : page === 'knowledge' ? `knowledge:${sub || 'home'}` : page === 'tasks' ? 'tasks:home' : page === 'settings' ? 'knowledge:settings' : (() => { throw new Error(`unknown target: ${target}`) })()
    }
    if (target.startsWith('chat:')) return `native:${target.slice('chat:'.length)}`
    if (target.startsWith('session:')) return target
    if (target.startsWith('terminal:')) return target
    if (target.startsWith('code:')) return target
  }
  throw new Error(`unknown target: ${target}`)
}

function leafFor(layout: Layout, id: string): PaneLeaf | undefined {
  const panes = [layout.single, ...layout.groups.map((group) => group.panes)]
  return panes.flatMap((entry) => paneList(entry.root)).find((leaf) => leaf.id === id)
}

function focusPane(layout: Layout, id: string): Layout {
  const group = layout.groups.find((candidate) => paneList(candidate.panes.root).some((leaf) => leaf.id === id))
  if (group !== undefined) {
    const focused = focusGroup(layout, group.id)
    return { ...focused, groups: focused.groups.map((entry) => entry.id === group.id ? { ...entry, panes: { ...entry.panes, focused: id } } : entry) }
  }
  if (paneList(layout.single.root).some((leaf) => leaf.id === id)) return { ...layout, active: null, single: { ...layout.single, focused: id } }
  const item = itemFor(id)
  const found = [...layout.groups.flatMap((candidate) => paneList(candidate.panes.root)), ...paneList(layout.single.root)].find((leaf) => leaf.item === item)
  if (found !== undefined) return focusPane(layout, found.id)
  throw new Error(`unknown pane: ${id}`)
}

export function listAppLayout(layout: Layout): LayoutListing {
  const shown = shownPanes(layout)
  const leaves = paneList(shown.root)
  return { panes: leaves.map((leaf) => ({ id: leaf.id, target: leaf.item, focused: leaf.id === shown.focused })), focused: shown.focused }
}

/** Applies remote app requests through the same pure pane model used by desktop interactions. */
export function applyAppControl(layout: Layout, request: { action: 'layout' | 'status' }, ids: AppControlIds): LayoutListing
export function applyAppControl(layout: Layout, request: { action: 'join'; pane: string; with: string }, ids: AppControlIds): Layout | { status: 'already-joined'; layout: Layout }
export function applyAppControl(layout: Layout, request: Exclude<AppControlRequest, { action: 'layout' | 'status' | 'join' }>, ids: AppControlIds): Layout
export function applyAppControl(layout: Layout, request: Exclude<AppControlRequest, { action: 'layout' | 'status' }>, ids: AppControlIds): Layout | { status: 'already-joined'; layout: Layout }
export function applyAppControl(layout: Layout, request: AppControlRequest, ids: AppControlIds): AppControlResult {
  if (request.action === 'layout') return listAppLayout(layout)
  if (request.action === 'status') return listAppLayout(layout)
  if (request.action === 'open') {
    const item = itemFor(request.target)
    let base = request.beside === undefined ? layout : focusPane(layout, request.beside)
    if (request.split === undefined) return openLayoutItem(base, item)
    const next = splitBeside(base, item, request.split === 'right' ? 'right' : 'bottom', `launcher:${ids.launcher()}`, { pane: ids.pane(), group: ids.group() })
    if (next === null) throw new Error('target is already open in the focused pane')
    return next
  }
  if (request.action === 'split') {
    const target = request.target === undefined ? `launcher:${ids.launcher()}` : itemFor(request.target)
    const next = splitBeside(layout, target, request.direction === 'right' ? 'right' : 'bottom', `launcher:${ids.launcher()}`, { pane: ids.pane(), group: ids.group() })
    if (next === null) throw new Error('could not split the focused pane')
    return next
  }
  if (request.action === 'join') {
    const pane = leafFor(layout, request.pane)
    const withPane = leafFor(layout, request.with)
    if (pane === undefined || withPane === undefined) throw new Error(`unknown pane: ${pane === undefined ? request.pane : request.with}`)
    const sourceGroup = layout.groups.find((group) => paneList(group.panes.root).some((leaf) => leaf.id === request.pane))
    const targetGroup = layout.groups.find((group) => paneList(group.panes.root).some((leaf) => leaf.id === request.with))
    if (sourceGroup !== undefined && sourceGroup.id === targetGroup?.id) return { status: 'already-joined', layout }
    return joinItems(layout, pane.item, withPane.item, { pane: ids.pane(), group: ids.group() })
  }
  const target = leafFor(layout, request.pane)
  if (target === undefined) throw new Error(`unknown pane: ${request.pane}`)
  const group = layout.groups.find((candidate) => paneList(candidate.panes.root).some((leaf) => leaf.id === request.pane))
  if (group === undefined) throw new Error('cannot close the only pane')
  const next = closePane(group.panes, request.pane)
  if (paneList(next.root).length === paneList(group.panes.root).length) throw new Error(`could not close pane: ${request.pane}`)
  if (paneList(next.root).length < 2) {
    const groups = layout.groups.filter((entry) => entry.id !== group.id)
    if (layout.active !== group.id) return { ...layout, groups }
    return { ...layout, groups, active: null, single: singlePane(paneList(next.root)[0]?.item ?? 'launcher:new', paneList(next.root)[0]?.id ?? ids.pane()) }
  }
  return { ...layout, groups: layout.groups.map((entry) => entry.id === group.id ? { ...entry, panes: next } : entry) }
}
