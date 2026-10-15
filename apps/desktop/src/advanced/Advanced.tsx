import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api'
import type { ChatRead, Dispatch, Status, Worktree } from '@/api/schema'
import { chatState, groupChats, neighbour } from '@/advanced/model'
import { AgentBadge, StateChip, StateDot, chatName } from '@/advanced/parts'
import { Button, ErrorNote, Mono, Spinner } from '@/components/ui'
import { useStatus } from '@/lib/useStatus'

const folder = (path: string | null | undefined) => (path ?? '').split('/').at(-1) ?? ''
const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

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

// Repositories, their worktrees and the chats in each; the selected chat followed live.
export function Advanced({ onSetup }: { onSetup: () => void }) {
  const { status, error } = useStatus()
  const worktrees = useWorktrees()
  const [selected, setSelected] = useState<string | null>(null)
  const [showEnded, setShowEnded] = useState(false)
  const grouped = useMemo(() => groupChats(status?.dispatches ?? [], worktrees), [status, worktrees])
  const order = useMemo(() => grouped.repositories.flatMap((repository) => repository.worktrees.flatMap((worktree) => worktree.chats.map((chat) => chat.dispatchId))), [grouped])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey || (event.key !== '[' && event.key !== ']')) return
      event.preventDefault()
      setSelected((current) => neighbour(order, current, event.key === ']' ? 1 : -1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [order])

  const chat = status?.dispatches.find((item) => item.dispatchId === selected) ?? null
  const repositoryOf = (item: Dispatch) => grouped.repositories.find((repository) => repository.worktrees.some((worktree) => worktree.chats.includes(item)))?.name ?? null

  return (
    <div className="grid h-full grid-cols-[300px_minmax(0,1fr)]">
      <aside className="glass flex min-h-0 flex-col border-r border-white/[0.06]">
        <div className="flex items-center justify-between px-5 pt-11 pb-3">
          <button type="button" onClick={() => setSelected(null)} className="flex items-center gap-2.5 rounded-full text-left">
            <span className="orb size-5" />
            <span className="text-[16px] font-semibold text-ink-100">megabrain</span>
          </button>
        </div>
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4" aria-label="Chats">
          {status === null && error === null && (
            <div className="px-3 py-2">
              <Spinner />
            </div>
          )}
          {grouped.repositories.map((repository) => (
            <section key={repository.name} className="space-y-1">
              <h2 className="px-3 text-[11.5px] font-semibold tracking-[0.07em] text-ink-500 uppercase">{repository.name}</h2>
              {repository.worktrees.map((worktree) => (
                <div key={worktree.path ?? 'none'} className="space-y-0.5">
                  <div className="truncate px-3 pt-1 font-mono text-[11.5px] text-ink-500">{folder(worktree.path) || 'no worktree'}</div>
                  {worktree.chats.map((item) => (
                    <SidebarChat key={item.dispatchId} chat={item} selected={item.dispatchId === selected} onSelect={() => setSelected(item.dispatchId)} />
                  ))}
                </div>
              ))}
            </section>
          ))}
          {grouped.repositories.length === 0 && status !== null && <p className="px-3 text-[13px] text-ink-500">No open chats.</p>}
          {grouped.ended.length > 0 && (
            <section className="space-y-0.5">
              <button type="button" onClick={() => setShowEnded((value) => !value)} className="w-full rounded-xl px-3 py-1.5 text-left text-[13px] text-ink-500 hover:text-ink-300">
                {grouped.ended.length} ended, never closed {showEnded ? '▾' : '›'}
              </button>
              {showEnded && grouped.ended.map((item) => <SidebarChat key={item.dispatchId} chat={item} selected={item.dispatchId === selected} onSelect={() => setSelected(item.dispatchId)} />)}
            </section>
          )}
        </nav>
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
        {error !== null && (
          <div className="px-8 pt-10">
            <ErrorNote error={error} />
          </div>
        )}
        {chat === null ? status !== null && <Overview status={status} onSelect={setSelected} /> : <ChatView key={chat.dispatchId} chat={chat} repository={repositoryOf(chat)} />}
      </main>
    </div>
  )
}

function SidebarChat({ chat, selected, onSelect }: { chat: Dispatch; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[14px] px-3 py-2 text-left text-[14px] transition-colors ${
        selected ? 'bg-accent/[0.16] text-ink-100' : 'text-ink-200 hover:bg-white/[0.06]'
      }`}
    >
      <AgentBadge agent={chat.agent ?? ''} />
      <span className="truncate">{chatName(chat)}</span>
      <StateDot state={chatState(chat)} />
    </button>
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

function ChatView({ chat, repository }: { chat: Dispatch; repository: string | null }) {
  const [read, setRead] = useState<ChatRead | null>(null)
  const [readError, setReadError] = useState<unknown>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const pane = useRef<HTMLPreElement>(null)
  const state = chatState(chat)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const next = await api.readChat(chat.dispatchId, 400)
        if (stopped) return
        setRead(next)
        setReadError(null)
      } catch (caught) {
        if (!stopped) setReadError(caught)
      }
      if (!stopped && state !== 'ended') timer = setTimeout(tick, 2_000)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [chat.dispatchId, state])

  useEffect(() => {
    const element = pane.current
    if (element !== null) element.scrollTop = element.scrollHeight
  }, [read?.text])

  const send = () => {
    if (text.trim() === '') return
    setSending(true)
    setNotice(null)
    api
      .reply(chat.dispatchId, text.trim())
      .then(
        () => {
          setNotice({ tone: 'ok', text: 'Sent.' })
          setText('')
        },
        (error: unknown) => setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setSending(false))
  }

  const finding = chat.supervision.finding
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] px-8 pt-10 pb-5">
        <AgentBadge agent={chat.agent ?? ''} size="lg" />
        <div className="min-w-0">
          <h1 className="truncate text-[20px] font-semibold text-ink-100">{chatName(chat)}</h1>
          <p className="truncate text-[13px] text-ink-400">
            {[chat.agent, chat.model, repository, `started ${time(chat.createdAt)}`, chat.owner === 'mine' ? null : 'owned by another session'].filter(Boolean).join(' · ')}
          </p>
        </div>
        <StateChip state={state} />
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-500">
          <kbd className="rounded-lg border border-white/10 px-1.5 font-mono">⌘[</kbd>
          <kbd className="rounded-lg border border-white/10 px-1.5 font-mono">⌘]</kbd>
        </span>
      </header>
      {finding !== null && (
        <div className="mx-8 mt-5 rounded-[20px] border border-warn/25 bg-warn/[0.08] px-5 py-3.5 text-[13.5px]">
          <span className="font-semibold text-warn">{finding.cause}</span>
          {finding.errorText !== undefined && <span className="text-ink-300"> · {finding.errorText}</span>}
          {finding.recommendation !== undefined && (
            <div className="mt-1.5">
              <Mono>{finding.recommendation}</Mono>
            </div>
          )}
        </div>
      )}
      <pre
        ref={pane}
        className="mx-8 my-5 min-h-0 flex-1 overflow-auto rounded-[24px] border border-white/[0.06] bg-[#050506] px-5 py-4 font-mono text-[12.5px] leading-[1.65] whitespace-pre text-ink-300 select-text"
      >
        {read === null ? (readError === null ? 'Reading…' : '') : read.text || '(no output yet)'}
      </pre>
      {readError !== null && (
        <div className="mx-8 -mt-2 mb-3">
          <ErrorNote error={readError} />
        </div>
      )}
      <footer className="px-8 pb-6">
        {notice !== null && <p className={`mb-2 px-2 text-[13px] ${notice.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{notice.text}</p>}
        <form
          className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] py-1.5 pr-1.5 pl-5"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <input
            id="chat-reply"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={sending || state === 'ended'}
            placeholder={state === 'ended' ? 'This chat has ended' : `Reply to ${chatName(chat)}…`}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-100 outline-none placeholder:text-ink-500"
          />
          <Button variant="primary" type="submit" disabled={text.trim() === '' || sending || state === 'ended'} className="h-9 px-4">
            {sending ? <Spinner /> : 'Send'}
          </Button>
        </form>
      </footer>
    </div>
  )
}
