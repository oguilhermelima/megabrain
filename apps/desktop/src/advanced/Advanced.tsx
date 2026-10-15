import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import type { Project, ProjectSession, Status, Worktree } from '@/api/schema'
import { Columns } from '@/advanced/Columns'
import { chatState, groupChats, neighbour } from '@/advanced/model'
import { neighbourSession, sidebarSessionOrder } from '@/advanced/projects-model'
import { AgentBadge, StateChip, chatName } from '@/advanced/parts'
import { Sidebar, type CodeTarget } from '@/advanced/Sidebar'
import { CollapsedChrome, SidebarHeader, type Mode } from '@/advanced/chrome'
import { ChatView } from '@/chat/ChatView'
import type { OpenChat } from '@/chat/Conversation'
import { SessionView } from '@/chat/SessionView'
import { CodeView } from '@/code/CodeView'
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

function useProjects(): Project[] {
  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    let stopped = false
    const load = () => api.projects().then((value) => !stopped && setProjects(value), () => {})
    void load()
    const timer = setInterval(load, 5_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [])
  return projects
}

function storedMode(): Mode {
  try {
    return localStorage.getItem('megabrain.view') === 'columns' ? 'columns' : 'sidebar'
  } catch {
    return 'sidebar'
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
  const projects = useProjects()
  const [mode, setMode] = useState<Mode>(storedMode)
  const [selected, setSelected] = useState<string | null>(null)
  const [sidebarSelected, setSidebarSelected] = useState<Selected | null>(null)
  const [code, setCode] = useState<CodeTarget | null>(null)
  const [importing, setImporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(storedSidebarCollapsed)
  const grouped = useMemo(() => groupChats(status?.dispatches ?? [], worktrees), [status, worktrees])
  const order = useMemo(() => grouped.repositories.flatMap((repository) => repository.worktrees.flatMap((worktree) => worktree.chats.map((chat) => chat.dispatchId))), [grouped])
  const sessionRows = useMemo(() => sidebarSessionOrder(projects, new Set()), [projects])

  const changeMode = (next: Mode) => {
    setMode(next)
    try {
      localStorage.setItem('megabrain.view', next)
    } catch {
      // A remembered view is a convenience; the default is fine.
    }
  }

  const open = (dispatchId: string) => {
    setCode(null)
    setSelected(dispatchId)
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
    setCode(null)
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
    setCode(null)
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

  const goHome = () => {
    setSidebarSelected(null)
    setSelected(null)
    setCode(null)
  }

  const openFromOverview = (dispatchId: string) => {
    if (mode === 'columns') open(dispatchId)
    else {
      setCode(null)
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
      if (event.metaKey && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleSidebarCollapsed()
        return
      }
      if (!event.metaKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      setCode(null)
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
  }, [order, mode, sessionRows, selectedSessionId])

  const chat = status?.dispatches.find((item) => item.dispatchId === selected) ?? null
  const repositoryOf = (dispatchId: string) =>
    grouped.repositories.find((repository) => repository.worktrees.some((worktree) => worktree.chats.some((item) => item.dispatchId === dispatchId)))?.name ?? null

  const sidebarDispatchId = sidebarSelected?.kind === 'dispatch' ? sidebarSelected.dispatchId : null
  const sidebarDispatch = sidebarDispatchId === null ? null : status?.dispatches.find((item) => item.dispatchId === sidebarDispatchId) ?? null

  const detail =
    code !== null ? (
      <CodeView key={code.root} root={code.root} title={code.title} onClose={() => setCode(null)} />
    ) : chat !== null ? (
      <ChatView key={chat.dispatchId} chat={chat} repository={repositoryOf(chat.dispatchId)} onOpenChat={openRelatedChat} />
    ) : (
      status !== null && <Overview status={status} onSelect={openFromOverview} />
    )

  const sidebarDetail =
    code !== null ? (
      <CodeView key={code.root} root={code.root} title={code.title} onClose={() => setCode(null)} />
    ) : sidebarDispatch !== null ? (
      <ChatView key={sidebarDispatch.dispatchId} chat={sidebarDispatch} repository={repositoryOf(sidebarDispatch.dispatchId)} onOpenChat={openRelatedChat} />
    ) : sidebarSelected?.kind === 'session' ? (
      <SessionView key={sidebarSelected.session.sessionId} session={sidebarSelected.session} worktreePath={sidebarSelected.worktreePath} onOpenChat={openRelatedChat} />
    ) : (
      status !== null && <Overview status={status} onSelect={openFromOverview} />
    )
  const watcherOn = status?.supervisor.watcher.running === true
  const settingsOverlay = settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />

  const columnsContent =
    chat !== null || code !== null ? (
      <div className="flex min-h-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => {
            setSelected(null)
            setCode(null)
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

  return (
    <div className="relative flex h-full">
      {!sidebarCollapsed && (
        <aside className="glass flex w-[300px] shrink-0 flex-col border-r border-white/[0.06]">
          <SidebarHeader mode={mode} onMode={changeMode} onHome={goHome} onCollapse={toggleSidebarCollapsed} onSettings={() => setSettingsOpen(true)} />
          <Sidebar
            status={status}
            projects={projects}
            selectedSessionId={selectedSessionId}
            onSelectSession={(session) => {
              const worktree = projects.flatMap((project) => project.worktrees).find((candidate) => candidate.sessions.some((item) => item.sessionId === session.sessionId))
              changeMode('sidebar')
              openSession(session, worktree?.path ?? '')
            }}
            onCode={setCode}
            onImport={() => setImporting(true)}
          />
          <footer className="flex shrink-0 items-center justify-between border-t border-white/[0.06] px-5 py-2.5 text-[12px] text-ink-400">
            <span className="flex items-center gap-2" title={`The watcher reports stuck or finished chats; it is ${watcherOn ? 'running' : 'stopped'}.`}>
              <span className={`size-2 rounded-full ${watcherOn ? 'bg-ok' : 'bg-bad'}`} />
              watcher {watcherOn ? 'on' : 'off'}
            </span>
            <button type="button" onClick={onSetup} className="rounded-full px-2 py-1 hover:bg-white/[0.06] hover:text-ink-200">
              Run setup
            </button>
          </footer>
        </aside>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-950">
        {sidebarCollapsed && <CollapsedChrome onExpand={toggleSidebarCollapsed} />}
        {error !== null && (
          <div className="px-8 pt-4">
            <ErrorNote error={error} />
          </div>
        )}
        {mode === 'columns' ? columnsContent : sidebarDetail}
      </main>
      {importing && <ImportProject projects={projects} onClose={() => setImporting(false)} onImported={() => setImporting(false)} />}
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
