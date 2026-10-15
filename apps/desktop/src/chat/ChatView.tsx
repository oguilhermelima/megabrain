import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { ChatRead, Dispatch } from '@/api/schema'
import { chatState } from '@/advanced/model'
import { AgentBadge, StateChip, chatName } from '@/advanced/parts'
import { Conversation } from '@/chat/Conversation'
import { Button, ErrorNote, Mono, Spinner } from '@/components/ui'

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function ChatView({ chat, repository }: { chat: Dispatch; repository: string | null }) {
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
  const [tab, setTab] = useState<'conversation' | 'terminal'>('conversation')
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
      <div className="mx-8 mt-5 flex gap-1 self-start rounded-full border border-white/10 bg-white/[0.05] p-1">
        {(['conversation', 'terminal'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`h-8 rounded-full px-4 text-[13px] font-semibold capitalize ${tab === value ? 'bg-white/[0.14] text-ink-100' : 'text-ink-400 hover:text-ink-200'}`}
          >
            {value}
          </button>
        ))}
      </div>
      {tab === 'conversation' && <Conversation target={{ dispatchId: chat.dispatchId }} live={state !== 'ended'} />}
      <pre
        hidden={tab !== 'terminal'}
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
