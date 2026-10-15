import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import type { Project, ProjectSession, Status, Worktree } from '@/api/schema'
import { Columns } from '@/advanced/Columns'
import { chatState, groupChats, neighbour } from '@/advanced/model'
import { neighbourSession, sidebarSessionOrder } from '@/advanced/projects-model'
import { AgentBadge, StateChip, chatName } from '@/advanced/parts'
import { Sidebar, readFilters, writeFilters } from '@/advanced/Sidebar'
import { filterProjects, partitionHidden, type SidebarFilters } from '@/advanced/sidebar-model'
import { applyOrder, parseOrder } from '@/advanced/project-order'
import { CollapsedChrome, SettingsIcon, SidebarHeader, type Mode } from '@/advanced/chrome'
import { ChatView } from '@/chat/ChatView'
import type { OpenChat, OpenPath } from '@/chat/Conversation'
import { SessionView } from '@/chat/SessionView'
import { CodeFrame, type CodeGoto } from '@/code/CodeFrame'
import { CodeRail } from '@/code/CodeRail'
import { closeCode, codeTargetForRoot, emptyCodeMode, enterCode, isToggleChatsKey, leaveCode, type CodeModeState, type CodeTarget } from '@/code/code-mode-model'
import { QuickView } from '@/code/QuickView'
import { GithubPage } from '@/github/GithubPage'
import type { GithubKind } from '@/github/useGithubCounts'
import { ImportProject } from '@/import/ImportProject'
import { ErrorNote } from '@/components/ui'
import { useStatus } from '@/lib/useStatus'
import { SettingsWindow } from '@/settings/SettingsWindow'

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
type Selected = { kind: 'dispatch'; dispatchId: string } | { kind: 'session'; session: ProjectSession; worktreePath: string }

function useWorktrees(): Worktree[] {
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  useEffect(() => {
    let stopped = false
    const load = () => api.worktrees().then((value) => !stopped && setWorktrees(value), () => {})
    void load()
    const timer = setInterval(load, 30_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])
  return worktrees
}

function useProjects(): { projects: Project[]; reload: () => void } {
  const [projects, setProjects] = useState<Project[]>([])
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let stopped = false
    const load = () => api.projects().then((value) => !stopped && setProjects(value), () => {})
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [generation])
  return { projects, reload: () => setGeneration((current) => current + 1) }
}

function storedMode(): Mode {
  try {
    return localStorage.getItem('megabrain.view') === 'columns' ? 'columns' : 'sidebar'
  } catch {
    return 'sidebar'
  }
}

const orderKey = 'megabrain.sidebar.order'

function storedOrder(): string[] {
  try {
    return parseOrder(localStorage.getItem(orderKey))
  } catch {
    return []
  }
}

function storedSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem('megabrain.sidebar.hidden') === '1'
  } catch {
    return false
  }
}

// The advanced window: chats as a sidebar (repositories > worktrees > chats) or as columns (one per
// parent session), the selected chat followed live, and each project's code.
export function Advanced({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  const worktrees = useWorktrees()
  const { projects: listed, reload: reloadProjects } = useProjects()
  const [projectOrder, setProjectOrder] = useState<string[]>(storedOrder)
  // The order the person dragged the projects into; ⌘[ and ⌘] walk them the same way.
  const projects = useMemo(() => applyOrder(listed, projectOrder), [listed, projectOrder])
  const [mode, setMode] = useState<Mode>(storedMode)
  const [selected, setSelected] = useState<string | null>(null)
  const [sidebarSelected, setSidebarSelected] = useState<Selected | null>(null)
  const [quick, setQuick] = useState<CodeTarget | null>(null)
  // A project's pull request or issue page, shown in the main area over chats and the overview.
  const [githubPage, setGithubPage] = useState<{ path: string; kind: GithubKind; focus: number | null } | null>(null)
  const [codeMode, setCodeMode] = useState<CodeModeState>(emptyCodeMode)
  // The last root shown in Code mode, so the toggle key returns to it from chats.
  const [lastCode, setLastCode] = useState<CodeTarget | null>(null)
  // The file each open root was last asked to show from a chat.
  const [gotos, setGotos] = useState<Record<string, CodeGoto>>({})
  const [importing, setImporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filters, setFilters] = useState<SidebarFilters>(readFilters)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(storedSidebarCollapsed)
  const grouped = useMemo(() => groupChats(status?.dispatches ?? [], worktrees), [status, worktrees])
  const order = useMemo(() => grouped.repositories.flatMap((repository) => repository.worktrees.flatMap((worktree) => worktree.chats.map((chat) => chat.dispatchId))), [grouped])
  // ⌘[ and ⌘] walk the sessions the sidebar shows: hidden and filtered-out ones are skipped.
  const sessionRows = useMemo(() => sidebarSessionOrder(filterProjects(partitionHidden(projects).visible, filters), new Set()), [projects, filters])

  const changeMode = (next: Mode) => {
    setMode(next)
    try {
      localStorage.setItem('megabrain.view', next)
    } catch {
      // A remembered view is a convenience; the default is fine.
    }
  }

  const open = (dispatchId: string) => {
    setQuick(null)
    setGithubPage(null)
    setSelected(dispatchId)
  }

  const reorderProjects = (next: string[]) => {
    setProjectOrder(next)
    try {
      localStorage.setItem(orderKey, JSON.stringify(next))
    } catch {
      // A remembered order is a convenience; the listed order is fine.
    }
  }

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

  const openSession = (session: ProjectSession, worktreePath: string) => {
    setQuick(null)
    setGithubPage(null)
    const dispatchId = session.dispatchId
    const known = dispatchId !== null && (status?.dispatches.some((item) => item.dispatchId === dispatchId) ?? false)
    if (known && dispatchId !== null) setSidebarSelected({ kind: 'dispatch', dispatchId })
    else setSidebarSelected({ kind: 'session', session, worktreePath })
  }

  const findSession = (sessionId: string) => {
    for (const project of projects) {
      for (const worktree of project.worktrees) {
        const session = worktree.sessions.find((item) => item.sessionId === sessionId)
        if (session !== undefined) return { session, worktreePath: worktree.path }
      }
    }
    return null
  }

  const openRelatedChat: OpenChat = (target) => {
    setQuick(null)
    setGithubPage(null)
    if ('dispatchId' in target) {
      const dispatch = status?.dispatches.find((item) => item.dispatchId === target.dispatchId)
      if (dispatch !== undefined) {
        if (mode === 'columns') setSelected(dispatch.dispatchId)
        else setSidebarSelected({ kind: 'dispatch', dispatchId: dispatch.dispatchId })
        return
      }
      const session = projects
        .flatMap((project) => project.worktrees)
        .flatMap((worktree) => worktree.sessions.map((item) => ({ session: item, worktreePath: worktree.path })))
        .find((item) => item.session.dispatchId === target.dispatchId)
      if (session !== undefined) {
        setMode('sidebar')
        openSession(session.session, session.worktreePath)
      }
      return
    }

    const found = findSession(target.sessionId)
    if (found !== null) {
      setMode('sidebar')
      openSession(found.session, found.worktreePath)
      return
    }

    const [agent] = target.sessionId.split(':', 1)
    if (agent !== 'claude' && agent !== 'codex' && agent !== 'grok' && agent !== 'agy') return
    setMode('sidebar')
    openSession({
      agent,
      sessionId: target.sessionId,
      title: target.sessionId,
      status: 'idle',
      startedAt: null,
      lastActivityAt: null,
      dispatchId: null,
    }, '')
  }

  // A chat opened as a dispatch is still a session row in the sidebar; highlight and walk from it.
  const selectedSessionId =
    sidebarSelected === null
      ? null
      : sidebarSelected.kind === 'session'
        ? sidebarSelected.session.sessionId
        : (sessionRows.find((row) => row.session.dispatchId === sidebarSelected.dispatchId)?.session.sessionId ?? null)

  const openCode = (target: CodeTarget) => {
    setQuick(null)
    setLastCode(target)
    setCodeMode((current) => enterCode(current, target).state)
  }

  const openPath: OpenPath = (root, path, line) => {
    setGotos((current) => ({ ...current, [root]: { path, line } }))
    openCode(codeTargetForRoot(projects, root))
  }

  // Leaving Code mode keeps every server running; only closing a root stops its own.
  const closeCodeRoot = (root: string) => {
    const { state, stop } = closeCode(codeMode, root)
    setCodeMode(state)
    if (lastCode?.root === root) setLastCode(state.open.at(-1) ?? null)
    if (stop !== null) void api.stopCodeServer(stop).catch(() => {})
    setGotos(({ [root]: _closed, ...rest }) => rest)
  }

  const toggleCode = () => {
    if (codeMode.active !== null) setCodeMode(leaveCode)
    else if (lastCode !== null) openCode(lastCode)
  }

  const goHome = () => {
    setSidebarSelected(null)
    setSelected(null)
    setQuick(null)
    setGithubPage(null)
  }

  const openFromOverview = (dispatchId: string) => {
    if (mode === 'columns') open(dispatchId)
    else {
      setQuick(null)
      setGithubPage(null)
      setSidebarSelected({ kind: 'dispatch', dispatchId })
    }
  }

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
      if (event.metaKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebarCollapsed()
        return
      }
      if (!event.metaKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      setQuick(null)
      const step = event.key === ']' ? 1 : -1
      if (mode === 'columns') {
        setSelected((current) => neighbour(order, current, step))
        return
      }
      const next = neighbourSession(sessionRows, selectedSessionId, step)
      if (next !== null) openSession(next.session, next.worktreePath)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order, mode, sessionRows, selectedSessionId, codeMode, lastCode])

  const chat = status?.dispatches.find((item) => item.dispatchId === selected) ?? null
  const repositoryOf = (dispatchId: string) =>
    grouped.repositories.find((repository) => repository.worktrees.some((worktree) => worktree.chats.some((item) => item.dispatchId === dispatchId)))?.name ?? null

  const sidebarDispatchId = sidebarSelected?.kind === 'dispatch' ? sidebarSelected.dispatchId : null
  const sidebarDispatch = sidebarDispatchId === null ? null : status?.dispatches.find((item) => item.dispatchId === sidebarDispatchId) ?? null

  const detail =
    quick !== null ? (
      <QuickView key={quick.root} root={quick.root} title={quick.title} onClose={() => setQuick(null)} />
    ) : chat !== null ? (
      <ChatView key={chat.dispatchId} chat={chat} repository={repositoryOf(chat.dispatchId)} onOpenChat={openRelatedChat} onOpenPath={openPath} />
    ) : (
      status !== null && <Overview status={status} onSelect={openFromOverview} />
    )

  const sidebarDetail =
    quick !== null ? (
      <QuickView key={quick.root} root={quick.root} title={quick.title} onClose={() => setQuick(null)} />
    ) : sidebarDispatch !== null ? (
      <ChatView key={sidebarDispatch.dispatchId} chat={sidebarDispatch} repository={repositoryOf(sidebarDispatch.dispatchId)} onOpenChat={openRelatedChat} onOpenPath={openPath} />
    ) : sidebarSelected?.kind === 'session' ? (
      <SessionView key={sidebarSelected.session.sessionId} session={sidebarSelected.session} worktreePath={sidebarSelected.worktreePath} onOpenChat={openRelatedChat} onOpenPath={openPath} />
    ) : (
      status !== null && <Overview status={status} onSelect={openFromOverview} />
    )
  const settingsOverlay = settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} onSetup={onSetup} />

  const columnsContent =
    chat !== null || quick !== null ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => {
            setSelected(null)
            setQuick(null)
          }}
          className="self-start px-8 pt-4 text-[13px] text-ink-300 hover:text-ink-100"
        >
          ‹ Columns
        </button>
        {detail}
      </div>
    ) : (
      <Columns chats={status?.dispatches ?? []} worktrees={worktrees} selected={selected} onSelect={open} />
    )

  const inCode = codeMode.active !== null
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
      {inCode && <CodeRail state={codeMode} projects={projects} onSelect={openCode} onClose={closeCodeRoot} onChats={() => setCodeMode(leaveCode)} onSettings={() => setSettingsOpen(true)} />}
      {!inCode && !sidebarCollapsed && (
        <aside className="glass flex w-[300px] shrink-0 flex-col border-r border-white/[0.06]">
          <SidebarHeader mode={mode} onMode={changeMode} onHome={goHome} onCollapse={toggleSidebarCollapsed} />
          <Sidebar
            status={status}
            projects={projects}
            selectedSessionId={selectedSessionId}
            onSelectSession={(session) => {
              const worktree = projects.flatMap((project) => project.worktrees).find((candidate) => candidate.sessions.some((item) => item.sessionId === session.sessionId))
              changeMode('sidebar')
              openSession(session, worktree?.path ?? '')
            }}
            onCode={openCode}
            onQuickView={(target) => {
              setGithubPage(null)
              setQuick(target)
            }}
            onImport={() => setImporting(true)}
            onChanged={reloadProjects}
            order={projectOrder}
            onReorder={reorderProjects}
            filters={filters}
            onFilters={(next) => {
              setFilters(next)
              writeFilters(next)
            }}
            activeGithub={githubPage}
            onGithub={(project, kind, focus) => {
              setQuick(null)
              setGithubPage({ path: project.path, kind, focus: focus ?? null })
            }}
          />
          <footer className="shrink-0 border-t border-white/[0.06] p-2">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Settings (⌘,)"
              className="flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2 text-left text-[13px] font-medium text-ink-300 hover:bg-white/[0.06] hover:text-ink-100"
            >
              <SettingsIcon />
              Settings
            </button>
          </footer>
        </aside>
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
          {githubView ?? (mode === 'columns' ? columnsContent : sidebarDetail)}
        </div>
        {codeMode.open.map((target) => (
          <CodeFrame key={target.root} target={target} visible={target.root === codeMode.active} goto={gotos[target.root] ?? null} />
        ))}
      </main>
      {importing && <ImportProject projects={projects} onClose={() => setImporting(false)} onImported={() => {
            setImporting(false)
            reloadProjects()
          }} />}
      {settingsOverlay}
    </div>
  )
}

function Overview({ status, onSelect }: { status: Status; onSelect: (id: string) => void }) {
  const needsYou = status.dispatches.filter((item) => chatState(item) === 'needs-you')
  const working = status.dispatches.filter((item) => chatState(item) === 'working').length
  const { machine } = status
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-12 pb-10">
      <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-ink-100">{needsYou.length === 0 ? 'All clear' : `${needsYou.length} ${needsYou.length === 1 ? 'chat needs' : 'chats need'} you`}</h1>
      <p className="mt-1.5 text-[15px] text-ink-400">
        {working} working · {status.queue.length} queued{machine === null ? '' : ` · memory ${machine.pressure}, ${gib(machine.availableMemoryBytes)} free`}
      </p>
      <div className="mt-8 grid max-w-3xl gap-3">
        {needsYou.map((item) => (
          <button
            key={item.dispatchId}
            type="button"
            onClick={() => onSelect(item.dispatchId)}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 rounded-[24px] border border-white/[0.08] bg-ink-900 px-5 py-4 text-left hover:bg-ink-850"
          >
            <AgentBadge agent={item.agent ?? ''} size="lg" />
            <span className="grid min-w-0 gap-1">
              <span className="truncate text-[16px] font-semibold text-ink-100">{chatName(item)}</span>
              <span className="truncate text-[13.5px] text-ink-400">{item.supervision.finding?.errorText ?? item.supervision.finding?.recommendation ?? item.supervision.finding?.cause}</span>
            </span>
            <StateChip state="needs-you" />
          </button>
        ))}
      </div>
      <p className="mt-10 text-[13px] text-ink-400">Pick a chat on the left to follow it. ⌘[ and ⌘] move between chats.</p>
    </div>
  )
}
