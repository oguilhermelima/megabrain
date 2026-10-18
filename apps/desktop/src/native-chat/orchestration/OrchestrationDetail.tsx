import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import { AgentIcon } from '@/components/agent-icons'
import { Button, ErrorNote } from '@/components/ui'
import { StateChip } from '@/native-chat/orchestration/OrchestrationCard'
import { dispatchOf } from '@/native-chat/orchestration/orchestration-layout'
import type { OrchestrationNode } from '@/api/schema'

const NOT_YET = 'Not available yet'

// A disabled button takes no pointer events, so its reason sits on a wrapper that does.
function Action({ reason, onClick, children }: { reason: string | null; onClick?: () => void; children: ReactNode }) {
  return (
    <span title={reason ?? undefined}>
      <Button disabled={reason !== null} onClick={onClick}>
        {children}
      </Button>
    </span>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-chat-label font-semibold tracking-wide text-ink-400 uppercase">{label}</span>
      <span className="min-w-0 font-mono text-chat-small break-all text-ink-200 select-text">{children}</span>
    </div>
  )
}

/**
 * One node in full: its whole last message, where it runs, and what can be done to it. Read terminal
 * and Reply reach a lane through its dispatch (Reply reaches a coordinator through its session);
 * Change direction and Close have no app action yet and say so.
 */
export function OrchestrationDetail({ node, onOpen, onClose }: { node: OrchestrationNode; onOpen: (() => void) | null; onClose: () => void }) {
  const dispatch = dispatchOf(node)
  const [message, setMessage] = useState<string | null>(null)
  const [terminal, setTerminal] = useState<string | null>(null)
  const [replying, setReplying] = useState(false)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)

  // The card shows the first 200 characters; the dispatch's record has the whole message.
  useEffect(() => {
    let stopped = false
    setMessage(null)
    setTerminal(null)
    setReplying(false)
    setSent(null)
    setError(null)
    if (dispatch !== null) api.readDispatchMessage(dispatch).then((text) => !stopped && setMessage(text), () => {})
    return () => {
      stopped = true
    }
  }, [dispatch, node.last?.at])

  const readTerminal = () => {
    if (dispatch === null) return
    setError(null)
    api.readChat(dispatch, 200).then((read) => setTerminal(read.text || '(no output yet)'), setError)
  }

  const replyTarget = dispatch ?? node.session
  const send = async () => {
    const text = draft.trim()
    if (text === '' || replyTarget === null) return
    setSending(true)
    setError(null)
    try {
      if (dispatch !== null) await api.reply(dispatch, text)
      else if (node.session !== null) {
        const result = await api.sendToSession(node.session, text)
        if (!result.delivered) throw new Error(result.detail ?? `Not delivered (${result.channel}).`)
      }
      setDraft('')
      setReplying(false)
      setSent('Sent.')
    } catch (caught) {
      setError(caught)
    } finally {
      setSending(false)
    }
  }

  const lastText = message ?? node.last?.text ?? null
  return (
    <aside aria-label={`${node.label} details`} className="flex min-h-0 flex-col gap-3 overflow-y-auto border-white/[0.07] bg-ink-900 p-4">
      <div className="flex min-w-0 items-center gap-2">
        <AgentIcon agent={node.agent} />
        <h3 className="min-w-0 flex-1 truncate text-chat-ui font-semibold text-ink-100" title={node.label}>
          {node.label}
        </h3>
        <StateChip state={node.state} />
        <button type="button" aria-label="Close details" onClick={onClose} className="rounded-full px-2 text-ink-400 hover:bg-white/[0.07] hover:text-ink-100">
          ×
        </button>
      </div>
      {node.unanswered && <p className="text-chat-small font-semibold text-warn">Waiting for an answer from its coordinator.</p>}
      {node.finding !== null && <p className="text-chat-small text-warn">{node.finding}</p>}
      {lastText !== null && (
        <div className="flex flex-col gap-1">
          <span className="text-chat-label font-semibold tracking-wide text-ink-400 uppercase">Last message{node.last === null ? '' : ` · ${node.last.type}`}</span>
          <p className="text-chat-small whitespace-pre-wrap text-ink-200 select-text">{lastText}</p>
        </div>
      )}
      {node.worktree !== null && <Field label="Worktree">{node.worktree}</Field>}
      {node.branch !== null && <Field label="Branch">{node.commits === null ? node.branch : `${node.branch} · ${node.commits === 1 ? '1 commit' : `${node.commits} commits`}`}</Field>}
      {(node.model !== null || node.effort !== null) && <Field label="Model">{[node.model, node.effort].filter((part) => part !== null).join(' · ')}</Field>}
      <div className="flex flex-wrap gap-2">
        {onOpen !== null && <Button onClick={onOpen}>Open chat</Button>}
        <Action reason={dispatch === null ? `${NOT_YET} for a session that is not a dispatch` : null} onClick={readTerminal}>
          Read terminal
        </Action>
        <Action reason={replyTarget === null ? `${NOT_YET} for a chat with no session` : null} onClick={() => setReplying((current) => !current)}>
          Reply
        </Action>
        <Action reason={NOT_YET}>Change direction</Action>
        <Action reason={NOT_YET}>Close</Action>
      </div>
      {replying && (
        <div className="flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send()
            }}
            rows={3}
            placeholder={`Reply to ${node.label}…`}
            className="w-full resize-y rounded-[14px] border border-white/10 bg-ink-850 px-3 py-2 text-chat-small text-ink-100 outline-none focus:border-accent/60"
          />
          <Button disabled={sending || draft.trim() === ''} onClick={() => void send()} className="self-end">
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      )}
      {sent !== null && <p className="text-chat-small text-ok">{sent}</p>}
      {error !== null && <ErrorNote error={error} />}
      {terminal !== null && <pre className="max-h-72 overflow-auto rounded-[14px] border border-white/[0.06] bg-[#050506] px-3 py-2 font-mono text-chat-label leading-[1.6] whitespace-pre text-ink-300 select-text">{terminal}</pre>}
    </aside>
  )
}
