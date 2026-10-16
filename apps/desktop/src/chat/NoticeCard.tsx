import { createContext, useContext, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { Dispatch } from '@/api/schema'
import { AgentIcon } from '@/components/agent-icons'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { MarkdownText } from '@/chat/markdown'
import { relayedTarget } from '@/chat/conversation-model'
import { liveNotice, noticeDispatch, type NoticeCard as NoticeCardItem, type NoticeTone } from '@/chat/notice-model'
import type { OpenChat } from '@/chat/Conversation'

/** The dispatches of the last status poll, so a notice card can say what its dispatch is doing now. */
export const DispatchesContext = createContext<readonly Dispatch[]>([])

const toneBadge: Record<NoticeTone, string> = {
  ok: 'bg-ok/[0.14] text-ok',
  accent: 'bg-accent/[0.14] text-accent',
  warn: 'bg-warn/[0.14] text-warn',
  bad: 'bg-bad/[0.14] text-bad',
  neutral: 'bg-white/[0.06] text-ink-300',
}
const toneGlyph: Record<NoticeTone, string> = { ok: '✓', accent: '?', warn: '!', bad: '✕', neutral: '•' }

// Dismissing is per viewer and only hides the card in this app; the ids live in local storage.
const dismissedKey = 'megabrain.notices.dismissed'

function readDismissed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(dismissedKey) ?? '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

function writeDismissed(id: string, dismissed: boolean) {
  const ids = readDismissed()
  if (dismissed) ids.add(id)
  else ids.delete(id)
  try {
    localStorage.setItem(dismissedKey, JSON.stringify([...ids]))
  } catch {
    // Storage may be unavailable; the card is hidden for this view only.
  }
}

type Panel = { kind: 'report' | 'terminal'; text: string | null; error: unknown } | null

function ActionButton({ children, onClick, active = false }: { children: ReactNode; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-[12px] font-semibold ${active ? 'border-white/20 bg-white/[0.1] text-ink-100' : 'border-white/10 text-ink-300 hover:bg-white/[0.08]'}`}
    >
      {children}
    </button>
  )
}

function ReplyBox({ dispatchId }: { dispatchId: string }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const send = async () => {
    const message = text.trim()
    if (message === '' || sending) return
    setSending(true)
    setError(null)
    try {
      await api.reply(dispatchId, message)
      setText('')
      setSent(true)
    } catch (caught) {
      setError(caught)
    }
    setSending(false)
  }
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 focus-within:border-white/20">
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setSent(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
          rows={1}
          placeholder="Answer the question"
          aria-label="Answer the question"
          className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-ink-100 outline-none placeholder:text-ink-500"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={text.trim() === '' || sending}
          className="h-8 shrink-0 rounded-full bg-accent px-4 text-[12.5px] font-semibold text-accent-ink hover:bg-[#a3aeff] disabled:bg-ink-700 disabled:text-ink-400"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {sent && <p className="px-1 text-[12px] text-ink-400">Sent. It reaches the chat on its next check.</p>}
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}

export function NoticeCard({ card, onOpenChat }: { card: NoticeCardItem; onOpenChat: OpenChat | undefined }) {
  const dispatches = useContext(DispatchesContext)
  const [dismissed, setDismissed] = useState(() => readDismissed().has(card.id))
  const [panel, setPanel] = useState<Panel>(null)
  const [replying, setReplying] = useState(false)
  const { notice } = card
  const live = liveNotice(notice, dispatches)
  const dispatchId = noticeDispatch(notice, dispatches)?.dispatchId ?? notice.dispatchId
  const origin = card.events.at(-1)?.origin
  const target = origin === undefined ? null : relayedTarget(origin)
  const count = card.events.length

  const dismiss = (value: boolean) => {
    writeDismissed(card.id, value)
    setDismissed(value)
  }

  const toggle = async (kind: 'report' | 'terminal') => {
    if (dispatchId === null) return
    if (panel?.kind === kind) return setPanel(null)
    setPanel({ kind, text: null, error: null })
    try {
      const text = kind === 'report' ? ((await api.readDispatchMessage(dispatchId)) ?? 'This chat sent no message.') : (await api.readChat(dispatchId, 80)).text
      setPanel((current) => (current?.kind === kind ? { kind, text, error: null } : current))
    } catch (caught) {
      setPanel((current) => (current?.kind === kind ? { kind, text: null, error: caught } : current))
    }
  }

  if (dismissed) {
    return (
      <li className="flex items-center justify-center gap-2 text-[12px] text-ink-500">
        <span className="truncate">{notice.summary}</span>
        <button type="button" onClick={() => dismiss(false)} className="shrink-0 font-semibold text-ink-400 hover:text-ink-200">
          Show
        </button>
      </li>
    )
  }

  // Actions follow what the notice said; once the dispatch finished, reading its report is what is left to do.
  const actionKind = live.kind === 'finished' ? 'finished' : notice.kind
  return (
    <li className="max-w-[85%] rounded-2xl border border-white/[0.06] bg-white/[0.03]">
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold ${toneBadge[live.tone]}`} aria-label={live.kind}>
          {toneGlyph[live.tone]}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2 text-[12px] font-semibold text-ink-300">
            {notice.agent !== null && <AgentIcon agent={notice.agent} size={13} className="text-ink-300" />}
            <span className="truncate">{notice.label ?? notice.agent ?? 'megabrain'}</span>
            {count > 1 && <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-ink-400">{count} notices</span>}
          </div>
          <p className="text-[13.5px] text-ink-100">{notice.summary}</p>
          {live.state !== null && <p className="text-[12px] text-ink-400">Now {live.state}</p>}
        </div>
        {onOpenChat !== undefined && target !== null && (
          <button
            type="button"
            onClick={() => onOpenChat(target)}
            aria-label="Open the chat"
            className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[12px] font-semibold text-ink-300 hover:bg-white/[0.08]"
          >
            →
          </button>
        )}
      </div>
      {dispatchId !== null && (
        <div className="space-y-2 px-4 pb-3 pl-13">
          <div className="flex flex-wrap gap-2">
            {actionKind === 'finished' && (
              <>
                <ActionButton onClick={() => void toggle('report')} active={panel?.kind === 'report'}>
                  View report
                </ActionButton>
                <ActionButton onClick={() => dismiss(true)}>Dismiss</ActionButton>
              </>
            )}
            {actionKind === 'ask' && (
              <ActionButton onClick={() => setReplying((value) => !value)} active={replying}>
                Reply
              </ActionButton>
            )}
            {actionKind === 'stuck' && (
              <ActionButton onClick={() => void toggle('terminal')} active={panel?.kind === 'terminal'}>
                View terminal
              </ActionButton>
            )}
          </div>
          {actionKind === 'ask' && replying && <ReplyBox dispatchId={dispatchId} />}
          {panel !== null &&
            (panel.error !== null ? (
              <ErrorNote error={panel.error} />
            ) : panel.text === null ? (
              <TextSkeleton />
            ) : panel.kind === 'report' ? (
              <div className="rounded-xl bg-white/[0.04] px-3 py-2 text-ink-200">
                <MarkdownText text={panel.text} />
              </div>
            ) : (
              <pre className="max-h-48 overflow-auto rounded-xl bg-white/[0.05] px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-ink-200">{panel.text}</pre>
            ))}
        </div>
      )}
    </li>
  )
}
