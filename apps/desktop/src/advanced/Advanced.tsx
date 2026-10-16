import { lazy, Suspense, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { api } from '@/api'
import { sessionsOfOrigin } from '@/api/projects-origin'
import type { Dispatch, HistorySession, NativeChat, Project, ProjectSession } from '@/api/schema'
import { joinLabel } from '@/advanced/item-menus'
import { groupChats, worktreeRepositories } from '@/advanced/model'
import { arrivedCreations, creationFailed, creationSucceeded, dismissCreation, retryCreation, startCreation, stacksOn, type PendingWorktree } from '@/advanced/new-worktree-model'
import { neighbourSession, sidebarSessionOrder } from '@/advanced/projects-model'
import { Sidebar, readFilters, writeFilters, type SidebarDrag } from '@/advanced/Sidebar'
import { filterProjects, partitionHidden, type SidebarFilters } from '@/advanced/sidebar-model'
import { applyOrder } from '@/advanced/project-order'
import { flattenLayout, reconcileLayout } from '@/advanced/sidebar-folders'
import { useSidebarLayout } from '@/advanced/useSidebarLayout'
import { CollapsedChrome, SidebarHeader, windowRowInset } from '@/advanced/chrome'
import { ChatView } from '@/chat/ChatView'
import { SidebarUsage } from '@/chat/ComposerStatus'
import { chooseView, initialView, worktreeFacts, type PaneView } from '@/chat/action-bar-model'
import { PaneViewContext, type PaneViewControls } from '@/chat/pane-view-context'
import type { OpenChat, OpenPath } from '@/chat/Conversation'
import { DispatchesContext } from '@/chat/NoticeCard'
import { SessionView } from '@/chat/SessionView'
import type { CodeGoto } from '@/code/CodeFrame'
import { CodePane } from '@/code/CodePane'
import { CodeSlot } from '@/code/CodeSlot'
import { codeTargetForRoot, expiredServers, frameHolders, idleServers, serverGraceMs, type CodeShown, type CodeTarget } from '@/code/code-pane-model'
import { createCodeSlots } from '@/code/code-slots'
import type { GithubKind } from '@/github/useGithubCounts'
import { githubItemId, parseGithubItemId } from '@/github/review-model'
import { ImportProject } from '@/import/ImportProject'
import { PaneSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { ResizeHandle, usePanelWidth } from '@/components/ResizeHandle'
import { SlidePanel } from '@/components/SlidePanel'
import { runPanelLimits, sidebarLimits } from '@/lib/panel-width'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { appLaunched, closable } from '@/chat/session-ownership'
import { RunContext, type RunControls } from '@/run-panel/run-context'
import { panelFor } from '@/run-panel/run-model'
import { RunPanel } from '@/run-panel/RunPanel'
import { useRunPanels } from '@/run-panel/useRunPanels'
import { initialLoad, settleLoad, type LatestLoad } from '@/lib/latest-load'
import { projectsPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { announceAction } from '@/lib/app-events'
import { usePoll } from '@/lib/usePoll'
import { useStableCallback } from '@/lib/useStableCallback'
import { useStatus } from '@/lib/useStatus'
import { chatsByWorktree, rowStatus } from '@/native-chat/chat-model'
import { NativeChatView } from '@/native-chat/NativeChatView'
import { Launcher, newTerminalId } from '@/launcher/Launcher'
import { forgetTerminal, LaunchedTerminal } from '@/launcher/LaunchedTerminal'
import { addTerminal, closeCall, closeNeedsConfirm, keepsPane, mountsInBackground, removeTerminal, renameTerminal, restoreAppTerminals, terminalExited, terminalSessionIds, terminalFailed, terminalLabel, terminalRetried, terminalRuns, terminalStarted, terminalsByWorktree, type AppTerminal, type TerminalLaunch } from '@/terminal/terminal-list'
import { closePane, dropItem, itemKey, paneList, paneOfItem, paneRects, parseItem, replaceItem, singlePane, spanItem, type Direction, type ItemKind, type Panes } from '@/panes/pane-model'
import { activeGroup, addToGroup, arrangeGroup, arrangeMember, changeGroupPanes, changeGroupStrip, changeShown, closeGroup, focusGroup, groupOfItem, joinItems, layoutOf, leaveGroup, openLayoutItem, parseLayout, presetsFor, pruneLayout, removeLayoutItem, renameGroup, serialiseLayout, shiftMember, shownPanes, splitBeside, splitItems, unsplitGroup, type Layout, type Preset } from '@/panes/split-groups'
import { matchShortcut, type ShortcutId } from '@/lib/shortcuts'
import { recordingShortcut, useShortcutBindings } from '@/lib/shortcut-store'
import { groupRows, groupsByPlace, type GroupRow, type MemberInfo } from '@/advanced/split-rows'
import { SplitRowsContext, type SplitDrop, type SplitRowsValue } from '@/advanced/SplitRows'
import type { JoinTarget } from '@/advanced/useRowDrag'
import type { MenuItem } from '@/components/ContextMenu'
import type { MenuIcon } from '@/components/menu-icons'
import { arrangePane } from '@/panes/arrange'
import { PaneArea, type PaneContent } from '@/panes/PaneArea'
import { SplitFrame } from '@/panes/GroupBar'
import { groupIdentity, sharedWorktree, splitCodeItem, splitCodeShown, type SplitMember } from '@/panes/group-bar'
import { emptyStrip, navigate, type Strip } from '@/panes/strip'
import { windowRowJoin } from '@/panes/window-row'
import { usePaneDrag } from '@/panes/usePaneDrag'
import { alreadyOpen } from '@/launcher/resume-model'

// Code, the GitHub pages and settings load the first time they open,
// so starting the app parses only the sidebar and chats.
const CodeLayer = lazy(() => import('@/code/CodeLayer').then((module) => ({ default: module.CodeLayer })))
const GithubPage = lazy(() => import('@/github/GithubPage').then((module) => ({ default: module.GithubPage })))
const GithubItemView = lazy(() => import('@/github/GithubItem').then((module) => ({ default: module.GithubItemView })))
const SettingsWindow = lazy(() => import('@/settings/SettingsWindow').then((module) => ({ default: module.SettingsWindow })))

function Loading() {
  return <PaneSkeleton />
}

function useProjects(): { projects: Project[]; chats: NativeChat[]; loaded: boolean; error: unknown; retry: () => void; dropChat: (id: string) => void } {
  const [load, setLoad] = useState<LatestLoad<Project[]>>(initialLoad)
  const [chats, setChats] = useState<NativeChat[]>([])
  const seq = useRef(0)
  const retry = usePoll(
    projectsPolicy,
    async (current) => {
      const at = ++seq.current
      try {
        // Native chats ride the projects poll; a CLI without them leaves the list empty.
        const [next, nextChats] = await Promise.all([api.projects('megabrain'), api.chats().catch(() => null)])
        if (!current()) return
        // Only sessions megabrain started; one opened in Orca or a plain terminal belongs there.
        const mine = sessionsOfOrigin(next, 'megabrain')
        setLoad((previous) => settleLoad(previous, { seq: at, ok: true, value: reuse(previous.value ?? [], mine) }))
        if (nextChats !== null) setChats((previous) => reuse(previous, nextChats))
      } catch (error) {
        // The last good list stays; usePoll tries again sooner.
        if (current()) setLoad((previous) => settleLoad(previous, { seq: at, ok: false, error }))
        throw error
      }
    },
    [],
  )
  // A removed chat leaves the list at once instead of at the next poll.
  const dropChat = useStableCallback((id: string) => setChats((previous) => previous.filter((chat) => chat.id !== id)))
  return { projects: load.value ?? noProjects, chats, loaded: load.value !== null, error: load.error, retry, dropChat }
}

const noProjects: Project[] = []

const panesKey = 'megabrain.panes'

const newPaneId = () => `pane-${crypto.randomUUID()}`
const newGroupId = () => `group-${crypto.randomUUID()}`
const newLauncher = () => itemKey('launcher', crypto.randomUUID())

/** The layout and split groups this viewer left, or one pane with the launcher. Items that are gone are dropped once the lists load. */
function storedLayout(): Layout {
  try {
    const stored = parseLayout(localStorage.getItem(panesKey), newGroupId())
    if (stored !== null) return stored
  } catch {
    // A remembered layout is a convenience; one pane is fine.
  }
  return layoutOf(singlePane(newLauncher(), newPaneId()), newGroupId())
}

const terminalIdsKey = 'megabrain.terminals.ids'

/** The item id each restorable tmux terminal had, so a restored layout finds it after a restart. */
function storedTerminalIds(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(terminalIdsKey) ?? '{}') as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem('megabrain.sidebar.hidden') === '1'
  } catch {
    return false
  }
}

/**
 * The keyboard into a pane's terminal, composer or first field, on the next frame. Without scrolling:
 * the strip reveals the focused pane itself, and the browser's own scroll would yank it mid-scroll.
 */
function focusPaneInput(paneId: string) {
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(paneId)}"]`)?.querySelector<HTMLElement>('textarea, [contenteditable="true"], input')?.focus({ preventScroll: true }))
}

// The advanced window: chats in a sidebar (projects > worktrees > chats), the selected chat followed
// live, and each project's code.
export function Advanced({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  const { projects: listed, chats: nativeChats, loaded: projectsLoaded, error: projectsError, retry: retryProjects, dropChat } = useProjects()
  const { layout: savedLayout, change: changeLayout, error: layoutError, ready: layoutReady } = useSidebarLayout()
  // The folders and order the person dragged the projects into; ⌘[ and ⌘] walk them the same way.
  const layout = useMemo(() => reconcileLayout(savedLayout, listed.map((project) => project.path)), [savedLayout, listed])
  const projects = useMemo(() => applyOrder(listed, flattenLayout(layout)), [listed, layout])
  // Chats are grouped by the repository of their worktree; the projects list already names it.
  const worktrees = useMemo(() => worktreeRepositories(listed), [listed])
  // The split groups and the single pane; the main area shows one of them, each pane one item, and
  // the sidebar follows the focused one.
  const [paneLayout, setLayout] = useState<Layout>(storedLayout)
  const panes = shownPanes(paneLayout)
  /** A pane operation on what is shown; it may make a split group or dissolve one (see changeShown). */
  const setPanes = (change: (current: Panes) => Panes) => setLayout((current) => changeShown(current, change, newGroupId()))
  const [pruned, setPruned] = useState(false)
  // The view each item's pane shows (see the action bar); an item not listed shows its initialView.
  const [paneViews, setPaneViews] = useState<Record<string, PaneView>>({})
  // The view each split on one worktree shows from its shared bar, by group (see panes/group-bar).
  const [splitViews, setSplitViews] = useState<Record<string, PaneView>>({})
  // A project's pull request or issue page, shown in the main area over chats and the launcher.
  const [githubPage, setGithubPage] = useState<{ path: string; kind: GithubKind; focus: number | null } | null>(null)
  // The roots whose Code runs, in opening order: one frame each, kept mounted until its server stops.
  const [codeTargets, setCodeTargets] = useState<CodeTarget[]>([])
  // When each running root stopped being used by any pane (see idleServers).
  const [idleCode, setIdleCode] = useState<Readonly<Record<string, number>>>({})
  const codeHolders = useRef<Readonly<Record<string, string>>>({})
  const [codeSlots] = useState(createCodeSlots)
  // The file each open root was last asked to show from a chat.
  const [gotos, setGotos] = useState<Record<string, CodeGoto>>({})
  const [importing, setImporting] = useState(false)
  // Each launcher's worktree: the one whose + opened it (absent: ⌘N, home or a restored layout), and
  // the one it starts in now, where its top bar runs commands. A new + is a new launcher item.
  const [launcherClicked, setLauncherClicked] = useState<Record<string, string>>({})
  const [launcherRoots, setLauncherRoots] = useState<Record<string, string | null>>({})
  // Sessions opened from a link that no project lists, by session id.
  const [extraSessions, setExtraSessions] = useState<Record<string, { session: ProjectSession; worktreePath: string }>>({})
  // A chat just started shows before the next poll lists it.
  const [startedChat, setStartedChat] = useState<NativeChat | null>(null)
  // Closing a running chat, a live terminal or an owned session asks first.
  const [closeConfirm, setCloseConfirm] = useState<PendingConfirm | null>(null)
  // Worktrees being created from a project's +, shown pending in the sidebar until megabrain lists them.
  const [creations, setCreations] = useState<PendingWorktree[]>([])
  // Every terminal the app opened in this run, plus the tmux ones a past run left running.
  const [terminals, setTerminals] = useState<AppTerminal[]>([])
  const [terminalsRestored, setTerminalsRestored] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The project whose commands Settings opens on, from Edit commands or Set up in a chat's run menu.
  const [settingsProject, setSettingsProject] = useState<string | null>(null)
  const [filters, setFilters] = useState<SidebarFilters>(readFilters)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(storedSidebarCollapsed)
  const sidebarWidth = usePanelWidth('megabrain.sidebar.width', sidebarLimits)
  const runPanelWidth = usePanelWidth('megabrain.runPanel.width', runPanelLimits)
  const runs = useRunPanels()
  const grouped = useMemo(() => groupChats(status?.dispatches ?? [], worktrees), [status, worktrees])
  // ⌘[ and ⌘] walk the sessions the sidebar shows: hidden and filtered-out ones are skipped.
  const worktreePaths = useMemo(() => listed.flatMap((project) => project.worktrees.map((worktree) => worktree.path)), [listed])
  const chatsInWorktrees = useMemo(() => chatsByWorktree(nativeChats, worktreePaths), [nativeChats, worktreePaths])
  const terminalsInWorktrees = useMemo(() => terminalsByWorktree(terminals, worktreePaths), [terminals, worktreePaths])
  const sessionRows = useMemo(() => sidebarSessionOrder(filterProjects(partitionHidden(projects).visible, filters), new Set()), [projects, filters])

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((current) => {
      const next = !current
      try {
        localStorage.setItem('megabrain.sidebar.hidden', next ? '1' : '0')
      } catch {
        // A remembered collapse state is a convenience; starting expanded is fine.
      }
      return next
    })
  }

  const findSession = (sessionId: string) => {
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const session = worktree.sessions.find((item) => item.sessionId === sessionId)
        if (session !== undefined) return { session, worktreePath: worktree.path }
      }
    }
    return extraSessions[sessionId] ?? null
  }

  /** A chat megabrain dispatched opens as that dispatch; any other session as itself. */
  const sessionItem = (session: ProjectSession) => {
    const dispatchId = session.dispatchId
    const known = dispatchId !== null && (status?.dispatches.some((item) => item.dispatchId === dispatchId) ?? false)
    return known && dispatchId !== null ? itemKey('dispatch', dispatchId) : itemKey('session', session.sessionId)
  }

  /** Shows an item: the pane that has it gets focus, else the focused pane shows it. */
  const showItem = (item: string) => {
    setGithubPage(null)
    setLayout((current) => openLayoutItem(current, item))
  }

  const openSession = (session: ProjectSession, worktreePath: string) => {
    if (findSession(session.sessionId) === null) setExtraSessions((current) => ({ ...current, [session.sessionId]: { session, worktreePath } }))
    showItem(sessionItem(session))
  }

  const openRelatedChat: OpenChat = useStableCallback((target) => {
    setGithubPage(null)
    if ('dispatchId' in target) {
      const dispatch = status?.dispatches.find((item) => item.dispatchId === target.dispatchId)
      if (dispatch !== undefined) {
        showItem(itemKey('dispatch', dispatch.dispatchId))
        return
      }
      const session = projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.sessions.map((item) => ({ session: item, worktreePath: worktree.path })))
        .find((item) => item.session.dispatchId === target.dispatchId)
      if (session !== undefined) {
        openSession(session.session, session.worktreePath)
      }
      return
    }

    const found = findSession(target.sessionId)
    if (found !== null) {
      openSession(found.session, found.worktreePath)
      return
    }

    const [agent] = target.sessionId.split(':', 1)
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'grok' && agent !== 'agy') return
    openSession({
      agent,
      sessionId: target.sessionId,
      title: target.sessionId,
      status: 'idle',
      startedAt: null,
      lastActivityAt: null,
      dispatchId: null,
    }, '')
  })

  // The sidebar follows the focused pane. A chat opened as a dispatch is still a session row there;
  // highlight and walk from it.
  const focusedItem = paneList(panes.root).find((leaf) => leaf.id === panes.focused)?.item ?? null
  const focusedParsed = focusedItem === null ? null : parseItem(focusedItem)
  const selectedSessionId =
    focusedParsed === null
      ? null
      : focusedParsed.kind === 'session'
        ? focusedParsed.id
        : focusedParsed.kind === 'dispatch'
          ? (sessionRows.find((row) => row.session.dispatchId === focusedParsed.id)?.session.sessionId ?? null)
          : null
  const nativeChatId = focusedParsed?.kind === 'native' ? focusedParsed.id : null
  const focusedTerminalId = focusedParsed?.kind === 'terminal' ? focusedParsed.id : null

  const viewOf = (item: string): PaneView => {
    const kind = parseItem(item)?.kind
    return paneViews[item] ?? (kind === undefined ? 'agent' : initialView(kind))
  }

  const focusItem = (item: string) =>
    setPanes((current) => {
      const pane = paneOfItem(current, item)
      return pane === null || pane.id === current.focused ? current : { ...current, focused: pane.id }
    })

  // A worktree's Code shows in a pane: the focused pane when it works there, else another pane
  // that does, else a code item of its own in the focused pane.
  const showCode = (root: string) => {
    setGithubPage(null)
    // A split on that worktree shows Code over the whole split, from its shared bar.
    if (sharedRoot === root && shownGroupId !== null) {
      setSplitViews((current) => ({ ...current, [shownGroupId]: 'code' }))
      return
    }
    const leaves = paneList(panes.root).filter((leaf) => hasActionBar(leaf.item) && rootOf(leaf.item) === root)
    const leaf = leaves.find((candidate) => candidate.id === panes.focused) ?? leaves[0]
    const item = leaf?.item ?? itemKey('code', root)
    if (leaf === undefined) setLayout((current) => openLayoutItem(current, item))
    else focusItem(item)
    setPaneViews((current) => ({ ...current, [item]: 'code' }))
  }

  const openPath: OpenPath = useStableCallback((root, path, line) => {
    setGotos((current) => ({ ...current, [root]: { path, line } }))
    showCode(root)
  })

  /** A view picked on an item's action bar; Agent on a code item puts the worktree's launcher in its pane. */
  const chooseItemView = (item: string, view: PaneView) => {
    const kind = parseItem(item)?.kind
    if (kind === undefined) return
    const action = chooseView(kind, view)
    if (action.kind === 'view') {
      setPaneViews((current) => ({ ...current, [item]: action.view }))
      return
    }
    const launcher = newLauncher()
    const root = rootOf(item)
    if (root !== null) setLauncherClicked((current) => ({ ...current, [launcher]: root }))
    setLayout((current) => {
      const pane = paneOfItem(shownPanes(current), item)
      return pane === null ? openLayoutItem(current, launcher) : changeShown(current, (shown) => replaceItem(shown, pane.id, launcher), newGroupId())
    })
  }

  // The sidebar is memoised; these keep their identity so a status poll does not re-render it.
  const selectSidebarSession = useStableCallback((session: ProjectSession) => {
    const worktree = projects.flatMap((project) => project.worktrees).find((candidate) => candidate.sessions.some((item) => item.sessionId === session.sessionId))
    openSession(session, worktree?.path ?? '')
  })
  const stableShowCode = useStableCallback((target: CodeTarget) => showCode(target.root))
  const startImport = useStableCallback(() => setImporting(true))
  const stableLayout = useStableCallback(changeLayout)
  const changeFilters = useStableCallback((next: SidebarFilters) => {
    setFilters(next)
    writeFilters(next)
  })
  const selectNativeChat = useStableCallback((chat: NativeChat) => showItem(itemKey('native', chat.id)))
  const openNewChat = useStableCallback((path: string | null) => {
    const launcher = newLauncher()
    if (path !== null) setLauncherClicked((current) => ({ ...current, [launcher]: path }))
    showItem(launcher)
  })
  /** What a launcher started takes the launcher's own pane, whichever pane is focused. */
  const replaceLauncher = (launcher: string | null, item: string) => {
    setGithubPage(null)
    setLayout((current) => {
      const pane = launcher === null ? null : paneOfItem(shownPanes(current), launcher)
      return pane === null ? openLayoutItem(current, item) : changeShown(current, (shown) => replaceItem(shown, pane.id, item), newGroupId())
    })
  }
  const chatStarted = (launcher: string, chat: NativeChat) => {
    setStartedChat(chat)
    announceAction()
    replaceLauncher(launcher, itemKey('native', chat.id))
  }
  const showTerminal = (launched: TerminalLaunch, launcher: string | null) => {
    setTerminals((current) => addTerminal(current, launched))
    replaceLauncher(launcher, itemKey('terminal', launched.id))
  }
  // A plain terminal in the worktree: the login shell, on the engine chosen in settings. Its pane
  // opens at once and shows it starting; asking again while one still starts there shows that one.
  const openTerminal = (cwd: string, launcher: string | null) => {
    const starting = terminals.find((item) => item.cwd === cwd && item.status === 'starting')
    if (starting !== undefined) replaceLauncher(launcher, itemKey('terminal', starting.id))
    else showTerminal({ kind: 'terminal', engine: null, cwd, firstInput: null, id: newTerminalId(), title: 'Terminal' }, launcher)
  }
  const openWorktreeTerminal = useStableCallback((cwd: string) => openTerminal(cwd, null))
  const runCreation = (creation: Pick<PendingWorktree, 'id' | 'repo' | 'branch' | 'base' | 'stacked'>) =>
    api.createWorktree(creation.repo, creation.branch, creation.base, creation.stacked).then(
      (created) => setCreations((current) => creationSucceeded(current, creation.id, created.path)),
      (caught: unknown) => setCreations((current) => creationFailed(current, creation.id, caught)),
    )
  const createWorktree = useStableCallback((project: Project, branch: string, base: string) => {
    // A base that another worktree has checked out records it as the parent, so the stack is found.
    const creation = { id: crypto.randomUUID(), repo: project.path, branch, base, stacked: stacksOn(project, base) }
    const next = startCreation(creations, creation)
    if (next === null) return
    setCreations(next)
    void runCreation(creation)
  })
  const retryWorktree = useStableCallback((id: string) => {
    const creation = creations.find((item) => item.id === id)
    if (creation === undefined || creation.status !== 'failed') return
    setCreations((current) => retryCreation(current, id))
    void runCreation(creation)
  })
  const dismissWorktree = useStableCallback((id: string) => setCreations((current) => dismissCreation(current, id)))
  // A created worktree that the list now shows becomes real: its pending row goes and its launcher opens.
  useEffect(() => {
    const { arrived, rest } = arrivedCreations(creations, listed)
    if (arrived.length === 0) return
    setCreations(rest)
    for (const creation of arrived) if (creation.path !== null) openNewChat(creation.path)
  }, [listed, creations])
  const selectTerminal = useStableCallback((terminal: AppTerminal) => showItem(itemKey('terminal', terminal.id)))
  const stableRenameTerminal = useStableCallback((terminal: AppTerminal, name: string) => setTerminals((current) => renameTerminal(current, terminal.id, name)))
  const closeTerminal = useStableCallback(async (terminal: AppTerminal) => {
    const call = closeCall(terminal)
    if (call !== null) await api.closeTerminal(call.id, call.kill ? { kill: true } : undefined)
    forgetTerminal(terminal.id)
    setTerminals((current) => removeTerminal(current, terminal.id))
    setLayout((current) => removeLayoutItem(current, itemKey('terminal', terminal.id), { id: newPaneId(), item: newLauncher() }))
  })
  const closeChat = async (chat: NativeChat) => {
    await api.removeChat(chat.id)
    dropChat(chat.id)
    if (startedChat?.id === chat.id) setStartedChat(null)
    setLayout((current) => removeLayoutItem(current, itemKey('native', chat.id), { id: newPaneId(), item: newLauncher() }))
  }
  // A row's close (its x, its menu or ⌘W on its pane): what still runs is asked about first. A close
  // that needs no question runs at once, and its refusal is the caller's to show.
  const requestClose = useStableCallback(async (row: SidebarDrag): Promise<void> => {
    if (row.kind === 'native') {
      const { chat } = row
      const title = chat.title ?? 'New chat'
      if (chat.state !== 'working' && chat.state !== 'waiting-approval') return closeChat(chat)
      setCloseConfirm({
        title: `Close ${title}?`,
        body: "A turn is running. Closing stops the agent and removes the chat from megabrain. The agent's own session stays, so Resume can still open it.",
        action: 'Close chat',
        run: () => closeChat(chat),
      })
      return
    }
    if (row.kind === 'terminal') {
      const { terminal } = row
      if (!closeNeedsConfirm(terminal)) return closeTerminal(terminal)
      setCloseConfirm({
        title: `Close ${terminalLabel(terminal)}?`,
        body:
          terminal.engine === 'tmux'
            ? "The app lets go of this terminal. Its tmux session keeps running on megabrain's tmux server, but the app does not list it again."
            : 'Its process may still be running. Closing the terminal ends it.',
        action: 'Close terminal',
        run: () => closeTerminal(terminal),
      })
      return
    }
    const { session } = row
    if (!closable(session)) return
    if (appLaunched(session)) {
      setCloseConfirm({
        title: `End ${session.title}?`,
        body: 'The app started this agent in a terminal it no longer shows. Ending it stops the agent; the conversation stays on disk and can be resumed again.',
        action: 'End session',
        run: () => api.releaseSession(session.sessionId),
      })
      return
    }
    setCloseConfirm({
      title: `Release ${session.title}?`,
      body: 'megabrain stops owning this session and closes its tmux session, which ends the agent running there. The conversation stays on disk and can be resumed again.',
      action: 'Release',
      run: () => api.releaseSession(session.sessionId),
    })
  })
  // A past chat megabrain already shows opens there; any other is resumed in its agent's TUI.
  const resumeChat = (launcher: string, session: HistorySession, launched: TerminalLaunch) => {
    const open = alreadyOpen(session, listed, nativeChats)
    if (open === null) showTerminal(launched, launcher)
    else if (open.kind === 'native') replaceLauncher(launcher, itemKey('native', open.chat.id))
    else {
      if (findSession(open.session.sessionId) === null) setExtraSessions((current) => ({ ...current, [open.session.sessionId]: { session: open.session, worktreePath: open.worktreePath } }))
      replaceLauncher(launcher, sessionItem(open.session))
    }
  }
  const closePaneById = (paneId: string) => setPanes((current) => closePane(current, paneId))
  // ⌘W closes what the focused pane shows, as its row's close would; anything else closes the pane.
  const closeFocused = useStableCallback((): Promise<void> => {
    if (focusedParsed?.kind === 'native') {
      const chat = nativeChats.find((entry) => entry.id === focusedParsed.id) ?? (startedChat?.id === focusedParsed.id ? startedChat : null)
      if (chat !== null) return requestClose({ kind: 'native', chat })
    }
    if (focusedParsed?.kind === 'terminal') {
      const terminal = terminals.find((entry) => entry.id === focusedParsed.id)
      if (terminal !== undefined) return requestClose({ kind: 'terminal', terminal })
    }
    if (focusedParsed?.kind === 'session') {
      const found = findSession(focusedParsed.id)
      if (found !== null && closable(found.session)) return requestClose({ kind: 'session', session: found.session })
    }
    closePaneById(panes.focused)
    return Promise.resolve()
  })
  // Split groups in the sidebar: each member described for its group's row (see split-rows.ts).
  const worktreeOfItem = (item: string): string | null => {
    const parsed = parseItem(item)
    if (parsed === null) return null
    const keyOf = <T,>(lists: Record<string, T[]>, has: (entry: T) => boolean) => Object.entries(lists).find(([, list]) => list.some(has))?.[0] ?? null
    switch (parsed.kind) {
      case 'native':
        return keyOf(chatsInWorktrees, (chat) => chat.id === parsed.id)
      case 'terminal':
        return keyOf(terminalsInWorktrees, (terminal) => terminal.id === parsed.id)
      default: {
        const root = rootOf(item)
        return root === null || root === '' ? null : root
      }
    }
  }
  const describeItem = (item: string): MemberInfo => {
    const parsed = parseItem(item)
    const worktree = worktreeOfItem(item)
    if (parsed === null) return { title: 'Unknown', mark: { kind: 'launcher' }, state: 'ended', worktree }
    switch (parsed.kind) {
      case 'dispatch': {
        const chat = status?.dispatches.find((entry) => entry.dispatchId === parsed.id)
        const session = sessionRows.find((row) => row.session.dispatchId === parsed.id)?.session
        return { title: chat?.label ?? session?.title ?? parsed.id, mark: { kind: 'agent', agent: chat?.agent ?? session?.agent ?? 'claude' }, state: session?.status ?? 'idle', worktree }
      }
      case 'session': {
        const session = findSession(parsed.id)?.session
        return { title: session?.title ?? 'Session', mark: { kind: 'agent', agent: session?.agent ?? parsed.id.split(':', 1)[0] ?? 'claude' }, state: session?.status ?? 'ended', worktree }
      }
      case 'native': {
        const chat = nativeChats.find((entry) => entry.id === parsed.id) ?? (startedChat?.id === parsed.id ? startedChat : null)
        return { title: chat?.title ?? 'New chat', mark: { kind: 'agent', agent: chat?.agent ?? 'claude' }, state: chat === null ? 'ended' : rowStatus(chat.state), worktree }
      }
      case 'terminal': {
        const terminal = terminals.find((entry) => entry.id === parsed.id)
        const state = terminal === undefined ? 'ended' : terminal.status === 'starting' ? 'working' : terminal.status === 'live' ? 'idle' : 'ended'
        return { title: terminal === undefined ? 'Terminal' : terminalLabel(terminal), mark: { kind: 'terminal' }, state, worktree }
      }
      // A launcher's worktree is only its current pick, so it does not decide where its group sits.
      case 'launcher':
        return { title: 'New chat', mark: { kind: 'launcher' }, state: 'idle', worktree: null }
      case 'github': {
        const target = parseGithubItemId(parsed.id)
        return { title: target === null ? 'GitHub' : `${target.kind === 'pr' ? 'Pull request' : 'Issue'} #${target.number}`, mark: { kind: 'github' }, state: 'idle', worktree }
      }
      case 'code':
        return { title: codeTargetForRoot(projects, parsed.id).title, mark: { kind: 'code' }, state: 'idle', worktree }
    }
  }
  // A split never runs out of room: its columns scroll (panes/strip), so no layout is refused for size.
  const arrange = (row: GroupRow, preset: Preset) => setLayout((current) => focusGroup(arrangeGroup(current, row.id, preset), row.id))
  // The shown group's column widths and scroll, kept with the group; the group is bound now, so a
  // scroll saved after another group shows still lands on its own.
  const shownGroupId = paneLayout.active
  const changeStrip = useMemo(() => (shownGroupId === null ? null : (change: (strip: Strip) => Strip) => setLayout((current) => changeGroupStrip(current, shownGroupId, change))), [shownGroupId])
  const [stripScrolls, setStripScrolls] = useState(false)
  const focusSplit = useStableCallback((groupId: string) => {
    setGithubPage(null)
    setLayout((current) => focusGroup(current, groupId))
  })
  const focusSplitMember = useStableCallback((groupId: string, item: string) => {
    setGithubPage(null)
    setLayout((current) => focusGroup(current, groupId, item))
  })
  const renameSplit = useStableCallback((groupId: string, name: string) => setLayout((current) => renameGroup(current, groupId, name)))
  const splitGroupMenu = useStableCallback((row: GroupRow, startRename: () => void): MenuItem[] => [
    ...presetsFor(row.members.length).map((preset): MenuItem => ({ label: presetNames[preset], icon: presetIcons[preset], group: 'open', onSelect: () => arrange(row, preset) })),
    { label: 'Rename group', icon: 'rename', group: 'organise', onSelect: startRename },
    { label: 'Unsplit', icon: 'unsplit', group: 'organise', onSelect: () => setLayout((current) => unsplitGroup(current, row.id)) },
    { label: 'Close group', icon: 'close', group: 'danger', onSelect: () => setLayout((current) => closeGroup(current, row.id, { id: newPaneId(), item: newLauncher() })) },
  ])
  const splitItemOf = useStableCallback((row: SidebarDrag): string | null => {
    if (row.kind === 'native') return itemKey('native', row.chat.id)
    if (row.kind === 'terminal') return itemKey('terminal', row.terminal.id)
    return sessionItem(row.session)
  })
  // Split right or down from a row: the row's item opens beside the focused pane (a launcher when it
  // is the focused pane's own item). ⌘D and ⌘⇧D do the same with a launcher.
  const splitWith = (item: string | null, edge: 'right' | 'bottom') => {
    const launcher = newLauncher()
    const next = splitBeside(paneLayout, item ?? launcher, edge, launcher, { pane: newPaneId(), group: newGroupId() })
    if (next === null) return
    setGithubPage(null)
    setLayout(next)
    const focused = shownPanes(next).focused
    focusPaneInput(focused)
  }
  // Rows picked with ⌘-click open together as one split, as Zen joins multi-selected tabs.
  const [picks, setPicks] = useState<string[]>([])
  const openInSplit = (items: string[]) => {
    const unique = [...new Set(items)]
    const ids = unique.map(() => newPaneId())
    const preset: Preset = unique.length === 2 ? 'row' : 'grid'
    setGithubPage(null)
    setPicks([])
    setLayout((current) => splitItems(current, unique, newGroupId(), ids, preset))
  }
  const splitRowMenu = useStableCallback((item: string): MenuItem[] => {
    const together = [...new Set([...picks, item])]
    return [
      ...(picks.length > 0 && together.length >= 2 ? [{ label: `Open ${together.length} in split`, icon: 'splitGrid', group: 'open', onSelect: () => openInSplit(together) } satisfies MenuItem] : []),
      { label: 'Split right', icon: 'splitRight', group: 'open', onSelect: () => splitWith(item, 'right') },
      { label: 'Split down', icon: 'splitDown', group: 'open', onSelect: () => splitWith(item, 'bottom') },
      ...joinChoices(item),
    ]
  })
  const joinItem = (title: string) => {
    const { label, full } = joinLabel({ name: null, members: [{ title }] })
    return { label, title: full }
  }
  // Join with…, the keyboard's way to drop a row on another: every group the row is not in, and the
  // item shown alone, when it is another one.
  const joinChoices = (item: string): MenuItem[] => {
    const own = groupOfItem(paneLayout, item)?.id ?? null
    const alone = paneLayout.active === null ? (paneList(paneLayout.single.root)[0]?.item ?? null) : null
    const groups = splitRowsValue.filter((row) => row.id !== own)
    return [
      ...groups.map((row): MenuItem => {
        const { label, full } = joinLabel(row)
        return { label, title: full, icon: 'splitGrid', group: 'open', onSelect: () => dropSplit({ kind: 'join', source: { kind: 'item', item }, target: { kind: 'group', groupId: row.id } }) }
      }),
      ...(alone === null || alone === item || groupOfItem(paneLayout, alone) !== null
        ? []
        : [{ ...joinItem(describeItem(alone).title), icon: 'splitRight', group: 'open', onSelect: () => dropSplit({ kind: 'join', source: { kind: 'item', item }, target: { kind: 'item', item: alone } }) } satisfies MenuItem]),
    ]
  }
  /** What a join from the sidebar makes of the layout: a row joins a row or a group, a group takes in a row. */
  const joined = (current: Layout, source: JoinTarget, target: JoinTarget): Layout => {
    if (source.kind === 'item' && target.kind === 'item') return joinItems(current, source.item, target.item, { pane: newPaneId(), group: newGroupId() })
    if (source.kind === 'item' && target.kind === 'group') return addToGroup(current, target.groupId, source.item, newPaneId())
    if (source.kind === 'group' && target.kind === 'item') return addToGroup(current, source.groupId, target.item, newPaneId())
    return current
  }
  // A row dropped on another row's middle joins them; a member dragged out of its group leaves it; a
  // group is arranged and resized on its hover's map (see useRowDrag and SplitRows).
  const dropSplit = useStableCallback((drop: SplitDrop) => {
    if (drop.kind === 'arrange') setLayout((current) => arrangeMember(current, drop.groupId, drop.item, drop.target))
    else if (drop.kind === 'shift') setLayout((current) => shiftMember(current, drop.groupId, drop.item, drop.direction))
    else if (drop.kind === 'resize') setLayout((current) => changeGroupPanes(current, drop.groupId, () => drop.panes))
    else if (drop.kind === 'leave') setLayout((current) => leaveGroup(current, drop.item))
    else {
      const next = joined(paneLayout, drop.source, drop.target)
      if (next === paneLayout) return
      setGithubPage(null)
      setPicks([])
      setLayout(next)
    }
  })
  const pickSplitRow = useStableCallback((item: string, add: boolean) => setPicks((current) => (!add ? [] : current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item])))
  // A sidebar item dropped on a pane splits it or replaces its item; a pane dragged by its header
  // splits beside the pane or swaps with it. Either one dropped on an edge of the split spans that side.
  const drag = usePaneDrag((source, target) => {
    setGithubPage(null)
    const next =
      source.kind === 'pane' ? arrangePane(panes, source.paneId, target) : target.kind === 'side' ? spanItem(panes, source.item, target.side, newPaneId()) : dropItem(panes, source.item, target.paneId, target.zone, newPaneId())
    setPanes(() => next)
  })
  // A row from the sidebar starts a drag of the item it opens.
  const dragRow = useStableCallback((event: PointerEvent<HTMLElement>, row: SidebarDrag) => {
    if (row.kind === 'session') {
      if (findSession(row.session.sessionId) === null) return
      drag.start(event, { kind: 'item', item: sessionItem(row.session), label: row.session.title })
    } else if (row.kind === 'native') drag.start(event, { kind: 'item', item: itemKey('native', row.chat.id), label: row.chat.title ?? 'New chat' })
    else drag.start(event, { kind: 'item', item: itemKey('terminal', row.terminal.id), label: terminalLabel(row.terminal) })
  })
  const openGithub = useStableCallback((project: Project, kind: GithubKind, focus?: number) => {
    setGithubPage({ path: project.path, kind, focus: focus ?? null })
  })
  // A pull request or issue maximised from its page takes the focused pane, like any other item.
  const maximiseGithub = (root: string, kind: 'pr' | 'issue', number: number) => showItem(itemKey('github', githubItemId(kind, number, root)))

  const repositoryOf = (dispatchId: string) =>
    grouped.repositories.find((repository) => repository.worktrees.some((worktree) => worktree.chats.some((item) => item.dispatchId === dispatchId)))?.name ?? null

  const startedLauncherRoot = (launcher: string) => (cwd: string | null) => setLauncherRoots((current) => (current[launcher] === cwd ? current : { ...current, [launcher]: cwd }))

  /** The worktree an item works in: its top bar runs commands there and its run panel shows. */
  const rootOf = (item: string): string | null => {
    const parsed = parseItem(item)
    if (parsed === null) return null
    switch (parsed.kind) {
      case 'dispatch':
        return status?.dispatches.find((entry) => entry.dispatchId === parsed.id)?.worktreePath ?? null
      case 'session': {
        const path = findSession(parsed.id)?.worktreePath ?? ''
        return path === '' ? null : path
      }
      case 'native':
        return (nativeChats.find((entry) => entry.id === parsed.id) ?? (startedChat?.id === parsed.id ? startedChat : null))?.cwd ?? null
      case 'terminal':
        return terminals.find((entry) => entry.id === parsed.id)?.cwd ?? null
      case 'launcher':
        return launcherRoots[item] ?? null
      case 'github':
        return parseGithubItemId(parsed.id)?.root ?? null
      case 'code':
        return parsed.id
    }
  }
  // The shown split's members, and the worktree they all work in when it shares one bar.
  const splitMembers: SplitMember[] = paneList(panes.root).map((leaf) => {
    const mark = describeItem(leaf.item).mark
    return { item: leaf.item, kind: parseItem(leaf.item)?.kind ?? null, worktree: rootOf(leaf.item), agent: mark.kind === 'agent' ? mark.agent : null }
  })
  const sharedRoot = sharedWorktree(splitMembers)

  // The tmux terminals a past run left come back once, at launch; a failed list restores none.
  useEffect(() => {
    let current = true
    api
      .listAppTerminals()
      .then((listings) => {
        if (current) setTerminals((list) => restoreAppTerminals(list, listings, storedTerminalIds()))
      })
      .catch(() => {})
      .finally(() => {
        if (current) setTerminalsRestored(true)
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    if (!terminalsRestored) return
    try {
      localStorage.setItem(terminalIdsKey, JSON.stringify(terminalSessionIds(terminals)))
    } catch {
      // Without the ids a restored terminal still lists; only its place in the layout is lost.
    }
  }, [terminals, terminalsRestored])

  const listsLoaded = status !== null && projectsLoaded && terminalsRestored
  /** Whether an item still exists; a launcher always does. */
  const itemExists = (item: string): boolean => {
    const parsed = parseItem(item)
    if (parsed === null) return false
    switch (parsed.kind) {
      case 'dispatch':
        return status?.dispatches.some((entry) => entry.dispatchId === parsed.id) ?? false
      case 'session':
        return findSession(parsed.id) !== null
      case 'native':
        return nativeChats.some((entry) => entry.id === parsed.id) || startedChat?.id === parsed.id
      case 'terminal':
        return keepsPane(terminals, parsed.id)
      case 'launcher':
        return true
      case 'github':
        return parseGithubItemId(parsed.id) !== null
      case 'code':
        return true
    }
  }

  // Once the lists load, a restored layout drops the items that are gone (a terminal whose tmux
  // session ended with the last run among them); later an item that disappears shows a note in its pane instead.
  useEffect(() => {
    if (pruned || !listsLoaded) return
    setPruned(true)
    setLayout((current) => pruneLayout(current, itemExists, { id: newPaneId(), item: newLauncher() }))
  }, [pruned, listsLoaded])

  useEffect(() => {
    try {
      localStorage.setItem(panesKey, serialiseLayout(paneLayout))
    } catch {
      // A remembered layout is a convenience; the next launch starts with one pane.
    }
  }, [paneLayout])

  const render = (item: string): PaneContent => {
    const parsed = parseItem(item)
    const gone = (title: string): PaneContent => ({ title, node: listsLoaded ? <GoneNote /> : <Loading /> })
    if (parsed === null) return gone('Unknown')
    switch (parsed.kind) {
      case 'dispatch': {
        const chat = status?.dispatches.find((entry) => entry.dispatchId === parsed.id)
        if (chat === undefined) return gone('Chat')
        return { title: chat.label ?? chat.dispatchId, node: <ChatView chat={chat} repository={repositoryOf(chat.dispatchId)} onOpenChat={openRelatedChat} onOpenPath={openPath} /> }
      }
      case 'session': {
        const found = findSession(parsed.id)
        if (found === null) return gone('Session')
        const runner = terminals.find((terminal) => terminalRuns(terminal, found.session))
        return { title: found.session.title, node: <SessionView session={found.session} worktreePath={found.worktreePath} onOpenChat={openRelatedChat} onOpenPath={openPath} onShowTerminal={runner === undefined ? undefined : () => selectTerminal(runner)} /> }
      }
      case 'native': {
        const chat = nativeChats.find((entry) => entry.id === parsed.id) ?? (startedChat?.id === parsed.id ? startedChat : null)
        if (chat === null) return gone('Chat')
        return { title: chat.title ?? 'New chat', node: <NativeChatView chat={chat} onOpenChat={openRelatedChat} onOpenPath={openPath} /> }
      }
      case 'terminal': {
        const terminal = terminals.find((entry) => entry.id === parsed.id)
        if (terminal === undefined) return gone('Terminal')
        return {
          title: terminalLabel(terminal),
          node: (
            <LaunchedTerminal
              terminal={terminal}
              place={worktreeChoices(projects).find((choice) => choice.path === terminal.cwd)?.label ?? null}
              onStarted={(session) => setTerminals((current) => terminalStarted(current, terminal.id, session))}
              onExit={(code) => setTerminals((current) => terminalExited(current, terminal.id, code))}
              onFailed={(caught) => setTerminals((current) => terminalFailed(current, terminal.id, caught))}
              onRetry={() => setTerminals((current) => terminalRetried(current, terminal.id))}
            />
          ),
        }
      }
      case 'launcher':
        return {
          title: 'New chat',
          node: (
            <Launcher
              worktrees={worktreeChoices(projects)}
              clicked={launcherClicked[item] ?? null}
              onChat={(chat) => chatStarted(item, chat)}
              onLaunch={(launched) => showTerminal(launched, item)}
              onTerminal={(cwd) => openTerminal(cwd, item)}
              onResume={(session, launched) => resumeChat(item, session, launched)}
              onWorktree={startedLauncherRoot(item)}
            />
          ),
        }
      case 'github': {
        const target = parseGithubItemId(parsed.id)
        if (target === null) return gone('GitHub')
        return {
          title: `${target.kind === 'pr' ? 'Pull request' : 'Issue'} #${target.number}`,
          node: (
            <Suspense fallback={<Loading />}>
              <GithubItemView root={target.root} kind={target.kind} number={target.number} />
            </Suspense>
          ),
        }
      }
      case 'code': {
        const target = codeTargetForRoot(projects, parsed.id)
        return { title: target.title, node: <CodePane target={target} /> }
      }
    }
  }
  // Every terminal stays mounted, shown or not, so it keeps running and reports its exit; a restored
  // one waits until a pane shows it.
  const shownItems = new Set(paneList(panes.root).map((leaf) => leaf.item))
  const backgroundTerminals = terminals.filter(mountsInBackground).map((terminal) => itemKey('terminal', terminal.id)).filter((item) => !shownItems.has(item))

  const settingsOverlay = settingsOpen && (
    <Suspense fallback={null}>
      <SettingsWindow
        key={settingsProject ?? ''}
        focusProject={settingsProject}
        onClose={() => {
          setSettingsOpen(false)
          setSettingsProject(null)
        }}
        onSetup={onSetup}
      />
    </Suspense>
  )

  // Each root shown in Code has one frame, held by one pane (see frameHolders); a running root no
  // pane item works in stops after its grace (see idleServers).
  const leaves = paneList(panes.root)
  // Under a shared bar the panes show no views of their own; the split's Code is held by the split.
  const splitCode = sharedRoot === null || shownGroupId === null ? null : splitCodeShown({ groupId: shownGroupId, root: sharedRoot, view: splitViews[shownGroupId] ?? 'agent' })
  const codeShown: CodeShown[] = [
    ...(sharedRoot !== null
      ? []
      : leaves.flatMap((leaf) => {
          const root = rootOf(leaf.item)
          return root !== null && root !== '' && hasActionBar(leaf.item) && viewOf(leaf.item) === 'code' ? [{ item: leaf.item, root }] : []
        })),
    ...(splitCode === null ? [] : [splitCode]),
  ]
  codeHolders.current = frameHolders(codeHolders.current, codeShown)
  const holders = codeHolders.current
  const shownRoots = codeShown.map((entry) => entry.root).join('\n')
  const usedRoots = [...new Set(leaves.map((leaf) => rootOf(leaf.item)).filter((root): root is string => root !== null && root !== ''))].sort().join('\n')
  useEffect(() => {
    const missing = codeShown.filter((entry, index) => codeShown.findIndex((other) => other.root === entry.root) === index && !codeTargets.some((target) => target.root === entry.root))
    if (missing.length > 0) setCodeTargets((current) => [...current, ...missing.map((entry) => codeTargetForRoot(projects, entry.root))])
  }, [shownRoots, codeTargets])
  useEffect(() => {
    setIdleCode((current) => idleServers(current, codeTargets.map((target) => target.root), new Set(usedRoots.split('\n')), Date.now()))
  }, [usedRoots, codeTargets])
  useEffect(() => {
    const since = Object.values(idleCode)
    if (since.length === 0) return
    const timer = setTimeout(() => {
      const expired = expiredServers(idleCode, Date.now())
      if (expired.length === 0) return
      setCodeTargets((current) => current.filter((target) => !expired.includes(target.root)))
      setGotos((current) => Object.fromEntries(Object.entries(current).filter(([root]) => !expired.includes(root))))
      for (const root of expired) void api.stopCodeServer(root).catch(() => {})
    }, Math.max(0, Math.min(...since) + serverGraceMs - Date.now()))
    return () => clearTimeout(timer)
  }, [idleCode])
  const focusCodeRoot = useStableCallback((root: string) => {
    const holder = codeHolders.current[root]
    if (holder !== undefined) focusItem(holder)
  })

  const controlsFor = (root: string | null): RunControls | null =>
    root === null || root === ''
      ? null
      : {
          root,
          panel: panelFor(runs.panels, root),
          run: (action, command, port) => runs.run(root, action, command, port),
          setPanelOpen: (open) => runs.setOpen(root, open),
          editCommands: (repo) => {
            setSettingsProject(repo)
            setSettingsOpen(true)
          },
        }
  // The action bar is on every item with a worktree but a maximised GitHub item: a launcher gets it
  // once it starts in a worktree, so Agent there is the launcher and Code the worktree's Code view.
  const paneViewFor = (item: string, root: string | null): PaneViewControls | null => {
    if (root === null || root === '' || !hasActionBar(item) || sharedRoot !== null) return null
    const holder = holders[root] ?? null
    return {
      facts: worktreeFacts(projects, root),
      view: viewOf(item),
      // Settings and a GitHub page keep ⌘1 to ⌘4 from the panes under them.
      focused: item === focusedItem && !settingsOpen && githubPage === null,
      setView: (view) => chooseItemView(item, view),
      code: <CodeSlot item={item} holder={holder} slots={codeSlots} onShowHolder={() => holder !== null && focusItem(holder)} />,
    }
  }
  // The focused pane's worktree: its run panel shows, and ⌘T opens a terminal there.
  const runRoot = githubPage !== null || focusedItem === null ? null : rootOf(focusedItem)
  const runControls = controlsFor(runRoot)
  // The window's shortcuts, by the keys Settings > Shortcuts gives them (lib/shortcuts.ts). Escape is
  // never handled here, so Code keeps it; nothing is, while Settings records a combination.
  const shortcutKeys = useShortcutBindings()
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

  // The pane keys and ⌘T listen in the capture phase, so a terminal or an editor in a pane does not keep them.
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
        // In a split it closes the focused pane and its item stays in the sidebar; alone it closes the item.
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
        // Left and right go between columns, up and down within one; the strip scrolls to the pane.
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
  // The keyboard goes with the focus: into the pane's terminal, composer or first field.
  const focusPaneById = (paneId: string) => {
    setPanes((current) => ({ ...current, focused: paneId }))
    focusPaneInput(paneId)
  }
  // Focus the sidebar on its selected row, or its first one; a collapsed sidebar opens first.
  const focusSidebar = () => {
    if (sidebarCollapsed) toggleSidebarCollapsed()
    requestAnimationFrame(() => {
      const nav = document.querySelector<HTMLElement>('nav[aria-label="Projects"]')
      ;(nav?.querySelector<HTMLElement>('[aria-current="true"]') ?? nav?.querySelector<HTMLElement>('button'))?.focus()
    })
  }

  const runPanelRoots = Object.keys(runs.panels).filter((root) => runs.panels[root]?.tabs.length !== 0)
  const runPanelShown = runControls !== null && runControls.panel.open
  const githubProject = githubPage === null ? null : (projects.find((project) => project.path === githubPage.path) ?? null)
  const githubView =
    githubPage !== null && githubProject !== null ? (
      <GithubPage
        key={`${githubPage.path}:${githubPage.kind}:${githubPage.focus ?? ''}`}
        project={githubProject}
        kind={githubPage.kind}
        focus={githubPage.focus}
        onKind={(kind) => setGithubPage({ path: githubPage.path, kind, focus: null })}
        onClose={() => setGithubPage(null)}
        onMaximise={(kind, number) => maximiseGithub(githubPage.path, kind, number)}
      />
    ) : null

  // Built here, after everything describing an item (rootOf) is declared.
  const splitRowsValue = groupRows(paneLayout, describeItem)
  const splitRowsSignature = JSON.stringify(splitRowsValue)
  const splitRows = useMemo<SplitRowsValue>(() => {
    const placed = groupsByPlace(splitRowsValue)
    return {
      byWorktree: placed.byWorktree,
      spanning: placed.spanning,
      members: new Set(splitRowsValue.flatMap((row) => row.members.map((member) => member.item))),
      itemOf: splitItemOf,
      focusGroup: focusSplit,
      focusMember: focusSplitMember,
      rename: renameSplit,
      groupMenu: splitGroupMenu,
      rowMenu: splitRowMenu,
      selected: new Set(picks),
      pick: pickSplitRow,
      drop: dropSplit,
    }
  }, [splitRowsSignature, picks])

  // A strip that scrolls moves its top-left pane away from the lights, so then they keep a row of their own.
  // A shared bar sits above the strip, so it joins the row whether the strip scrolls or not.
  const windowRow = sharedRoot !== null ? null : windowRowJoin({ collapsed: sidebarCollapsed, covered: githubView !== null || stripScrolls, panes: paneRects(panes.root).panes, hasTopBar: hasActionBar })
  const sharedJoined = sharedRoot !== null && sidebarCollapsed && githubView === null
  const sharedHolder = sharedRoot === null ? null : (holders[sharedRoot] ?? null)
  const sharedBar =
    sharedRoot === null || shownGroupId === null
      ? null
      : {
          facts: worktreeFacts(projects, sharedRoot),
          identity: groupIdentity(projects, sharedRoot),
          view: splitViews[shownGroupId] ?? 'agent',
          setView: (view: PaneView) => setSplitViews((current) => ({ ...current, [shownGroupId]: view })),
          focused: !settingsOpen && githubPage === null,
          code: <CodeSlot item={splitCodeItem(shownGroupId)} holder={sharedHolder} slots={codeSlots} onShowHolder={() => sharedHolder !== null && focusItem(sharedHolder)} />,
        }

  return (
    <div className="relative flex h-full">
      <SlidePanel open={!sidebarCollapsed} side="left" width={sidebarWidth.width} className="glass border-r border-white/[0.06]" handle={<ResizeHandle edge="right" label="Resize the sidebar" panel={sidebarWidth} />}>
        <SidebarHeader onCollapse={toggleSidebarCollapsed} onSettings={() => setSettingsOpen(true)} />
        <SplitRowsContext.Provider value={splitRows}>
          <Sidebar
            loaded={projectsLoaded}
            layoutReady={layoutReady}
            loadError={projectsError}
            onRetryLoad={retryProjects}
            projects={projects}
            selectedSessionId={selectedSessionId}
            onSelectSession={selectSidebarSession}
            onCode={stableShowCode}
            onImport={startImport}
            layout={layout}
            onLayout={stableLayout}
            layoutError={layoutError}
            filters={filters}
            onFilters={changeFilters}
            activeGithub={githubPage}
            onGithub={openGithub}
            chats={chatsInWorktrees}
            selectedChatId={nativeChatId}
            onSelectChat={selectNativeChat}
            onNewChat={openNewChat}
            onNewTerminal={openWorktreeTerminal}
            terminals={terminalsInWorktrees}
            selectedTerminalId={focusedTerminalId}
            onSelectTerminal={selectTerminal}
            onRenameTerminal={stableRenameTerminal}
            onCloseRow={requestClose}
            onDragRow={dragRow}
            onSplitDrop={dropSplit}
            creations={creations}
            onCreateWorktree={createWorktree}
            onRetryCreation={retryWorktree}
            onDismissCreation={dismissWorktree}
          />
        </SplitRowsContext.Provider>
        <SidebarUsage onOpenSettings={() => setSettingsOpen(true)} />
      </SlidePanel>
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-ink-950">
        {sidebarCollapsed && <CollapsedChrome onExpand={toggleSidebarCollapsed} onSettings={() => setSettingsOpen(true)} joined={windowRow !== null || sharedJoined} />}
        {error !== null && (
          <div className="px-8 pt-4">
            <ErrorNote error={error} />
          </div>
        )}
        <DispatchesContext.Provider value={status?.dispatches ?? noDispatches}>
          {/* The panes stay mounted under a GitHub page, so nothing in them is lost. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <RunContext.Provider value={controlsFor(sharedRoot)}>
              <SplitFrame shared={sharedBar} inset={sharedJoined ? windowRowInset : null}>
                {(covered) => (
                  <PaneArea
                    panes={panes}
                    onPanes={setPanes}
                    background={backgroundTerminals}
                    render={(item) => {
                      const content = render(item)
                      const root = rootOf(item)
                      return {
                        ...content,
                        node: (
                          <RunContext.Provider value={controlsFor(root)}>
                            <PaneViewContext.Provider value={paneViewFor(item, root)}>
                              <Suspense fallback={<Loading />}>{content.node}</Suspense>
                            </PaneViewContext.Provider>
                          </RunContext.Provider>
                        ),
                      }
                    }}
                    drag={drag}
                    strip={activeGroup(paneLayout)?.strip ?? emptyStrip}
                    stripKey={shownGroupId}
                    onStrip={changeStrip}
                    onOverflow={setStripScrolls}
                    onClose={closePaneById}
                    shared={sharedRoot !== null}
                    covered={covered}
                    windowRow={windowRow === null ? null : { join: windowRow, inset: windowRowInset }}
                    overlay={
                      codeTargets.length > 0 && (
                        <Suspense fallback={null}>
                          <CodeLayer targets={codeTargets} holders={holders} slots={codeSlots} gotos={gotos} dragging={drag.state !== null} onFocus={focusCodeRoot} />
                        </Suspense>
                      )
                    }
                  />
                )}
              </SplitFrame>
            </RunContext.Provider>
            {githubView !== null && (
              <div className="absolute inset-0 z-40 flex flex-col bg-ink-950">
                <RunContext.Provider value={null}>
                  <Suspense fallback={<Loading />}>{githubView}</Suspense>
                </RunContext.Provider>
              </div>
            )}
          </div>
        </DispatchesContext.Provider>
      </main>
      {/* Every worktree's runs stay mounted; only the open chat's panel shows. */}
      {runPanelRoots.length > 0 && (
        <SlidePanel
          open={runPanelShown}
          side="right"
          width={runPanelWidth.width}
          maxWidth="50vw"
          keepMounted
          appear
          className="glass border-l border-white/[0.06]"
          handle={<ResizeHandle edge="left" label="Resize the run panel" panel={runPanelWidth} grip />}
        >
          {(present) =>
            runPanelRoots.map((root) => (
              <RunPanel key={root} worktree={root} panel={panelFor(runs.panels, root)} visible={present && root === runRoot} runs={runs} onEditCommands={() => runControls?.editCommands(root)} />
            ))
          }
        </SlidePanel>
      )}
      <ConfirmDialog confirm={closeConfirm} onClose={() => setCloseConfirm(null)} />
      <ConfirmDialog confirm={runs.confirm} onClose={runs.dismissConfirm} />
      {importing && <ImportProject projects={projects} onClose={() => setImporting(false)} onImported={() => setImporting(false)} />}
      {settingsOverlay}
    </div>
  )
}

const noDispatches: readonly Dispatch[] = []

const presetNames: Record<Preset, string> = { row: 'Side by side', column: 'Stacked', grid: 'Grid', main: 'One large + column', bottom: 'One on the bottom', top: 'One on the top' }
const presetIcons: Record<Preset, MenuIcon> = { row: 'splitRight', column: 'splitDown', grid: 'splitGrid', main: 'splitMain', bottom: 'splitBottom', top: 'splitTop' }

/** The items whose top bar carries the action bar, and so can show Code: all but a GitHub item. */
const paneViewKinds: ReadonlySet<ItemKind> = new Set<ItemKind>(['dispatch', 'session', 'native', 'terminal', 'launcher', 'code'])

function hasActionBar(item: string): boolean {
  const kind = parseItem(item)?.kind
  return kind !== undefined && paneViewKinds.has(kind)
}

const paneDirections: Partial<Record<ShortcutId, Direction>> = { 'pane.focusLeft': 'left', 'pane.focusRight': 'right', 'pane.focusUp': 'up', 'pane.focusDown': 'down' }

/** A pane whose item is no longer listed: a dispatch that was pruned, a chat that ended elsewhere. */
function GoneNote() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-[13.5px] text-ink-400">
      This is no longer listed. Pick something in the sidebar or close the pane.
    </div>
  )
}

function worktreeChoices(projects: Project[]) {
  return partitionHidden(projects).visible.flatMap((project) =>
    project.missing ? [] : project.worktrees.map((worktree) => ({ path: worktree.path, label: `${project.name} · ${worktree.branch ?? worktree.path.split('/').at(-1) ?? worktree.path}` })),
  )
}
