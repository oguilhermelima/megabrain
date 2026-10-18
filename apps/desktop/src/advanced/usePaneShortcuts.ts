import { useEffect } from 'react'
import type { Project, ProjectSession } from '@/api/schema'
import { displayName } from '@/advanced/appearance-model'
import { neighbourSession } from '@/advanced/projects-model'
import { partitionHidden } from '@/advanced/sidebar-model'
import { recordingShortcut, useShortcutBindings } from '@/lib/shortcut-store'
import { matchShortcut, type ShortcutId } from '@/lib/shortcuts'
import { paneList, type Direction, type Panes } from '@/panes/pane-model'
import { navigate } from '@/panes/strip'
import type { Layout } from '@/panes/split-groups'

const paneDirections: Partial<Record<ShortcutId, Direction>> = { 'pane.focusLeft': 'left', 'pane.focusRight': 'right', 'pane.focusUp': 'up', 'pane.focusDown': 'down' }

export function focusPaneInput(paneId: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(paneId)}"]`)?.querySelector<HTMLElement>('textarea, [contenteditable="true"], input')?.focus({ preventScroll: true }))
}

export function worktreeChoices(projects: Project[]) {
  return partitionHidden(projects).visible.flatMap((project) =>
    project.missing ? [] : project.worktrees.map((worktree) => ({ path: worktree.path, project: displayName(project), label: `${displayName(project)} · ${worktree.branch ?? worktree.path.split('/').at(-1) ?? worktree.path}` })),
  )
}

export function usePaneShortcuts({
  sessionRows, selectedSessionId, openSession, sidebarCollapsed, toggleSidebarCollapsed, openNewChat,
  runRoot, projects, panes, paneLayout, settingsOpen, setSettingsOpen, setPanes, openTerminal, closePaneById, closeFocused, splitWith,
}: {
  sessionRows: Parameters<typeof neighbourSession>[0]
  selectedSessionId: string | null
  openSession: (session: ProjectSession, worktreePath: string) => void
  sidebarCollapsed: boolean
  toggleSidebarCollapsed: () => void
  openNewChat: (path: string | null) => void
  runRoot: string | null
  projects: Project[]
  panes: Panes
  paneLayout: Layout
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  setPanes: (change: (current: Panes) => Panes) => void
  openTerminal: (cwd: string, launcher: string | null) => void
  closePaneById: (paneId: string) => void
  closeFocused: () => Promise<void>
  splitWith: (item: string | null, edge: 'right' | 'bottom') => void
}) {
  const shortcutKeys = useShortcutBindings()
  const focusPaneById = (paneId: string) => {
    setPanes((current) => ({ ...current, focused: paneId }))
    focusPaneInput(paneId)
  }
  const focusSidebar = () => {
    if (sidebarCollapsed) toggleSidebarCollapsed()
    requestAnimationFrame(() => {
      const nav = document.querySelector<HTMLElement>('nav[aria-label="Projects"]')
      ;(nav?.querySelector<HTMLElement>('[aria-current="true"]') ?? nav?.querySelector<HTMLElement>('button'))?.focus()
    })
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (recordingShortcut()) return
      const id = matchShortcut(event, shortcutKeys)
      if (id === 'settings.open') setSettingsOpen(true)
      else if (id === 'chat.new') openNewChat(null)
      else if (id === 'sidebar.toggle') toggleSidebarCollapsed()
      else if (id === 'sidebar.focus') focusSidebar()
      else if (id === 'item.next' || id === 'item.previous') {
        const next = neighbourSession(sessionRows, selectedSessionId, id === 'item.next' ? 1 : -1)
        if (next !== null) openSession(next.session, next.worktreePath)
      } else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionRows, selectedSessionId, shortcutKeys, sidebarCollapsed])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (recordingShortcut()) return
      const id = matchShortcut(event, shortcutKeys)
      if (id === null) return
      const direction = paneDirections[id]
      if (id === 'terminal.new') {
        const cwd = runRoot ?? worktreeChoices(projects)[0]?.path ?? null
        if (cwd !== null && cwd !== '') openTerminal(cwd, null)
      } else if (settingsOpen) return
      else if (id === 'pane.close') {
        if (paneList(panes.root).length > 1) closePaneById(panes.focused)
        else closeFocused().catch(() => {})
      } else if (id === 'pane.splitRight' || id === 'pane.splitDown') splitWith(null, id === 'pane.splitRight' ? 'right' : 'bottom')
      else if (id === 'pane.next' || id === 'pane.previous') {
        const leaves = paneList(panes.root)
        const at = leaves.findIndex((leaf) => leaf.id === panes.focused)
        const target = leaves[(at + (id === 'pane.next' ? 1 : -1) + leaves.length) % leaves.length]?.id ?? null
        if (target === null || leaves.length < 2) return
        focusPaneById(target)
      } else if (direction !== undefined) {
        const target = navigate(panes.root, panes.focused, direction)
        if (target === null) return
        focusPaneById(target)
      } else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [runRoot, projects, panes, paneLayout, settingsOpen, shortcutKeys])
}
