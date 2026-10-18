import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { api } from '@/api'
import type { NativeChat, Project, ProjectSession, ProjectWorktree } from '@/api/schema'
import { stackActions, stackChain, worktreeTree, type StackAction } from '@/advanced/stacks'
import { useStackDetails } from '@/advanced/useStackDetails'
import { displayName } from '@/advanced/appearance-model'
import { archiveDone, archiveFailed, beginArchive, beginRestore, reconcileArchives, restoreDone, restoreFailed, withoutArchived, type ArchiveMap, type ArchiveTarget } from '@/advanced/archive-model'
import { createFolder, deleteFolder, folderOf, layoutDropTarget, moveEntry, moveToFolder, renameFolder, sidebarEntries, stepEntry, toggleFolder, type DropPlacement, type LayoutRow, type SidebarFolder, type SidebarLayout } from '@/advanced/sidebar-folders'
import { ArtifactsIcon, Chevron, KnowledgeIcon, PlusIcon, TasksIcon } from '@/advanced/chrome'
import { creationsIn, type PendingWorktree } from '@/advanced/new-worktree-model'
import { NewWorktreeDialog } from '@/advanced/NewWorktreeDialog'
import { moveRow } from '@/advanced/row-model'
import { foldKeys, pruneSidebarState, type SidebarState } from '@/advanced/sidebar-state'
import { useSidebarState } from '@/advanced/useSidebarLayout'
import { SpanningSplits, type SplitDrop } from '@/advanced/SplitRows'
import { useRowDrag } from '@/advanced/useRowDrag'
import { ContextMenu, menuFrom, openMenuFromKeyboard, type MenuItem, type OpenMenu } from '@/components/ContextMenu'
import { Collapse } from '@/components/Collapse'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { Toast, type ToastMessage } from '@/components/Toast'
import { FilterMenu, HeaderButton, SearchField, SearchIcon } from '@/advanced/SidebarTools'
import { activeFilterLabels, emptyFilters, filterProjects, hasFilters, parseFilters, partitionHidden, type HiddenPartition, type SidebarFilters } from '@/advanced/sidebar-model'
import { SidebarSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import type { GithubKind } from '@/github/useGithubCounts'
import { announceAction } from '@/lib/app-events'
import { matchShortcut } from '@/lib/shortcuts'
import { useShortcutBindings } from '@/lib/shortcut-store'
import { insideRoots } from '@/lib/external'
import { useStableCallback } from '@/lib/useStableCallback'
import { useFlip } from '@/advanced/useFlip'
import { chatMenu, sessionMenu, terminalMenu, type RowMenuActions } from '@/advanced/item-menus'
import type { AppTerminal } from '@/terminal/terminal-list'
import { MoreButton, useNow, type MenuOpener, type RowDragger, type SidebarDrag } from '@/advanced/SidebarRows'
import { DragGhost, FolderSection, PageEntry, swallowNextClick, type ProjectDrag } from '@/advanced/SidebarSections'
import { ProjectSection, type CreationRows, type SidebarActions, type StackRows } from '@/advanced/ProjectSection'
import { codeTargetFor, type CodeTarget } from '@/code/code-pane-model'
import { githubRepository } from '@/github/github-model'
import type { ItemRows, TerminalRows } from '@/advanced/WorktreeRow'

const filtersKey = 'megabrain.sidebar.filters'
export function readFilters(): SidebarFilters {
  try {
    return parseFilters(localStorage.getItem(filtersKey))
  } catch {
    return emptyFilters
  }
}

export function writeFilters(filters: SidebarFilters) {
  try {
    localStorage.setItem(filtersKey, JSON.stringify(filters))
  } catch {
    // Remembered filters are a convenience; starting unfiltered is fine.
  }
}

export type { SidebarDrag } from '@/advanced/SidebarRows'

const noCreations: PendingWorktree[] = []

const worktreeName = (worktree: ProjectWorktree) => worktree.branch ?? `Detached HEAD at ${worktree.head ?? ''}`

function HiddenSection({ hidden, onShow }: { hidden: HiddenPartition; onShow: (target: { project: string } | { worktree: string }) => void }) {
  const [open, setOpen] = useState(false)
  const count = hidden.hiddenProjects.length + hidden.hiddenWorktrees.length
  if (count === 0) return null
  const row = (key: string, label: string, detail: string | null, target: { project: string } | { worktree: string }) => (
    <li key={key} className="group flex h-8 items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 transition-colors hover:bg-row-hover">
      <span className="min-w-0 truncate text-[13px] text-ink-300">{label}</span>
      {detail !== null && <span className="shrink-0 truncate text-[11.5px] text-ink-400">{detail}</span>}
      <button type="button" onClick={() => onShow(target)} className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold text-ink-300 hover:bg-white/[0.1] hover:text-ink-100">
        Show
      </button>
    </li>
  )
  return (
    <section className="space-y-1 border-t border-white/[0.07] pt-3">
      <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open} className="flex h-8 w-full items-center gap-2 rounded-[12px] pr-1.5 pl-2.5 text-left text-[13px] font-semibold text-ink-400 transition-colors hover:text-ink-200">
        <Chevron open={open} />
        Hidden
        <span className="ml-auto text-[11px] font-medium tabular-nums">{count}</span>
      </button>
      <Collapse open={open}>
        <ul className="space-y-0.5 pt-1">
          {hidden.hiddenProjects.map((project) => row(`p:${project.path}`, displayName(project), 'project', { project: project.path }))}
          {hidden.hiddenWorktrees.map(({ project, worktree }) => row(`w:${worktree.path}`, worktreeName(worktree), displayName(project), { worktree: worktree.path }))}
        </ul>
      </Collapse>
    </section>
  )
}

// Every project the person works on, main checkout first with its worktrees and their stacks
// (see stacks.ts), and the agent sessions running in each. Each project and worktree has a
// menu (right click or …) to hide it, remove it or open its code; hidden ones wait at the bottom.
export const Sidebar = memo(function Sidebar({
  loaded,
  layoutReady,
  loadError,
  onRetryLoad,
  projects,
  selectedSessionId,
  onSelectSession,
  onCode,
  onImport,
  layout,
  onLayout,
  layoutError,
  filters,
  onFilters,
  onGithub,
  onOpenProject,
  selectedProject,
  chats,
  selectedChatId,
  onSelectChat,
  onNewChat,
  onNewTerminal,
  terminals,
  selectedTerminalId,
  onSelectTerminal,
  onRenameTerminal,
  onCloseRow,
  onDragRow,
  onSplitDrop,
  creations,
  onCreateWorktree,
  onRetryCreation,
  onDismissCreation,
  knowledgeSelected,
  onOpenKnowledge,
  artifactsSelected,
  onOpenArtifacts,
  tasksSelected,
  onOpenTasks,
}: {
  /** The Knowledge page is in the focused pane. */
  knowledgeSelected: boolean
  /** Shows the Knowledge page. */
  onOpenKnowledge: () => void
  /** The Artifacts page is in the focused pane. */
  artifactsSelected: boolean
  /** Shows the Artifacts page. */
  onOpenArtifacts: () => void
  /** The Tasks page is in the focused pane. */
  tasksSelected: boolean
  /** Shows the Tasks page. */
  onOpenTasks: () => void
  /** A row joined into a split, a member leaving its group, or a group's members reordered; see useRowDrag. */
  onSplitDrop: (drop: SplitDrop) => void
  /** Worktrees being created, shown as pending rows under their project. */
  creations: PendingWorktree[]
  onCreateWorktree: (project: Project, branch: string, base: string) => void
  onRetryCreation: (id: string) => void
  onDismissCreation: (id: string) => void
  /** A chat, session or terminal row dragged toward the main area. */
  onDragRow: RowDragger
  /** Opens a new terminal in a worktree. */
  onNewTerminal: (worktreePath: string) => void
  /** Terminals the app opened, by worktree path. */
  terminals: Record<string, AppTerminal[]>
  selectedTerminalId: string | null
  onSelectTerminal: (terminal: AppTerminal) => void
  onRenameTerminal: (terminal: AppTerminal, name: string) => void
  /** Closes a chat, terminal or session row, asking first about what still runs; rejects with megabrain's refusal. */
  onCloseRow: (row: SidebarDrag) => Promise<void>
  /** Native chats by worktree path. */
  chats: Record<string, NativeChat[]>
  selectedChatId: string | null
  onSelectChat: (chat: NativeChat) => void
  /** Opens the new chat sheet for a worktree. */
  onNewChat: (worktreePath: string) => void
  /** The first projects read has answered; until then an empty list is still loading. */
  loaded: boolean
  /** The last projects read's error; shown with Retry while nothing has loaded yet. */
  loadError: unknown
  onRetryLoad: () => void
  projects: Project[]
  selectedSessionId: string | null
  onSelectSession: (session: ProjectSession) => void
  /** Shows a root in Code, the embedded editor, in a pane. */
  onCode: (target: CodeTarget) => void
  onImport: () => void
  /** The folders and top-level order, reconciled with the listed projects; drags, ⌥↑ ⌥↓ and the folder menus send the next one. */
  layout: SidebarLayout
  onLayout: (layout: SidebarLayout) => void
  /** Why the folders could not be read or saved, if so. */
  layoutError: unknown
  /** The saved folders have been read (or failed to be); the list waits for them. */
  layoutReady: boolean
  filters: SidebarFilters
  onFilters: (filters: SidebarFilters) => void
  /** Opens a project's pull request or issue page. */
  onGithub: (project: Project, kind: GithubKind, focus?: number) => void
  /** Opens a project's own page, its overview and actions, in the focused pane. */
  onOpenProject: (project: Project) => void
  /** The path of the project whose page is in the focused pane, if any. */
  selectedProject: string | null
}) {
  // What is folded and each worktree's row order, kept across restarts (useSidebarState); the list
  // waits for them so it never draws unfolded and then jumps.
  const { state: savedState, change: changeSavedState, error: savedStateError, ready: savedStateReady } = useSidebarState()
  const collapsed = useMemo(() => new Set(savedState.collapsed), [savedState.collapsed])
  const ready = layoutReady && savedStateReady
  // Every save drops what no longer exists: folds of projects, stacks and worktrees gone, orders of worktrees gone.
  const saveState = useStableCallback((next: SidebarState) => {
    const worktrees = projects.flatMap((project) => project.worktrees.map((worktree) => worktree.path))
    changeSavedState(pruneSidebarState(next, { collapsible: foldKeys(projects), worktrees: new Set([...projects.map((project) => project.path), ...worktrees]) }))
  })
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  // The new worktree dialog: from the project's +, or on a branch to stack on it.
  const [newWorktreeFor, setNewWorktreeFor] = useState<{ project: Project; base?: string } | null>(null)
  const openNewWorktree = useStableCallback((project: Project) => setNewWorktreeFor({ project }))
  const retryCreation = useStableCallback(onRetryCreation)
  const dismissCreation = useStableCallback(onDismissCreation)
  const creationRows = useMemo<CreationRows>(() => ({ retry: retryCreation, dismiss: dismissCreation }), [retryCreation, dismissCreation])
  // One list per project, so a creation elsewhere leaves the other memoised rows alone.
  const creationsByProject = useMemo(() => Object.fromEntries(projects.flatMap((project) => {
    const list = creationsIn(creations, project.path)
    return list.length === 0 ? [] : [[project.path, list]]
  })), [projects, creations])
  const [actionError, setActionError] = useState<unknown>(null)
  // Branches being archived leave the list at once (archive-model.ts); the toast offers Undo.
  const [archives, setArchives] = useState<ArchiveMap>({})
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const closeToast = useCallback(() => setToast(null), [])
  useEffect(() => setArchives((current) => reconcileArchives(current, projects)), [projects])
  const shownProjects = useMemo(() => withoutArchived(projects, archives), [projects, archives])
  const partition = useMemo(() => partitionHidden(shownProjects), [shownProjects])
  const closeMenu = useCallback(() => setMenu(null), [])
  const now = useNow(30_000)
  const visible = useMemo(() => filterProjects(partition.visible, filters), [partition, filters])
  const filtered = hasFilters(filters)
  const [searchOpen, setSearchOpen] = useState(filters.query !== '')
  const searchRef = useRef<HTMLInputElement>(null)
  const searching = filters.query.trim() !== ''
  const openSearch = () => {
    setSearchOpen(true)
    searchRef.current?.focus()
  }
  // Projects fold by path (two can share a name); stacks and worktrees by their keys (sidebar-state).
  const toggle = useStableCallback((key: string) => {
    const folded = savedState.collapsed
    saveState({ ...savedState, collapsed: folded.includes(key) ? folded.filter((entry) => entry !== key) : [...folded, key] })
  })

  const navRef = useRef<HTMLElement>(null)
  // The Projects header sits above the list on the sidebar's own glass: no tint or blur of its own,
  // which inside the glass would stack a second, darker layer.
  // Rows that scroll up fade out under its edge, and a hairline shows once they do.
  const [scrolled, setScrolled] = useState(false)
  // The list keeps a scrollbar gutter the header has not got; the header pads by the measured width,
  // so its right edge is the list's whatever width the webview gives the scrollbar (6px, or 0 when
  // it overlays).
  const listRef = useRef<HTMLDivElement>(null)
  const [gutter, setGutter] = useState(6)
  useLayoutEffect(() => {
    const list = listRef.current
    if (list !== null) setGutter(list.offsetWidth - list.clientWidth)
  }, [])
  // Rows that change place slide there (useFlip); every layout change goes through here.
  const captureRows = useFlip(navRef)
  const applyLayout = (next: SidebarLayout) => {
    captureRows()
    onLayout(next)
  }
  // A project or a folder being dragged, and where it would land.
  const [dragState, setDragState] = useState<{ key: string; target: { key: string; placement: DropPlacement } | null } | null>(null)
  // Every project and folder header on screen, in order; a project inside a folder names it.
  const dropRows = (): LayoutRow[] =>
    [...(navRef.current?.querySelectorAll<HTMLElement>('[data-entry-key]') ?? [])].map((element) => {
      const rect = element.getBoundingClientRect()
      const folder = element.dataset.entryFolder !== undefined
      const parent = folder ? null : (element.parentElement?.closest<HTMLElement>('[data-folder-id]')?.dataset.folderId ?? null)
      return { key: element.dataset.entryKey ?? '', parent, folder, open: element.dataset.entryOpen !== undefined, top: rect.top, bottom: rect.bottom }
    })

  const dragStart = useStableCallback((event: PointerEvent<HTMLElement>, path: string) => {
    if (event.button !== 0) return
    const startY = event.clientY
    let moving = false
    const onMove = (move: globalThis.PointerEvent) => {
      if (!moving && Math.abs(move.clientY - startY) < 4) return
      moving = true
      setDragState({ key: path, target: layoutDropTarget(dropRows(), move.clientY, path) })
    }
    const onUp = (up: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      if (!moving) return
      swallowNextClick()
      setDragState(null)
      const target = layoutDropTarget(dropRows(), up.clientY, path)
      if (target !== null) applyLayout(moveEntry(layout, path, target))
    }
    const onCancel = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      setDragState(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  })
  const dragKey = useStableCallback((event: KeyboardEvent<HTMLElement>, path: string) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    const next = stepEntry(layout, path, event.key === 'ArrowUp' ? -1 : 1, new Set(visible.map((project) => project.path)))
    if (next === layout) return
    applyLayout(next)
    // Moving the row re-inserts it in the list, which drops focus; give it back.
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>(`[data-entry-toggle="${CSS.escape(path)}"]`)?.focus())
  })
  const drag = useMemo<ProjectDrag>(() => ({ start: dragStart, key: dragKey }), [dragStart, dragKey])
  const edgeOf = (key: string) => (dragState?.target?.key === key ? dragState.target.placement : null)

  // Folders: made from the header's + menu or a project's menu, renamed in place, removed after a confirm.
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const newFolder = useStableCallback((project?: string) => {
    const id = `folder-${crypto.randomUUID()}`
    applyLayout(createFolder(layout, id, 'New folder', project))
    setRenamingFolder(id)
  })
  const renameTo = (id: string, name: string | null) => {
    setRenamingFolder(null)
    if (name !== null) applyLayout(renameFolder(layout, id, name))
  }
  const folderItems = (folder: SidebarFolder): MenuItem[] => [
    { label: 'Rename…', icon: 'rename', group: 'organise', onSelect: () => setRenamingFolder(folder.id) },
    {
      label: 'Delete folder…',
      icon: 'trash',
      group: 'danger',
      onSelect: () =>
        setConfirm({
          title: `Delete ${folder.name}?`,
          body: folder.projects.length === 0 ? 'The folder is empty; nothing else changes.' : 'Its projects move back to the top level of the sidebar, where the folder was. Nothing on disk changes.',
          action: 'Delete folder',
          run: async () => applyLayout(deleteFolder(layout, folder.id)),
        }),
    },
  ]
  const moveItems = useStableCallback((project: Project): MenuItem[] => {
    const current = folderOf(layout, project.path)
    return [
      ...layout.folders.filter((folder) => folder.id !== current?.id).map((folder): MenuItem => ({ label: `Move to ${folder.name}`, icon: 'folder', group: 'organise', onSelect: () => applyLayout(moveToFolder(layout, project.path, folder.id)) })),
      { label: 'Move to new folder', icon: 'newFolder', group: 'organise', onSelect: () => newFolder(project.path) },
      ...(current === null ? [] : [{ label: `Move out of ${current.name}`, icon: 'moveOut', group: 'organise', onSelect: () => applyLayout(moveToFolder(layout, project.path, null)) } satisfies MenuItem]),
    ]
  })

  // The row whose menu is open keeps its actions visible; see rowAction.
  const menuRow = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const row = menuRow.current
    if (menu === null || row === null) return
    row.dataset.menuOpen = ''
    return () => {
      delete row.dataset.menuOpen
    }
  }, [menu])

  const openMenu: MenuOpener = useCallback((event, items) => {
    event.preventDefault()
    event.stopPropagation()
    menuRow.current = event.currentTarget.closest<HTMLElement>('.group')
    setMenu(menuFrom(event, items))
  }, [])

  const setHidden = useCallback((target: { project: string } | { worktree: string }, hidden: boolean) => {
    setActionError(null)
    api.setHidden(target, hidden).catch(setActionError)
  }, [])

  const closeRow = useStableCallback((row: SidebarDrag) => {
    setActionError(null)
    onCloseRow(row).catch(setActionError)
  })

  const searchKeys = useShortcutBindings()
  const [renamingTerminal, setRenamingTerminal] = useState<string | null>(null)
  const stopChat = useStableCallback((chat: NativeChat) =>
    setConfirm({
      title: `Stop ${chat.title ?? 'New chat'}?`,
      body: 'The agent ends its turn and megabrain closes the conversation. Its history stays readable.',
      action: 'Stop chat',
      run: () => api.stopChat(chat.id).then(announceAction),
    }),
  )

  // Stacks: review, checks and behind counts read in the background, folds kept with the other
  // collapses, and one running action per row shown on it until megabrain answers.
  const { details: stackDetails, forget: forgetStack } = useStackDetails(partition.visible)
  const [stackBusy, setStackBusy] = useState<Record<string, string>>({})
  const runStack = useStableCallback((project: Project, worktree: ProjectWorktree, verb: 'sync' | 'pr' | 'merge', word: string, draft: boolean = false): Promise<void> => {
    const branch = worktree.branch
    if (branch === null) return Promise.resolve()
    setActionError(null)
    setStackBusy((current) => ({ ...current, [worktree.path]: word }))
    const done = () => {
      forgetStack(project.path)
      setStackBusy((current) => {
        const next = { ...current }
        delete next[worktree.path]
        return next
      })
    }
    return api.stackRun(project.path, branch, verb, { draft }).then(done, (caught: unknown) => {
      done()
      throw caught
    })
  })
  const stackItem = useStableCallback((project: Project, worktree: ProjectWorktree, action: StackAction): MenuItem => {
    const branch = worktree.branch ?? ''
    const chainOf = () => stackChain(worktreeTree(projects.find((item) => item.path === project.path) ?? project), worktree.path)
    switch (action.kind) {
      case 'new-stacked':
        return { label: 'New stacked branch…', icon: 'stack', group: 'git', onSelect: () => setNewWorktreeFor({ project, base: branch }) }
      case 'sync':
        return {
          label: 'Sync stack…',
          icon: 'sync',
          group: 'git',
          onSelect: () => {
            const names = chainOf()?.members.flatMap((member) => (member.branch === null ? [] : [member.branch])) ?? [branch]
            setConfirm({
              title: 'Sync this stack?',
              body: `Each branch is rebased on its parent and pushed with --force-with-lease, bottom-up: ${names.join(', then ')}. A conflict stops the sync and names the files.`,
              action: 'Sync stack',
              tone: 'primary',
              run: () => runStack(project, worktree, 'sync', 'syncing'),
            })
          },
        }
      case 'pr':
        return {
          label: action.draft ? 'Open draft PRs for stack' : 'Open PRs for stack',
          icon: 'pullRequest',
          group: 'git',
          onSelect: () => void runStack(project, worktree, 'pr', 'opening PRs', action.draft).catch(setActionError),
        }
      case 'merge':
        return {
          label: 'Merge stack…',
          icon: 'merge',
          group: 'git',
          onSelect: () =>
            setConfirm({
              title: 'Merge this stack?',
              body: `The pull requests merge bottom-up, in this order: ${action.pullRequests.map((pull) => `#${pull.number} ${pull.branch}`).join(', then ')}. megabrain refuses when a branch has commits that are not pushed.`,
              action: 'Merge stack',
              run: () => runStack(project, worktree, 'merge', 'merging'),
            }),
        }
      case 'show-github':
        return { label: 'Show on GitHub', icon: 'external', group: 'open', onSelect: () => onGithub(project, 'prs', worktree.pullRequest?.number) }
    }
  })

  const restore = useStableCallback((target: ArchiveTarget) => {
    setActionError(null)
    setArchives((current) => beginRestore(current, target))
    api.unarchiveWorktree(target.repo, target.branch).then(
      () => setArchives((current) => restoreDone(current, target.path)),
      (caught: unknown) => {
        setArchives((current) => restoreFailed(current, target.path))
        setActionError(caught)
      },
    )
  })
  // Runs inside the confirm, so a refusal shows there with megabrain's reasons and Archive anyway.
  const archive = useStableCallback((target: ArchiveTarget, confirm: PendingConfirm, force: boolean): Promise<void> => {
    setArchives((current) => beginArchive(current, target))
    return api.archiveWorktree(target.path, { force }).then(
      () => {
        setArchives((current) => archiveDone(current, target.path))
        setToast({ id: `${target.path}:${Date.now()}`, text: `Archived ${target.branch}`, action: { label: 'Undo', run: () => restore(target) } })
      },
      (caught: unknown) => {
        setArchives((current) => archiveFailed(current, target.path))
        if (!force) setConfirm({ ...confirm, alternative: { label: 'Archive anyway', run: () => archive(target, confirm, true) } })
        throw caught
      },
    )
  })
  const confirmArchive = useStableCallback((project: Project, worktree: ProjectWorktree) => {
    const branch = worktree.branch
    if (branch === null) return
    const target: ArchiveTarget = { repo: project.path, branch, path: worktree.path }
    const confirm: PendingConfirm = {
      title: `Archive ${branch}?`,
      body: `megabrain removes the folder ${worktree.path} and keeps the branch ${branch}; restore it from the toast or from ${displayName(project)} in Settings. It refuses when the folder has changes that are not committed or commits that are not pushed.`,
      action: 'Archive',
      tone: 'primary',
      run: () => archive(target, confirm, false),
    }
    setConfirm(confirm)
  })

  const copyText = useStableCallback((text: string) => {
    setActionError(null)
    navigator.clipboard.writeText(text).catch(setActionError)
  })
  // Only a listed project or worktree (or a folder inside one) is handed to Finder.
  const reveal = useStableCallback((path: string) => {
    setActionError(null)
    const roots = projects.flatMap((project) => [project.path, ...project.worktrees.map((worktree) => worktree.path)])
    if (!insideRoots(path, roots)) {
      setActionError(new Error(`${path} is not a listed project or worktree.`))
      return
    }
    api.revealPath(path).catch(setActionError)
  })
  // Reads the projects again now, and this project's stacks with them.
  const refreshProject = useStableCallback((path: string | null) => {
    if (path !== null) forgetStack(path)
    announceAction()
  })
  // The header's + menu, and the list's own menu for a right click between rows.
  const addItems = (): MenuItem[] => [
    { label: 'Import project…', icon: 'import', group: 'open', onSelect: onImport },
    { label: 'New folder', icon: 'newFolder', group: 'organise', onSelect: () => newFolder() },
  ]
  const listItems = (): MenuItem[] => [...addItems(), { label: 'Refresh', icon: 'refresh', group: 'copy', onSelect: () => refreshProject(null) }]

  const rowMenuActions = useMemo<RowMenuActions>(
    () => ({ close: closeRow, copy: copyText, stop: stopChat, rename: (terminal) => setRenamingTerminal(terminal.id) }),
    [closeRow, copyText, stopChat],
  )
  const actions = useMemo<SidebarActions>(() => ({
    code: onCode,
    project: (project) => [
      { label: 'Open project page', icon: 'folder', group: 'open', onSelect: () => onOpenProject(project) },
      { label: 'New chat', icon: 'chat', group: 'open', onSelect: () => onNewChat(project.path) },
      { label: 'Open in Code', icon: 'code', group: 'open', onSelect: () => onCode(codeTargetFor(project)) },
      ...(githubRepository(project.remote) === null
        ? []
        : [
            { label: 'Pull requests', icon: 'pullRequest', group: 'open', onSelect: () => onGithub(project, 'prs') } satisfies MenuItem,
            { label: 'Issues', icon: 'external', group: 'open', onSelect: () => onGithub(project, 'issues') } satisfies MenuItem,
          ]),
      { label: 'Reveal in Finder', icon: 'reveal', group: 'open', onSelect: () => reveal(project.path) },
      { label: 'New worktree…', icon: 'branch', group: 'git', onSelect: () => openNewWorktree(project) },
      { label: 'Copy path', icon: 'copy', group: 'copy', onSelect: () => copyText(project.path) },
      { label: 'Refresh', icon: 'refresh', group: 'copy', onSelect: () => refreshProject(project.path) },
      ...moveItems(project),
      { label: 'Hide', icon: 'hide', group: 'organise', onSelect: () => setHidden({ project: project.path }, true) },
      {
        label: 'Remove from megabrain…',
        icon: 'trash',
        group: 'danger',
        onSelect: () =>
          setConfirm({
            title: `Remove ${displayName(project)} from megabrain?`,
            body: `megabrain stops listing this project. The folder and its files stay where they are (${project.path}); import it again with + to bring it back.`,
            action: 'Remove',
            run: () => api.removeProject(project.path),
          }),
      },
    ],
    worktree: (project, node, tree) => {
      const { worktree } = node
      const name = worktreeName(worktree)
      const items: MenuItem[] = [
        { label: 'New chat', icon: 'chat', group: 'open', onSelect: () => onNewChat(worktree.path) },
        { label: 'New terminal', icon: 'terminal', group: 'open', onSelect: () => onNewTerminal(worktree.path) },
        { label: 'Open in Code', icon: 'code', group: 'open', onSelect: () => onCode(codeTargetFor(project, worktree)) },
        { label: 'Reveal in Finder', icon: 'reveal', group: 'open', onSelect: () => reveal(worktree.path) },
        ...stackActions(project, tree, node).map((action) => stackItem(project, worktree, action)),
        { label: 'Copy path', icon: 'copy', group: 'copy', onSelect: () => copyText(worktree.path) },
        ...(worktree.branch === null ? [] : [{ label: 'Copy branch name', icon: 'copy', group: 'copy', onSelect: () => copyText(worktree.branch ?? '') } satisfies MenuItem]),
        { label: 'Hide', icon: 'hide', group: 'organise', onSelect: () => setHidden({ worktree: worktree.path }, true) },
      ]
      // The main checkout is the project itself; it is removed with the project, not as a worktree.
      if (!worktree.primary && worktree.branch !== null) items.push({ label: 'Archive…', icon: 'archive', group: 'organise', onSelect: () => confirmArchive(project, worktree) })
      if (!worktree.primary) {
        items.push({
          label: 'Remove worktree…',
          icon: 'trash',
          group: 'danger',
          onSelect: () =>
            setConfirm({
              title: `Remove ${name}?`,
              body: `This deletes the folder ${worktree.path} and the branch ${worktree.branch ?? '(detached)'} from ${displayName(project)}. megabrain refuses when the branch has work that is not merged, and nothing is deleted then.`,
              action: 'Remove worktree',
              run: () => api.removeWorktree(worktree.path),
            }),
        })
      }
      return items
    },
    chat: (chat) => chatMenu(chat, rowMenuActions),
    session: (session) => sessionMenu(session, rowMenuActions),
  }), [onCode, onGithub, onOpenProject, onNewChat, openNewWorktree, reveal, copyText, refreshProject, setHidden, onNewTerminal, closeRow, moveItems, stackItem, confirmArchive, rowMenuActions])

  const terminalRows = useMemo<TerminalRows>(() => ({
    selectedId: selectedTerminalId,
    renamingId: renamingTerminal,
    select: onSelectTerminal,
    rename: (terminal, name) => {
      setRenamingTerminal(null)
      if (name !== null) onRenameTerminal(terminal, name)
    },
    items: (terminal) => terminalMenu(terminal, rowMenuActions),
  }), [selectedTerminalId, renamingTerminal, onSelectTerminal, onRenameTerminal, rowMenuActions])

  // Rows keep the order the person dragged them into, per worktree; new ones show on top.
  const rowOrder = savedState.rows
  const rowDrag = useRowDrag(
    navRef,
    {
      reorder: (worktreePath, next) => {
        captureRows()
        saveState({ ...savedState, rows: { ...savedState.rows, [worktreePath]: next } })
      },
      join: (source, target) => {
        const from = source.kind === 'group' ? ({ kind: 'group', groupId: source.groupId } as const) : source.kind === 'member' ? ({ kind: 'item', item: source.item } as const) : source.item === null ? null : ({ kind: 'item', item: source.item } as const)
        if (from === null) return
        captureRows()
        onSplitDrop({ kind: 'join', source: from, target })
      },
      leave: (groupId, item) => {
        captureRows()
        onSplitDrop({ kind: 'leave', groupId, item })
      },
      arrange: (groupId, item, target) => onSplitDrop({ kind: 'arrange', groupId, item, target }),
    },
    moveRow,
  )
  const itemRows = useMemo<ItemRows>(
    () => ({ close: closeRow, order: rowOrder, drag: rowDrag.state, start: rowDrag.start }),
    [closeRow, rowOrder, rowDrag.state, rowDrag.start],
  )

  const stackRows = useMemo<StackRows>(() => ({ details: stackDetails, folded: collapsed, fold: toggle, busy: stackBusy }), [stackDetails, collapsed, toggle, stackBusy])
  const listedByPath = new Map(shownProjects.map((project) => [project.path, project]))
  const shownByPath = new Map(visible.map((project) => [project.path, project]))
  const renderProject = (project: Project) => (
    <ProjectSection
      key={project.path}
      project={project}
      collapsed={collapsed.has(project.path)}
      onToggle={toggle}
      selectedSessionId={selectedSessionId}
      onSelectSession={onSelectSession}
      actions={actions}
      onMenu={openMenu}
      now={now}
      drag={drag}
      dragging={dragState?.key === project.path}
      edge={edgeOf(project.path)}
      selected={selectedProject === project.path}
      onOpenProject={onOpenProject}
      onGithub={onGithub}
      chats={chats}
      selectedChatId={selectedChatId}
      onSelectChat={onSelectChat}
      onNewChat={onNewChat}
      terminals={terminals}
      terminalRows={terminalRows}
      onDragRow={onDragRow}
      itemRows={itemRows}
      creations={creationsByProject[project.path] ?? noCreations}
      creationRows={creationRows}
      listed={listedByPath.get(project.path) ?? project}
      stacks={stackRows}
    />
  )

  return (
    <nav
      ref={navRef}
      className="relative flex min-h-0 flex-1 flex-col"
      aria-label="Projects"
      // A middle press closes an item row on release (WorktreeRow); it never autoscrolls or pastes here.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault()
      }}
      onKeyDown={(event) => {
        if (matchShortcut(event, searchKeys) !== 'sidebar.search' || partition.visible.length === 0) return
        event.preventDefault()
        openSearch()
      }}
    >
      {/* One entry for each of the app's pages, alphabetical. */}
      <div style={{ paddingRight: 4 + gutter }} className="shrink-0 space-y-0.5 pt-1 pl-2.5">
        <PageEntry label="Artifacts" icon={<ArtifactsIcon />} selected={artifactsSelected} onOpen={onOpenArtifacts} />
        <PageEntry label="Knowledge" icon={<KnowledgeIcon />} selected={knowledgeSelected} onOpen={onOpenKnowledge} />
        <PageEntry label="Tasks" icon={<TasksIcon />} selected={tasksSelected} onOpen={onOpenTasks} />
      </div>
      {/* Padded like the list (pl-2.5, pr-1 plus its gutter), and the row inside like a project row, so
          the title starts on the project pictures' column and the actions end on the rows' right padding. */}
      <div style={{ paddingRight: 4 + gutter }} className={`shrink-0 space-y-2 border-b py-2 pl-2.5 transition-colors ${scrolled ? 'border-white/[0.07]' : 'border-transparent'}`}>
        <div className="flex items-center justify-between pr-1.5 pl-2.5">
          <h3 className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink-300">Projects</h3>
          {/* A 14px glyph centred in a 28px button ends 9px inside it; the buttons overhang by that much,
              keeping their size, so the + itself ends where the badges and counts below end at rest. */}
          <span className="-mr-[9px] flex items-center gap-0.5">
            {partition.visible.length > 0 && (
              <>
                <HeaderButton label="Search (⌘F)" on={searching} expanded={searchOpen} keepFocus onClick={() => (searchOpen && filters.query === '' ? setSearchOpen(false) : openSearch())}>
                  <SearchIcon />
                </HeaderButton>
                <FilterMenu filters={filters} onFilters={onFilters} />
              </>
            )}
            <button
              type="button"
              onClick={(event) =>
                openMenu(event, addItems())
              }
              aria-label="Add project or folder"
              title="Import a project or make a folder"
              aria-haspopup="menu"
              className="flex size-7 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-white/[0.08] hover:text-ink-100"
            >
              <PlusIcon />
            </button>
          </span>
        </div>
        {searchOpen && partition.visible.length > 0 && <SearchField inputRef={searchRef} query={filters.query} onQuery={(query) => onFilters({ ...filters, query })} onClose={() => setSearchOpen(false)} />}
      </div>
      {rowDrag.state !== null && rowDrag.state.source.kind !== 'row' && <DragGhost state={rowDrag.state} />}
      <div
        ref={listRef}
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        onContextMenu={(event) => {
          // Rows open their own menu; a row with none shows nothing rather than the list's.
          if (event.target instanceof Element && event.target.closest('.group') !== null) {
            event.preventDefault()
            return
          }
          openMenu(event, listItems())
        }}
        onKeyDown={openMenuFromKeyboard}
        className={`sidebar-scroll min-h-0 flex-1 space-y-4 overflow-y-scroll pt-1 pr-1 pb-6 pl-2.5 ${scrolled ? 'sidebar-fade' : ''}`}>
        {actionError !== null && (
          <div className="px-1">
            <ErrorNote error={actionError} />
          </div>
        )}
        {((!loaded && loadError === null && projects.length === 0) || !ready) && <SidebarSkeleton />}
        <SpanningSplits onMenu={openMenu} drag={itemRows} end={(items) => <MoreButton label="Manage split" onClick={(event) => openMenu(event, items)} />} />
        {(layoutError ?? savedStateError) !== null && (
          <div className="px-1">
            <ErrorNote error={layoutError ?? savedStateError} />
          </div>
        )}
        {!loaded && loadError !== null && (
          <div className="space-y-2 px-1">
            <ErrorNote error={loadError} />
            <button type="button" onClick={onRetryLoad} className="rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Retry
            </button>
          </div>
        )}
        {ready && sidebarEntries(layout, shownByPath, filtered).map((entry) =>
          entry.kind === 'project' ? (
            renderProject(entry.project)
          ) : (
            <FolderSection
              key={entry.key}
              folder={entry.folder}
              count={entry.projects.length}
              renaming={renamingFolder === entry.key}
              onStartRename={() => setRenamingFolder(entry.key)}
              onRename={(name) => renameTo(entry.key, name)}
              onToggle={() => applyLayout(toggleFolder(layout, entry.key))}
              drag={drag}
              dragging={dragState?.key === entry.key}
              edge={edgeOf(entry.key)}
              menuItems={folderItems(entry.folder)}
              onMenu={openMenu}
            >
              {entry.projects.map(renderProject)}
            </FolderSection>
          ),
        )}
        {filtered && visible.length === 0 && partition.visible.length > 0 && (
          <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
            <p className="text-[13.5px] text-ink-300">Nothing matches {activeFilterLabels(filters).join(' + ')}.</p>
            <button
              type="button"
              onClick={() => {
                onFilters(emptyFilters)
                setSearchOpen(false)
              }}
              className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Clear filters
            </button>
          </div>
        )}
        {projects.length === 0 && loaded && (
          <div className="mx-1 rounded-[18px] border border-dashed border-white/[0.12] px-4 py-5 text-center">
            <p className="text-[13.5px] text-ink-300">No projects yet.</p>
            <button type="button" onClick={onImport} className="mt-2 rounded-full bg-white/[0.08] px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-100 hover:bg-white/[0.14]">
              Import a project
            </button>
          </div>
        )}
        <HiddenSection hidden={partition} onShow={(target) => setHidden(target, false)} />
      </div>
      <ContextMenu menu={menu} onClose={closeMenu} />
      <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      <Toast toast={toast} onClose={closeToast} />
      <NewWorktreeDialog
        request={newWorktreeFor}
        taken={creations.filter((item) => item.repo === newWorktreeFor?.project.path && item.status !== 'failed').map((item) => item.branch)}
        onCreate={(project, branch, base) => {
          setNewWorktreeFor(null)
          // The pending row shows under the project, so a folded project opens.
          if (collapsed.has(project.path)) toggle(project.path)
          onCreateWorktree(project, branch, base)
        }}
        onClose={() => setNewWorktreeFor(null)}
      />
    </nav>
  )
})
