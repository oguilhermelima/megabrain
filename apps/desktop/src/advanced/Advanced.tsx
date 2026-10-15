import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import type { Status, Worktree } from '@/api/schema'
import { Columns } from '@/advanced/Columns'
import { chatState, groupChats, neighbour } from '@/advanced/model'
import { AgentBadge, StateChip, chatName } from '@/advanced/parts'
import { Sidebar, type CodeTarget } from '@/advanced/Sidebar'
import { ChatView } from '@/chat/ChatView'
import { CodeView } from '@/code/CodeView'
import { ErrorNote } from '@/components/ui'
import { useStatus } from '@/lib/useStatus'

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
type Mode = 'sidebar' | 'columns'

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

function storedMode(): Mode {
  try {
    return localStorage.getItem('megabrain.view') === 'columns' ? 'columns' : 'sidebar'
  } catch {
    return 'sidebar'
  }
}

// The advanced window: chats as a sidebar (repositories > worktrees > chats) or as columns (one per
// parent session), the selected chat followed live, and each project's code.
export function Advanced({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  const worktrees = useWorktrees()
  const [mode, setMode] = useState<Mode>(storedMode)
  const [selected, setSelected] = useState<string | null>(null)
  const [code, setCode] = useState<CodeTarget | null>(null)
  const grouped = useMemo(() => groupChats(status?.dispatches ?? [], worktrees), [status, worktrees])
  const order = useMemo(() => grouped.repositories.flatMap((repository) => repository.worktrees.flatMap((worktree) => worktree.chats.map((chat) => chat.dispatchId))), [grouped])
  const repositoryPaths = useMemo(() => new Map(worktrees.flatMap((worktree) => (worktree.repository === undefined ? [] : [[worktree.repository.name, worktree.repository.path] as const]))), [worktrees])

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      setCode(null)
      setSelected((current) => neighbour(order, current, event.key === ']' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order])

  const chat = status?.dispatches.find((item) => item.dispatchId === selected) ?? null
  const repositoryOf = (dispatchId: string) =>
    grouped.repositories.find((repository) => repository.worktrees.some((worktree) => worktree.chats.some((item) => item.dispatchId === dispatchId)))?.name ?? null

  const toggle = (
    <div className="flex gap-1 rounded-full border border-white/10 bg-white/[0.05] p-1" role="group" aria-label="View">
      {(['sidebar', 'columns'] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => changeMode(value)}
          aria-pressed={mode === value}
          className={`h-7 rounded-full px-3 text-[12.5px] font-semibold capitalize ${mode === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
        >
          {value}
        </button>
      ))}
    </div>
  )

  const detail =
    code !== null ? (
      <CodeView key={code.root} root={code.root} title={code.title} onClose={() => setCode(null)} />
    ) : chat !== null ? (
      <ChatView key={chat.dispatchId} chat={chat} repository={repositoryOf(chat.dispatchId)} />
    ) : (
      status !== null && <Overview status={status} onSelect={open} />
    )

  if (mode === 'columns')
    return (
      <div className="flex h-full flex-col bg-ink-950">
        <header className="glass flex items-center justify-between border-b border-white/[0.06] pt-9 pr-5 pb-3 pl-24">
          <span className="flex items-center gap-2.5">
            <span className="orb size-5" />
            <span className="text-[16px] font-semibold text-ink-100">megabrain</span>
          </span>
          {toggle}
        </header>
        {error !== null && (
          <div className="px-8 pt-4">
            <ErrorNote error={error} />
          </div>
        )}
        <div className="min-h-0 flex-1">
          {chat !== null || code !== null ? (
            <div className="flex h-full flex-col">
              <button type="button" onClick={() => { setSelected(null); setCode(null) }} className="self-start px-8 pt-4 text-[13px] text-ink-400 hover:text-ink-200">
                ‹ Columns
              </button>
              {detail}
            </div>
          ) : (
            <Columns chats={status?.dispatches ?? []} worktrees={worktrees} selected={selected} onSelect={open} />
          )}
        </div>
      </div>
    )

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)]">
      <aside className="glass flex min-h-0 flex-col border-r border-white/[0.06]">
        <div className="flex items-center justify-between px-5 pt-11 pb-3">
          <button type="button" onClick={() => { setSelected(null); setCode(null) }} className="flex items-center gap-2.5 rounded-full text-left">
            <span className="orb size-5" />
            <span className="text-[16px] font-semibold text-ink-100">megabrain</span>
          </button>
        </div>
        <Sidebar status={status} repositories={grouped.repositories} repositoryPaths={repositoryPaths} worktrees={worktrees} ended={grouped.ended} selected={selected} onSelect={open} onCode={setCode} />
        <footer className="flex items-center justify-between border-t border-white/[0.06] px-5 py-3 text-[12px] text-ink-500">
          <span className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${status?.supervisor.watcher.running === true ? 'bg-ok' : 'bg-bad'}`} />
            watcher {status?.supervisor.watcher.running === true ? 'on' : 'off'}
          </span>
          <button type="button" onClick={onSetup} className="rounded-full px-2 py-1 hover:text-ink-200">
            Run setup
          </button>
        </footer>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-col bg-ink-950">
        <div className="flex justify-end px-5 pt-3">{toggle}</div>
        {error !== null && (
          <div className="px-8 pt-4">
            <ErrorNote error={error} />
          </div>
        )}
        {detail}
      </main>
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
      <p className="mt-10 text-[13px] text-ink-500">Pick a chat on the left to follow it. ⌘[ and ⌘] move between chats.</p>
    </div>
  )
}
