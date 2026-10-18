import { lazy, Suspense, useEffect, useMemo, useState, type PointerEvent } from 'react'
import { api } from '@/api'
import type { Artifact, Dispatch, HistorySession, NativeChat, Project, ProjectSession } from '@/api/schema'
import { arrivedCreations, creationFailed, creationSucceeded, dismissCreation, retryCreation, startCreation, stacksOn, type PendingWorktree } from '@/advanced/new-worktree-model'
import { sidebarSessionOrder } from '@/advanced/projects-model'
import { Sidebar, readFilters, writeFilters, type SidebarDrag } from '@/advanced/Sidebar'
import { filterProjects, partitionHidden, type SidebarFilters } from '@/advanced/sidebar-model'
import { applyOrder } from '@/advanced/project-order'
import { flattenLayout, reconcileLayout } from '@/advanced/sidebar-folders'
import { useSidebarLayout } from '@/advanced/useSidebarLayout'
import { CollapsedChrome, SidebarHeader, windowRowInset } from '@/advanced/chrome'
import { displayName } from '@/advanced/appearance-model'
import type { WorktreeOpen } from '@/advanced/project-page-model'
import type { ProjectPageActions } from '@/advanced/ProjectPage'
import { ChatView } from '@/chat/ChatView'
import { SidebarUsage } from '@/advanced/SidebarUsage'
import { homeView, knowledgeItem, knowledgeItemIn, knowledgeView, type KnowledgeView } from '@/advanced/knowledge-model'
import { artifactsItem, artifactsItemIn } from '@/advanced/artifacts-model'
import { chooseView, initialView, worktreeFacts, type PaneView } from '@/chat/action-bar-model'
import { PaneViewContext, type PaneViewControls } from '@/chat/pane-view-context'
import { CodeRootsProvider, type OpenPath } from '@/chat/Conversation'
import { DispatchesContext } from '@/chat/NoticeCard'
import { ChatdNotice } from '@/native-chat/ChatdNotice'
import { SessionView } from '@/chat/SessionView'
import { CodePane } from '@/code/CodePane'
import { CodeSlot } from '@/code/CodeSlot'
import { codeTargetForRoot, type CodeShown, type CodeTarget } from '@/code/code-pane-model'
import type { GithubKind } from '@/github/useGithubCounts'
import { githubItemId, githubItemTitle, parseGithubItemId, type GithubItemKind } from '@/github/review-model'
import { ImportProject } from '@/import/ImportProject'
import { PaneSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { ResizeHandle, usePanelWidth } from '@/components/ResizeHandle'
import { SlidePanel } from '@/components/SlidePanel'
import { runPanelLimits, sidebarLimits, sidebarSurface } from '@/lib/panel-width'
import { ConfirmDialog, type PendingConfirm } from '@/components/ConfirmDialog'
import { closable, closeOf } from '@/chat/session-ownership'
import { RunContext, type RunControls } from '@/run-panel/run-context'
import { panelFor } from '@/run-panel/run-model'
import { RunPanel } from '@/run-panel/RunPanel'
import { useRunPanels } from '@/run-panel/useRunPanels'
import { announceAction } from '@/lib/app-events'
import { useStableCallback } from '@/lib/useStableCallback'
import { useStatus } from '@/lib/useStatus'
import { chatsByWorktree, rowStatus } from '@/native-chat/chat-model'
import { NativeChatView } from '@/native-chat/NativeChatView'
import { Launcher, newTerminalId } from '@/launcher/Launcher'
import { forgetTerminal, LaunchedTerminal } from '@/launcher/LaunchedTerminal'
import { addTerminal, closeCall, closeNeedsConfirm, mountsInBackground, removeTerminal, renameTerminal, terminalExited, terminalFailed, terminalLabel, terminalRetried, terminalRuns, terminalStarted, terminalsByWorktree, type AppTerminal, type TerminalLaunch } from '@/terminal/terminal-list'
import { closePane, dropItem, itemKey, paneList, paneOfItem, paneRects, parseItem, replaceItem, spanItem, type Panes } from '@/panes/pane-model'
import { activeGroup, changeGroupPanes, changeShown, groupOfItem, openLayoutItem, removeLayoutItem, shownPanes } from '@/panes/split-groups'
import { groupRows, groupsByPlace, type MemberInfo } from '@/advanced/split-rows'
import { SplitRowsContext, type SplitRowsValue } from '@/advanced/SplitRows'
import { hasActionBar, presetIcons, presetNames } from '@/advanced/pane-layout-display'
import { arrangePane } from '@/panes/arrange'
import { PaneArea, type PaneContent } from '@/panes/PaneArea'
import { SplitFrame } from '@/panes/GroupBar'
import { groupIdentity, sharedWorktree, splitCodeItem, splitCodeShown, type SplitMember } from '@/panes/group-bar'
import { emptyStrip } from '@/panes/strip'
import { windowRowJoin } from '@/panes/window-row'
import { usePaneDrag } from '@/panes/usePaneDrag'
import { alreadyOpen } from '@/launcher/resume-model'
import { useProjects } from '@/advanced/useProjects'
import { newGroupId, newLauncher, newPaneId, usePaneState } from '@/advanced/usePaneState'
import { useSessionNavigation } from '@/advanced/useSessionNavigation'
import { usePanePersistence } from '@/advanced/usePanePersistence'
import { useCodeLifecycle } from '@/advanced/useCodeLifecycle'
import { focusPaneInput, usePaneShortcuts, worktreeChoices } from '@/advanced/usePaneShortcuts'
import { useSplitInteractions } from '@/advanced/useSplitInteractions'
import { pageX } from '@/lib/page'
import { GoneNote } from '@/advanced/GoneNote'
import { SettingsOverlay } from '@/advanced/SettingsOverlay'
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/advanced/sidebar-state'

// Code, the GitHub pages and settings load the first time they open,
// so starting the app parses only the sidebar and chats.
const CodeLayer = lazy(() => import('@/code/CodeLayer').then((module) => ({ default: module.CodeLayer })))
const GithubPage = lazy(() => import('@/github/GithubPage').then((module) => ({ default: module.GithubPage })))
const GithubItemView = lazy(() => import('@/github/GithubItem').then((module) => ({ default: module.GithubItemView })))
const ProjectPage = lazy(() => import('@/advanced/ProjectPage').then((module) => ({ default: module.ProjectPage })))
const KnowledgePage = lazy(() => import('@/advanced/KnowledgePage').then((module) => ({ default: module.KnowledgePage })))
const ArtifactsPage = lazy(() => import('@/advanced/ArtifactsPage').then((module) => ({ default: module.ArtifactsPage })))

function Loading() {
  return <PaneSkeleton />
}

// The advanced window: chats in a sidebar (projects > worktrees > chats), the selected chat followed
// live, and each project's code.
export function Advanced({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  const { projects: listed, chats: nativeChats, loaded: projectsLoaded, chatsLoaded, error: projectsError, retry: retryProjects, dropChat } = useProjects()
  const { layout: savedLayout, change: changeLayout, error: layoutError, ready: layoutReady } = useSidebarLayout()
  // The folders and order the person dragged the projects into; ⌘[ and ⌘] walk them the same way.
  const layout = useMemo(() => reconcileLayout(savedLayout, listed.map((project) => project.path)), [savedLayout, listed])
  const projects = useMemo(() => applyOrder(listed, flattenLayout(layout)), [listed, layout])
  // The split groups and the single pane; the main area shows one of them, each pane one item, and
  // the sidebar follows the focused one.
  const { paneLayout, setLayout, pruned, setPruned, paneViews, setPaneViews, splitViews, setSplitViews, githubPage, setGithubPage, codeTargets, setCodeTargets, idleCode, setIdleCode, codeHolders, codeSlots, gotos, setGotos } = usePaneState()
  const panes = shownPanes(paneLayout)
  /** A pane operation on what is shown; it may make a split group or dissolve one (see changeShown). */
  const setPanes = (change: (current: Panes) => Panes) => setLayout((current) => changeShown(current, change, newGroupId()))
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
  // The page Settings opens on, from the Knowledge page's link.
  const [settingsSection, setSettingsSection] = useState<'knowledge' | null>(null)
  const [filters, setFilters] = useState<SidebarFilters>(readFilters)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(readSidebarCollapsed)
  const sidebarWidth = usePanelWidth('megabrain.sidebar.width', sidebarLimits)
  const runPanelWidth = usePanelWidth('megabrain.runPanel.width', runPanelLimits)
  const runs = useRunPanels()
  // ⌘[ and ⌘] walk the sessions the sidebar shows: hidden and filtered-out ones are skipped.
  const worktreePaths = useMemo(() => listed.flatMap((project) => project.worktrees.map((worktree) => worktree.path)), [listed])
  const chatsInWorktrees = useMemo(() => chatsByWorktree(nativeChats, worktreePaths), [nativeChats, worktreePaths])
  const terminalsInWorktrees = useMemo(() => terminalsByWorktree(terminals, worktreePaths), [terminals, worktreePaths])
  const sessionRows = useMemo(() => sidebarSessionOrder(filterProjects(partitionHidden(projects).visible, filters), new Set()), [projects, filters])

  const toggleSidebarCollapsed = () => {
    setSidebarCollapsed((current) => {
      const next = !current
      writeSidebarCollapsed(next)
      return next
    })
  }

  const { findSession, sessionItem, showItem, openSession, openRelatedChat } = useSessionNavigation({ projects, status, extraSessions, setExtraSessions, setGithubPage, setLayout })

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
  const focusedNativeChat = nativeChatId === null ? null : (nativeChats.find((entry) => entry.id === nativeChatId) ?? null)
  const focusedNativeChatLabel = focusedNativeChat === null ? null : { id: focusedNativeChat.id, title: focusedNativeChat.title ?? 'New chat' }
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
  // A branch from a turn opens beside the chat it came from, in the focused pane group, as a started chat does.
  const chatBranched = (chat: NativeChat) => {
    setStartedChat(chat)
    announceAction()
    showItem(itemKey('native', chat.id))
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
            ? 'Closing the terminal ends its tmux session and whatever runs in it.'
            : 'Its process may still be running. Closing the terminal ends it.',
        action: 'Close terminal',
        run: () => closeTerminal(terminal),
      })
      return
    }
    // A conversation listed on its own has one Close, by its owner. A chat's closes as the chat; a
    // terminal conversation's ends its process or tmux session and drops its entry, asking first only
    // while it still runs.
    const { session } = row
    const close = closeOf(session)
    if (close === null) return
    if (close.kind === 'chat') {
      const chat = nativeChats.find((entry) => entry.id === close.chatId)
      if (chat !== undefined) return requestClose({ kind: 'native', chat })
      return api.removeChat(close.chatId).then(() => dropChat(close.chatId))
    }
    if (session.status === 'ended') return api.releaseSession(close.sessionId)
    setCloseConfirm({
      title: `Close ${session.title}?`,
      body: "Closing ends the agent running this conversation and takes it out of the list. The agent's own session stays on disk, so Resume can still open it.",
      action: 'Close',
      run: () => api.releaseSession(close.sessionId),
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
      // A project's page spans its worktrees, so its group sits with no one worktree.
      case 'project':
      case 'knowledge':
      case 'artifact':
        return null
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
        return { title: target === null ? 'GitHub' : githubItemTitle(target), mark: { kind: 'github' }, state: 'idle', worktree }
      }
      case 'code':
        return { title: codeTargetForRoot(projects, parsed.id).title, mark: { kind: 'code' }, state: 'idle', worktree }
      case 'project': {
        const project = projects.find((entry) => entry.path === parsed.id)
        return { title: project === undefined ? 'Project' : displayName(project), mark: { kind: 'project' }, state: 'idle', worktree }
      }
      case 'knowledge':
        return { title: 'Knowledge', mark: { kind: 'knowledge' }, state: 'idle', worktree }
      case 'artifact':
        return { title: 'Artifacts', mark: { kind: 'artifact' }, state: 'idle', worktree }
    }
  }
  const splitRowsValue = groupRows(paneLayout, describeItem)
  const { shownGroupId, changeStrip, stripScrolls, setStripScrolls, focusSplit, focusSplitMember, renameSplit, splitGroupMenu, splitItemOf, splitWith, picks, splitRowMenu, dropSplit, pickSplitRow } = useSplitInteractions({ paneLayout, setLayout, setGithubPage, newPaneId, newGroupId, newLauncher, focusPaneInput, sessionItem, splitRowsValue, describeItem, presetNames, presetIcons })

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
  const openProject = useStableCallback((project: Project) => showItem(itemKey('project', project.path)))
  /** The Knowledge page, one in the layout: shown where it already is, on `view` when given, else in the focused pane. */
  const openKnowledge = useStableCallback((view: KnowledgeView | null) => {
    setGithubPage(null)
    setLayout((current) => {
      const open = knowledgeItemIn([current.single, ...current.groups.map((group) => group.panes)].flatMap((panes) => paneList(panes.root).map((leaf) => leaf.item)))
      const item = view === null ? (open ?? knowledgeItem(homeView)) : knowledgeItem(view)
      if (open === null || open === item) return openLayoutItem(current, item)
      const swap = (panes: Panes) => {
        const leaf = paneOfItem(panes, open)
        return leaf === null ? panes : replaceItem(panes, leaf.id, item)
      }
      const group = groupOfItem(current, open)
      return openLayoutItem(group === null ? { ...current, single: swap(current.single) } : changeGroupPanes(current, group.id, swap), item)
    })
  })
  const openKnowledgeHome = useStableCallback(() => openKnowledge(null))
  const openKnowledgeTopic = useStableCallback((repo: string, topic: string) => openKnowledge({ repo, topic, chat: null, map: false }))
  /** The Artifacts page, one in the layout like the Knowledge page: shown where it already is, on `artifact` when given. */
  const openArtifact = useStableCallback((artifact: Artifact | null) => openArtifactId(artifact?.id ?? null))
  const openArtifactId = useStableCallback((artifactId: string | null) => {
    setGithubPage(null)
    setLayout((current) => {
      const open = artifactsItemIn([current.single, ...current.groups.map((group) => group.panes)].flatMap((panes) => paneList(panes.root).map((leaf) => leaf.item)))
      const item = artifactId === null ? (open ?? artifactsItem(null)) : artifactsItem(artifactId)
      if (open === null || open === item) return openLayoutItem(current, item)
      const swap = (panes: Panes) => {
        const leaf = paneOfItem(panes, open)
        return leaf === null ? panes : replaceItem(panes, leaf.id, item)
      }
      const group = groupOfItem(current, open)
      return openLayoutItem(group === null ? { ...current, single: swap(current.single) } : changeGroupPanes(current, group.id, swap), item)
    })
  })
  const openArtifacts = useStableCallback(() => openArtifact(null))
  /** Settings on its Knowledge page, at a project's row when given. */
  const openKnowledgeSettings = useStableCallback((repo: string | null) => {
    setSettingsProject(repo)
    setSettingsSection('knowledge')
    setSettingsOpen(true)
  })
  /** A worktree or chat picked on a project's page: its chat, or the worktree's launcher. */
  const openFromPage = (open: WorktreeOpen, path: string) => {
    if (open.kind === 'launcher') openNewChat(path)
    else if (open.kind === 'native') selectNativeChat(open.chat)
    else openSession(open.session, path)
  }
  // A pull request or issue maximised from its page takes the focused pane, like any other item.
  const maximiseGithub = (root: string, kind: GithubItemKind, number: number) => showItem(itemKey('github', githubItemId(kind, number, root)))

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
      // The page runs the project's commands in its main checkout.
      case 'project':
        return parsed.id
      // The page spans a project's worktrees, so it runs nothing; nor does the Artifacts page.
      case 'knowledge':
      case 'artifact':
        return null
    }
  }
  // The shown split's members, and the worktree they all work in when it shares one bar.
  const splitMembers: SplitMember[] = paneList(panes.root).map((leaf) => {
    const mark = describeItem(leaf.item).mark
    return { item: leaf.item, kind: parseItem(leaf.item)?.kind ?? null, worktree: rootOf(leaf.item), agent: mark.kind === 'agent' ? mark.agent : null }
  })
  const sharedRoot = sharedWorktree(splitMembers)

  const { listsLoaded } = usePanePersistence({ status, projectsLoaded, chatsLoaded, projects, nativeChats, startedChat, terminals, terminalsRestored, setTerminals, setTerminalsRestored, findSession, paneLayout, pruned, setPruned, setLayout })

  const render = (item: string): PaneContent => {
    const parsed = parseItem(item)
    const gone = (title: string): PaneContent => ({ title, node: listsLoaded ? <GoneNote /> : <Loading /> })
    if (parsed === null) return gone('Unknown')
    switch (parsed.kind) {
      case 'dispatch': {
        const chat = status?.dispatches.find((entry) => entry.dispatchId === parsed.id)
        if (chat === undefined) return gone('Chat')
        return { title: chat.label ?? chat.dispatchId, node: <ChatView chat={chat} onOpenChat={openRelatedChat} onOpenPath={openPath} /> }
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
        return { title: chat.title ?? 'New chat', node: <NativeChatView chat={chat} onOpenChat={openRelatedChat} onOpenPath={openPath} onOpenArtifact={openArtifactId} onOpenNativeChat={chatBranched} /> }
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
          title: githubItemTitle(target),
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
      case 'project': {
        const project = projects.find((entry) => entry.path === parsed.id)
        if (project === undefined) return gone('Project')
        const actions: ProjectPageActions = {
          newChat: openNewChat,
          createWorktree,
          creating: creations.filter((creation) => creation.repo === project.path && creation.status !== 'failed').map((creation) => creation.branch),
          code: showCode,
          github: openGithub,
          open: openFromPage,
        }
        return { title: displayName(project), node: <ProjectPage key={project.path} project={project} chats={chatsInWorktrees} actions={actions} /> }
      }
      case 'knowledge':
        return {
          title: 'Knowledge',
          node: (
            <Suspense fallback={<Loading />}>
              <KnowledgePage view={knowledgeView(parsed.id)} projects={projects} onView={openKnowledge} onOpenGithub={maximiseGithub} onOpenArtifact={openArtifact} onOpenSettings={openKnowledgeSettings} />
            </Suspense>
          ),
        }
      case 'artifact':
        return {
          title: 'Artifacts',
          node: (
            <Suspense fallback={<Loading />}>
              <ArtifactsPage id={parsed.id} projects={projects} chats={nativeChats} onPick={openArtifact} onOpenChat={selectNativeChat} onOpenTopic={openKnowledgeTopic} />
            </Suspense>
          ),
        }
    }
  }
  // Every terminal stays mounted, shown or not, so it keeps running and reports its exit; a restored
  // one waits until a pane shows it.
  const shownItems = new Set(paneList(panes.root).map((leaf) => leaf.item))
  const backgroundTerminals = terminals.filter(mountsInBackground).map((terminal) => itemKey('terminal', terminal.id)).filter((item) => !shownItems.has(item))

  const settingsOverlay = (
    <SettingsOverlay
      open={settingsOpen}
      project={settingsProject}
      section={settingsSection}
      chat={focusedNativeChatLabel}
      onClose={() => {
        setSettingsOpen(false)
        setSettingsProject(null)
        setSettingsSection(null)
      }}
      onSetup={onSetup}
    />
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
  const usedRoots = [...new Set(leaves.map((leaf) => rootOf(leaf.item)).filter((root): root is string => root !== null && root !== ''))].sort().join('\n')
  const { holders } = useCodeLifecycle({ codeShown, codeHolders, codeTargets, setCodeTargets, idleCode, setIdleCode, setGotos, projects, usedRoots })
  const focusCodeRoot = useStableCallback((root: string) => {
    const holder = codeHolders.current[root]
    if (holder !== undefined) focusItem(holder)
  })

  const controlsFor = (root: string | null): RunControls | null =>
    root === null || root === ''
      ? null
      : {
          root,
          panel: panelFor(runs.panels, root), panelShown: root === runRoot && panelFor(runs.panels, root).open,
          run: (action, command, port) => runs.run(root, action, command, port),
          stop: (action) => {
            const tab = panelFor(runs.panels, root).tabs.find((entry) => entry.action === action)
            if (tab !== undefined) runs.stop(root, tab)
          },
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
      // Settings and a GitHub page keep ⌘1 to ⌘5 from the panes under them.
      focused: item === focusedItem && !settingsOpen && githubPage === null,
      setView: (view) => chooseItemView(item, view),
      code: <CodeSlot item={item} holder={holder} slots={codeSlots} onShowHolder={() => holder !== null && focusItem(holder)} />,
      openFile: (path) => openPath(root, path, null),
    }
  }
  // The focused pane's worktree: its run panel shows, and ⌘T opens a terminal there.
  const runRoot = githubPage !== null || focusedItem === null ? null : rootOf(focusedItem)
  const runControls = controlsFor(runRoot)
  // The window's shortcuts, by the keys Settings > Shortcuts gives them (lib/shortcuts.ts). Escape is
  // never handled here, so Code keeps it; nothing is, while Settings records a combination.
  usePaneShortcuts({ sessionRows, selectedSessionId, openSession, sidebarCollapsed, toggleSidebarCollapsed, openNewChat, runRoot, projects, panes, paneLayout, settingsOpen, setSettingsOpen, setPanes, openTerminal, closePaneById, closeFocused, splitWith })
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
          openFile: (path: string) => openPath(sharedRoot, path, null),
        }

  return (
    <div className="relative flex h-full">
      <SlidePanel open={!sidebarCollapsed} side="left" width={sidebarWidth.width} className={sidebarSurface('left')} handle={<ResizeHandle edge="right" label="Resize the sidebar" panel={sidebarWidth} />}>
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
            onGithub={openGithub}
            onOpenProject={openProject}
            selectedProject={focusedParsed?.kind === 'project' ? focusedParsed.id : null}
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
            knowledgeSelected={focusedParsed?.kind === 'knowledge'}
            onOpenKnowledge={openKnowledgeHome}
            artifactsSelected={focusedParsed?.kind === 'artifact'}
            onOpenArtifacts={openArtifacts}
          />
        </SplitRowsContext.Provider>
        <SidebarUsage onOpenSettings={() => setSettingsOpen(true)} />
      </SlidePanel>
      <main data-window-content="" className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-ink-950">
        {sidebarCollapsed && <CollapsedChrome onExpand={toggleSidebarCollapsed} onSettings={() => setSettingsOpen(true)} joined={windowRow !== null || sharedJoined} />}
        <ChatdNotice className={`${pageX} pt-3`} />
        {error !== null && (
          <div className={`${pageX} pt-4`}>
            <ErrorNote error={error} />
          </div>
        )}
        <DispatchesContext.Provider value={status?.dispatches ?? noDispatches}><CodeRootsProvider projects={listed}>
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
        </CodeRootsProvider></DispatchesContext.Provider>
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
          className={sidebarSurface('right')}
          handle={<ResizeHandle edge="left" label="Resize the run panel" panel={runPanelWidth} grip />}
        >
          {(present) =>
            runPanelRoots.map((root) => (
              <RunContext.Provider key={root} value={controlsFor(root)}><RunPanel worktree={root} panel={panelFor(runs.panels, root)} visible={present && root === runRoot} runs={runs} onEditCommands={() => runControls?.editCommands(root)} /></RunContext.Provider>
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
