import { useState } from 'react'
import { api } from '@/api'
import type { ProjectSession } from '@/api/schema'
import { AgentBadge } from '@/advanced/parts'
import { Conversation, type OpenChat } from '@/chat/Conversation'
import { Button, Spinner } from '@/components/ui'

const folder = (path: string) => path.split('/').at(-1) ?? path

const statusTone: Record<ProjectSession['status'], string> = {
  working: 'text-ok bg-ok/[0.12]',
  waiting: 'text-warn bg-warn/[0.12]',
  idle: 'text-ink-300 bg-white/[0.06]',
  ended: 'text-ink-400 bg-white/[0.06]',
}

export function SessionView({
  session,
  worktreePath,
  onOpenChat,
}: {
  session: ProjectSession
  worktreePath: string
  onOpenChat?: OpenChat
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const ended = session.status === 'ended'
  const started = session.startedAt === null ? null : `started ${new Date(session.startedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`

  const send = () => {
    if (text.trim() === '') return
    setSending(true)
    setNotice(null)
    api
      .sendToSession(session.sessionId, text.trim())
      .then(
        (result) => {
          setNotice(result.delivered ? { tone: 'ok', text: `Delivered through ${result.channel}.` } : { tone: 'bad', text: result.detail ?? `Not delivered (${result.channel}).` })
          if (result.delivered) setText('')
        },
        (error: unknown) => setNotice({ tone: 'bad', text: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setSending(false))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header data-tauri-drag-region className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] px-8 pt-10 pb-5">
        <AgentBadge agent={session.agent} size="lg" />
        <div className="min-w-0">
          <h1 title={session.title} className="truncate text-[20px] font-semibold tracking-[-0.01em] text-ink-100">{session.title}</h1>
          <p title={worktreePath} className="truncate text-[13px] text-ink-400">{[session.agent, folder(worktreePath), started].filter(Boolean).join(' · ')}</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-[12px] font-semibold whitespace-nowrap ${statusTone[session.status]}`}>{session.status}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[12px] text-ink-400" title="Previous and next chat">
          <kbd className="rounded-lg border border-white/10 px-1.5 font-mono">⌘[</kbd>
          <kbd className="rounded-lg border border-white/10 px-1.5 font-mono">⌘]</kbd>
        </span>
      </header>
      <Conversation target={{ sessionId: session.sessionId }} live={!ended} onOpenChat={onOpenChat} />
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
            id="session-reply"
            value={text}
            onChange={(event) => setText(event.target.value)}
            disabled={sending || ended}
            placeholder={ended ? 'This session has ended' : `Reply to ${session.title}…`}
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink-100 outline-none placeholder:text-ink-400"
          />
          <Button variant="primary" type="submit" disabled={text.trim() === '' || sending || ended} className="h-9 px-4">
            {sending ? <Spinner /> : 'Send'}
          </Button>
        </form>
      </footer>
    </div>
  )
}
