import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { PillGeometry } from '@/api/adapter'
import type { Dispatch } from '@/api/schema'
import { chatState, pillSummary } from '@/advanced/model'
import { useStatus } from '@/lib/useStatus'
import { AgentBadge, chatName } from '@/advanced/parts'

// The pill sits over the notch: black, joined to the top of the screen, with the counts on either
// side of the camera. It grows into the assistant with ⌥Space or a click.
export function Pill() {
  const [expanded, setExpanded] = useState(false)
  const [geometry, setGeometry] = useState<PillGeometry>({ notchWidth: null, barHeight: 34 })
  const { status } = useStatus(expanded ? 2_000 : 5_000)

  useEffect(() => {
    void api.pillGeometry().then(setGeometry)
    return api.onPillExpanded(setExpanded)
  }, [])

  const chats = status?.dispatches ?? []
  const summary = pillSummary(chats)
  return expanded ? (
    <Assistant chats={chats} barHeight={geometry.barHeight} />
  ) : (
    <button
      type="button"
      onClick={() => void api.setPillExpanded(true)}
      className="flex w-full items-center justify-between rounded-b-[18px] bg-ink-950 px-4 text-[13px] font-semibold"
      style={{ height: geometry.barHeight }}
      aria-label="Open megabrain"
    >
      <span className="flex items-center gap-2 text-ink-300">
        <span className={`orb size-3.5 ${summary.working === 0 ? 'idle' : ''}`} />
        {summary.working === 0 ? 'quiet' : `${summary.working} working`}
      </span>
      {geometry.notchWidth !== null && <span style={{ width: geometry.notchWidth }} />}
      <span className={`flex items-center gap-1.5 ${summary.needsYou > 0 ? 'text-warn' : 'text-ink-400'}`}>
        <span className="size-[7px] rounded-full bg-current" />
        {summary.needsYou > 0 ? `${summary.needsYou} ${summary.needsYou === 1 ? 'needs' : 'need'} you` : summary.queued > 0 ? `${summary.queued} queued` : 'all clear'}
      </span>
    </button>
  )
}

function Assistant({ chats, barHeight }: { chats: Dispatch[]; barHeight: number }) {
  const needsYou = chats.filter((chat) => chatState(chat) === 'needs-you')
  const working = chats.filter((chat) => chatState(chat) === 'working')
  const [selected, setSelected] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const target = chats.find((chat) => chat.dispatchId === selected) ?? null

  useEffect(() => {
    input.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void api.setPillExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const send = () => {
    if (target === null || text.trim() === '') return
    setSending(true)
    setNotice(null)
    api
      .reply(target.dispatchId, text.trim())
      .then(
        () => {
          setNotice({ tone: 'ok', text: `Sent to ${chatName(target)}` })
          setText('')
        },
        (error: unknown) => setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setSending(false))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-b-[32px] border border-t-0 border-white/[0.1] bg-ink-950">
      <div style={{ height: barHeight }} className="shrink-0" />
      <header className="flex items-center gap-3 px-6 pt-2 pb-4">
        <span className={`orb size-[22px] ${working.length === 0 ? 'idle' : ''}`} />
        <h1 className="text-[18px] font-semibold text-ink-100">megabrain</h1>
        <span className="ml-auto rounded-lg border border-white/10 px-2 py-0.5 font-mono text-[12px] text-ink-400">⌥ Space</span>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4">
        <Section title={needsYou.length === 0 ? 'Nothing needs you' : 'Needs you'}>
          {needsYou.map((chat) => (
            <ChatRow key={chat.dispatchId} chat={chat} selected={chat.dispatchId === selected} onSelect={() => setSelected(chat.dispatchId === selected ? null : chat.dispatchId)}>
              <span className="truncate text-[13px] text-ink-400">{chat.supervision.finding?.errorText ?? chat.supervision.finding?.recommendation ?? chat.supervision.finding?.cause}</span>
            </ChatRow>
          ))}
        </Section>
        <Section title={`Working · ${working.length}`}>
          {working.map((chat) => (
            <ChatRow key={chat.dispatchId} chat={chat} selected={chat.dispatchId === selected} onSelect={() => setSelected(chat.dispatchId === selected ? null : chat.dispatchId)}>
              <span className="truncate text-[13px] text-ink-400">{chat.agent} · {chat.model}</span>
            </ChatRow>
          ))}
        </Section>
      </div>

      <footer className="space-y-3 px-4 pt-3 pb-4">
        {notice !== null && <p className={`px-2 text-[13px] ${notice.tone === 'ok' ? 'text-ok' : 'text-bad'}`}>{notice.text}</p>}
        <form
          className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] py-1.5 pr-1.5 pl-5"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <input
            ref={input}
            id="assistant-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={sending}
            placeholder={target === null ? 'Pick a chat to reply to — plain-language requests come next' : `Reply to ${chatName(target)}…`}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-100 outline-none placeholder:text-ink-400"
          />
          <button
            type="submit"
            disabled={target === null || text.trim() === '' || sending}
            aria-label="Send"
            className="grid size-9 place-items-center rounded-full bg-accent text-[16px] font-bold text-accent-ink disabled:bg-ink-700 disabled:text-ink-500"
          >
            ↑
          </button>
        </form>
        <div className="flex justify-end">
          <button type="button" onClick={() => void api.openMain()} className="h-9 rounded-full border border-white/15 bg-white/[0.07] px-4 text-[13px] font-semibold text-ink-100 hover:bg-white/[0.12]">
            Advanced
          </button>
        </div>
      </footer>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h2 className="px-2 text-[12px] font-semibold tracking-[0.06em] text-ink-400 uppercase">{title}</h2>
      {children}
    </section>
  )
}

function ChatRow({ chat, selected, onSelect, children }: { chat: Dispatch; selected: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-[18px] border px-3 py-2.5 text-left transition-colors ${
        selected ? 'border-accent/50 bg-accent/[0.12]' : 'border-white/[0.06] bg-white/[0.04] hover:bg-white/[0.07]'
      }`}
    >
      <AgentBadge agent={chat.agent ?? ''} size="lg" />
      <span className="grid min-w-0">
        <span className="truncate text-[14.5px] font-semibold text-ink-100">{chatName(chat)}</span>
        {children}
      </span>
    </button>
  )
}
