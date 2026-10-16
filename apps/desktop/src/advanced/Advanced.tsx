import { lazy, Suspense, useEffect, useMemo, useState, type PointerEvent } from 'react'
import { api } from '@/api'
import { sessionsOfOrigin } from '@/api/projects-origin'
import type { Dispatch, HistorySession, NativeChat, Project, ProjectSession } from '@/api/schema'
import { groupChats, worktreeRepositories } from '@/advanced/model'
import { arrivedCreations, creationFailed, creationSucceeded, dismissCreation, retryCreation, startCreation, type PendingWorktree } from '@/advanced/new-worktree-model'
import { neighbourSession, sidebarSessionOrder } from '@/advanced/projects-model'
import { Sidebar, readFilters, writeFilters, type SidebarDrag } from '@/advanced/Sidebar'
import { filterProjects, partitionHidden, type SidebarFilters } from '@/advanced/sidebar-model'
import { applyOrder } from '@/advanced/project-order'
import { flattenLayout, reconcileLayout } from '@/advanced/sidebar-folders'
import { useSidebarLayout } from '@/advanced/useSidebarLayout'
import { CollapsedChrome, SettingsIcon, SidebarHeader } from '@/advanced/chrome'
import { ChatView } from '@/chat/ChatView'
import { OpenCodeContext } from '@/chat/code-context'
import type { OpenChat, OpenPath } from '@/chat/Conversation'
import { DispatchesContext } from '@/chat/NoticeCard'
import { SessionView } from '@/chat/SessionView'
import type { CodeGoto } from '@/code/CodeFrame'
import { closeCode, codeTargetForRoot, emptyCodeMode, enterCode, isToggleChatsKey, leaveCode, type CodeModeState, type CodeTarget } from '@/code/code-mode-model'
import type { GithubKind } from '@/github/useGithubCounts'
import { ImportProject } from '@/import/ImportProject'
import { PaneSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { ResizeHandle, usePanelWidth } from '@/components/ResizeHandle'
import { SlidePanel } from '@/components/SlidePanel'
import { runPanelLimits, sidebarLimits } from '@/lib/panel-width'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { ownership } from '@/chat/session-ownership'
import { RunContext, type RunControls } from '@/run-panel/run-context'
import { panelFor } from '@/run-panel/run-model'
import { RunPanel } from '@/run-panel/RunPanel'
import { useRunPanels } from '@/run-panel/useRunPanels'
import { projectsPolicy } from '@/lib/poll-model'
import { reuse } from '@/lib/reuse'
import { announceAction } from '@/lib/app-events'
import { usePoll } from '@/lib/usePoll'
import { useStableCallback } from '@/lib/useStableCallback'
import { useStatus } from '@/lib/useStatus'
import { chatsByWorktree } from '@/native-chat/chat-model'
import { NativeChatView } from '@/native-chat/NativeChatView'
import { Launcher, newTerminalId } from '@/launcher/Launcher'
import { forgetTerminal, LaunchedTerminal } from '@/launcher/LaunchedTerminal'
import { addTerminal, closeCall, closeNeedsConfirm, keepsPane, mountsInBackground, removeTerminal, renameTerminal, restoreAppTerminals, terminalExited, terminalSessionIds, terminalFailed, terminalLabel, terminalRetried, terminalStarted, terminalsByWorktree, type AppTerminal, type TerminalLaunch } from '@/terminal/terminal-list'
import { closePane, dropItem, focusDirection, movePane, itemKey, openItem, paneList, paneOfItem, parseItem, parsePanes, pruneItems, removeItem, replaceItem, serialisePanes, singlePane, type Direction, type Panes } from '@/panes/pane-model'
import { PaneArea, type PaneContent } from '@/panes/PaneArea'
import { usePaneDrag } from '@/panes/usePaneDrag'
import { alreadyOpen } from '@/launcher/resume-model'

// Code mode, Quick view (CodeMirror), the GitHub pages and settings load the first time they open,
// so starting the app parses only the sidebar and chats.
const CodeFrame = lazy(() => import('@/code/CodeFrame').then((module) => ({ default: module.CodeFrame })))
const CodeRail = lazy(() => import('@/code/CodeRail').then((module) => ({ default: module.CodeRail })))
const QuickView = lazy(() => import('@/code/QuickView').then((module) => ({ default: module.QuickView })))
const GithubPage = lazy(() => import('@/github/GithubPage').then((module) => ({ default: module.GithubPage })))
const SettingsWindow = lazy(() => import('@/settings/SettingsWindow').then((module) => ({ default: module.SettingsWindow })))

function Loading() {
  return <PaneSkeleton />
}

function useProjects(): { projects: Project[]; chats: NativeChat[]; loaded: boolean; dropChat: (id: string) => void } {
  const [projects, setProjects] = useState<Project[]>([])
  const [chats, setChats] = useState<NativeChat[]>([])
  const [loaded, setLoaded] = useState(false)
  usePoll(
    projectsPolicy,
    async (current) => {
      // Native chats ride the projects poll; a CLI without them leaves the list empty.
      const [next, nextChats] = await Promise.all([api.projects('megabrain'), api.chats().catch(() => null)])
      if (!current()) return
      // Only sessions megabrain started; one opened in Orca or a plain terminal belongs there.
      setProjects((previous) => reuse(previous, sessionsOfOrigin(next, 'megabrain')))
      if (nextChats !== null) setChats((previous) => reuse(previous, nextChats))
      setLoaded(true)
    },
    [],
  )
  // A removed chat leaves the list at once instead of at the next poll.
  const dropChat = useStableCallback((id: string) => setChats((previous) => previous.filter((chat) => chat.id !== id)))
  return { projects, chats, loaded, dropChat }
}

const panesKey = 'megabrain.panes'

const newPaneId = () => `pane-${crypto.randomUUID()}`
const newLauncher = () => itemKey('launcher', crypto.randomUUID())

/** The layout this viewer left, or one pane with the launcher. Items that are gone are dropped once the lists load. */
function storedPanes(): Panes {
  try {
    const stored = parsePanes(localStorage.getItem(panesKey))
    if (stored !== null) return stored
  } catch {
    // A remembered layout is a convenience; one pane is fine.
  }
  return singlePane(newLauncher(), newPaneId())
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

// The advanced window: chats in a sidebar (projects > worktrees > chats), the selected chat followed
// live, and each project's code.
export function Advanced({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  const { projects: listed, chats: nativeChats, loaded: projectsLoaded, dropChat } = useProjects()
  const { layout: savedLayout, change: changeLayout, error: layoutError } = useSidebarLayout()
  // The folders and order the person dragged the projects into; ⌘[ and ⌘] walk them the same way.
  const layout = useMemo(() => reconcileLayout(savedLayout, listed.map((project) => project.path)), [savedLayout, listed])
  const projects = useMemo(() => applyOrder(listed, flattenLayout(layout)), [listed, layout])
  // Chats are grouped by the repository of their worktree; the projects list already names it.
  const worktrees = useMemo(() => worktreeRepositories(listed), [listed])
  // The main area's panes, each showing one item; the sidebar follows the focused one.
  const [panes, setPanes] = useState<Panes>(storedPanes)
  const [pruned, setPruned] = useState(false)
  const [quick, setQuick] = useState<CodeTarget | null>(null)
  // A project's pull request or issue page, shown in the main area over chats and the launcher.
  const [githubPage, setGithubPage] = useState<{ path: string; kind: GithubKind; focus: number | null } | null>(null)
  const [codeMode, setCodeMode] = useState<CodeModeState>(emptyCodeMode)
  // The last root shown in Code mode, so the toggle key returns to it from chats.
  const [lastCode, setLastCode] = useState<CodeTarget | null>(null)
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
    setQuick(null)
    setGithubPage(null)
    setPanes((current) => openItem(current, item))
  }

  const openSession = (session: ProjectSession, worktreePath: string) => {
    if (findSession(session.sessionId) === null) setExtraSessions((current) => ({ ...current, [session.sessionId]: { session, worktreePath } }))
    showItem(sessionItem(session))
  }

  const openRelatedChat: OpenChat = useStableCallback((target) => {
    setQuick(null)
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

  const openCode = (target: CodeTarget) => {
    setQuick(null)
    setLastCode(target)
    setCodeMode((current) => enterCode(current, target).state)
  }

  const openPath: OpenPath = useStableCallback((root, path, line) => {
    setGotos((current) => ({ ...current, [root]: { path, line } }))
    openCode(codeTargetForRoot(projects, root))
  })

  // Leaving Code mode keeps every server running; only closing a root stops its own.
  const closeCodeRoot = (root: string) => {
    const { state, stop } = closeCode(codeMode, root)
    setCodeMode(state)
    if (lastCode?.root === root) setLastCode(state.open.at(-1) ?? null)
    if (stop !== null) void api.stopCodeServer(stop).catch(() => {})
    setGotos(({ [root]: _closed, ...rest }) => rest)
  }

  // The sidebar is memoised; these keep their identity so a status poll does not re-render it.
  const selectSidebarSession = useStableCallback((session: ProjectSession) => {
    const worktree = projects.flatMap((project) => project.worktrees).find((candidate) => candidate.sessions.some((item) => item.sessionId === session.sessionId))
    openSession(session, worktree?.path ?? '')
  })
  const stableOpenCode = useStableCallback(openCode)
  const openCodeRoot = useStableCallback((root: string) => openCode(codeTargetForRoot(projects, root)))
  const openQuickView = useStableCallback((target: CodeTarget) => {
    setGithubPage(null)
    setQuick(target)
  })
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
    setQuick(null)
    setGithubPage(null)
    setPanes((current) => {
      const pane = launcher === null ? null : paneOfItem(current, launcher)
      return pane === null ? openItem(current, item) : replaceItem(current, pane.id, item)
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
  const runCreation = (creation: Pick<PendingWorktree, 'id' | 'repo' | 'branch' | 'base'>) =>
    api.createWorktree(creation.repo, creation.branch, creation.base).then(
      (created) => setCreations((current) => creationSucceeded(current, creation.id, created.path)),
      (caught: unknown) => setCreations((current) => creationFailed(current, creation.id, caught)),
    )
  const createWorktree = useStableCallback((project: Project, branch: string, base: string) => {
    const creation = { id: crypto.randomUUID(), repo: project.path, branch, base }
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
    setPanes((current) => removeItem(current, itemKey('terminal', terminal.id), newLauncher()))
  })
  const closeChat = async (chat: NativeChat) => {
    await api.removeChat(chat.id)
    dropChat(chat.id)
    if (startedChat?.id === chat.id) setStartedChat(null)
    setPanes((current) => removeItem(current, itemKey('native', chat.id), newLauncher()))
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
    if (!ownership(session).owned) return
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
      if (found !== null && ownership(found.session).owned) return requestClose({ kind: 'session', session: found.session })
    }
    closePaneById(panes.focused)
    return Promise.resolve()
  })
  // A sidebar item dropped on a pane splits it or replaces its item; a pane dragged by its header moves.
  const drag = usePaneDrag((source, target) => {
    setQuick(null)
    setGithubPage(null)
    if (source.kind === 'pane') setPanes((current) => movePane(current, source.paneId, target.paneId, target.zone))
    else setPanes((current) => dropItem(current, source.item, target.paneId, target.zone, newPaneId()))
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
    setQuick(null)
    setGithubPage({ path: project.path, kind, focus: focus ?? null })
  })

  const toggleCode = () => {
    if (codeMode.active !== null) setCodeMode(leaveCode)
    else if (lastCode !== null) openCode(lastCode)
  }

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
    }
  }

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
    }
  }

  // Once the lists load, a restored layout drops the items that are gone (a terminal whose tmux
  // session ended with the last run among them); later an item that disappears shows a note in its pane instead.
  useEffect(() => {
    if (pruned || !listsLoaded) return
    setPruned(true)
    setPanes((current) => pruneItems(current, itemExists, { id: newPaneId(), item: newLauncher() }))
  }, [pruned, listsLoaded])

  useEffect(() => {
    try {
      localStorage.setItem(panesKey, serialisePanes(panes))
    } catch {
      // A remembered layout is a convenience; the next launch starts with one pane.
    }
  }, [panes])

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
        return { title: found.session.title, node: <SessionView session={found.session} worktreePath={found.worktreePath} onOpenChat={openRelatedChat} onOpenPath={openPath} /> }
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

  const inCode = codeMode.active !== null
  const controlsFor = (root: string | null): RunControls | null =>
    root === null || root === ''
      ? null
      : {
          root,
          panel: panelFor(runs.panels, root),
          run: (action, command) => runs.run(root, action, command),
          setPanelOpen: (open) => runs.setOpen(root, open),
          editCommands: (repo) => {
            setSettingsProject(repo)
            setSettingsOpen(true)
          },
        }
  // The focused pane's worktree: its run panel shows, and ⌘T opens a terminal there.
  const runRoot = quick !== null || githubPage !== null || focusedItem === null ? null : rootOf(focusedItem)
  const runControls = controlsFor(runRoot)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
        return
      }
      if (isToggleChatsKey(event)) {
        event.preventDefault()
        toggleCode()
        return
      }
      // Code mode owns the window: walking chats or folding the sidebar would change what is
      // behind it. Escape is never handled here, so VS Code keeps it.
      if (codeMode.active !== null) return
      if (event.metaKey && event.key.toLowerCase() === 'n' && !event.shiftKey && !event.altKey) {
        event.preventDefault()
        openNewChat(null)
        return
      }
      if (event.metaKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebarCollapsed()
        return
      }
      if (!event.metaKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      setQuick(null)
      const step = event.key === ']' ? 1 : -1
      const next = neighbourSession(sessionRows, selectedSessionId, step)
      if (next !== null) openSession(next.session, next.worktreePath)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionRows, selectedSessionId, codeMode, lastCode])

  // ⌘T opens a terminal in the focused pane's worktree and ⌘⌥ arrows move the focus between panes.
  // They listen in the capture phase, so a terminal or an editor in a pane does not keep them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (codeMode.active !== null || !event.metaKey || event.shiftKey || event.ctrlKey) return
      if (event.key.toLowerCase() === 'w' && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        closeFocused().catch(() => {})
        return
      }
      if (event.key.toLowerCase() === 't' && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        const cwd = runRoot ?? worktreeChoices(projects)[0]?.path ?? null
        if (cwd !== null && cwd !== '') openTerminal(cwd, null)
        return
      }
      const direction = event.altKey ? arrowDirections[event.key] : undefined
      if (direction === undefined) return
      event.preventDefault()
      event.stopPropagation()
      const next = focusDirection(panes, direction)
      if (next.focused === panes.focused) return
      setPanes(next)
      // The keyboard goes with the focus: into the pane's terminal, composer or first field.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(next.focused)}"]`)?.querySelector<HTMLElement>('textarea, [contenteditable="true"], input')?.focus())
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [codeMode, runRoot, projects, panes])

  const runPanelRoots = Object.keys(runs.panels).filter((root) => runs.panels[root]?.tabs.length !== 0)
  const runPanelShown = !inCode && runControls !== null && runControls.panel.open
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
      />
    ) : null

  return (
    <div className="relative flex h-full">
      {inCode && <Suspense fallback={null}><CodeRail state={codeMode} projects={projects} onSelect={openCode} onClose={closeCodeRoot} onChats={() => setCodeMode(leaveCode)} onSettings={() => setSettingsOpen(true)} /></Suspense>}
      {!inCode && (
        <SlidePanel open={!sidebarCollapsed} side="left" width={sidebarWidth.width} className="glass border-r border-white/[0.06]" handle={<ResizeHandle edge="right" label="Resize the sidebar" panel={sidebarWidth} />}>
          <SidebarHeader onCollapse={toggleSidebarCollapsed} />
          <Sidebar
            loaded={projectsLoaded}
            projects={projects}
            selectedSessionId={selectedSessionId}
            onSelectSession={selectSidebarSession}
            onCode={stableOpenCode}
            onQuickView={openQuickView}
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
            creations={creations}
            onCreateWorktree={createWorktree}
            onRetryCreation={retryWorktree}
            onDismissCreation={dismissWorktree}
          />
          <footer className="shrink-0 border-t border-white/[0.07] px-2.5 py-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Settings (⌘,)"
              className="flex h-8 w-full items-center gap-2.5 rounded-[12px] pr-1.5 pl-2.5 text-left text-[13px] font-medium text-ink-300 transition-colors hover:bg-row-hover hover:text-ink-100"
            >
              <SettingsIcon />
              Settings
            </button>
          </footer>
        </SlidePanel>
      )}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-ink-950">
        {/* Chats stay mounted under Code mode so a draft or a scroll position survives the trip. */}
        <div className={inCode ? 'hidden' : 'contents'}>
          {sidebarCollapsed && <CollapsedChrome onExpand={toggleSidebarCollapsed} />}
          {error !== null && (
            <div className="px-8 pt-4">
              <ErrorNote error={error} />
            </div>
          )}
          <OpenCodeContext.Provider value={openCodeRoot}>
            <DispatchesContext.Provider value={status?.dispatches ?? noDispatches}>
              {/* The panes stay mounted under a GitHub page or Quick view, so nothing in them is lost. */}
              <div className="relative flex min-h-0 flex-1 flex-col">
                <PaneArea
                  panes={panes}
                  onPanes={setPanes}
                  background={backgroundTerminals}
                  render={(item) => {
                    const content = render(item)
                    return { ...content, node: <RunContext.Provider value={controlsFor(rootOf(item))}><Suspense fallback={<Loading />}>{content.node}</Suspense></RunContext.Provider> }
                  }}
                  drag={drag}
                  onClose={closePaneById}
                />
                {(githubView !== null || quick !== null) && (
                  <div className="absolute inset-0 z-40 flex flex-col bg-ink-950">
                    <RunContext.Provider value={null}>
                      <Suspense fallback={<Loading />}>{githubView ?? (quick === null ? null : <QuickView key={quick.root} root={quick.root} title={quick.title} onClose={() => setQuick(null)} />)}</Suspense>
                    </RunContext.Provider>
                  </div>
                )}
              </div>
            </DispatchesContext.Provider>
          </OpenCodeContext.Provider>
        </div>
        <Suspense fallback={inCode ? <Loading /> : null}>
          {codeMode.open.map((target) => (
            <CodeFrame key={target.root} target={target} visible={target.root === codeMode.active} goto={gotos[target.root] ?? null} />
          ))}
        </Suspense>
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

const arrowDirections: Partial<Record<string, Direction>> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

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
