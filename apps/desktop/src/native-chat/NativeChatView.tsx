import { lazy, Suspense, useCallback, useState, type KeyboardEvent } from 'react'
import { api } from '@/api'
import type { MessagePart, NativeChat, TerminalSession, TranscriptEvent } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { ViewSwitch } from '@/chat/ViewSwitch'
import { Composer, type Notice } from '@/chat/Composer'
import { ApprovalRendererContext, ConversationList, type OpenChat, type OpenPath } from '@/chat/Conversation'
import { ErrorNote } from '@/components/ui'
import { terminalEngine } from '@/terminal/terminal-engine'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'
import { TranscriptSkeleton } from '@/components/Skeleton'
import { announceAction } from '@/lib/app-events'
import { ApprovalCard, type ApprovalDecision } from '@/native-chat/ApprovalCard'
import { composerContext, markAnswered, modeToggle, pendingApproval, shouldInterrupt, withModel } from '@/native-chat/chat-model'
import { useFollowChat } from '@/native-chat/useFollowChat'

// xterm loads the first time a chat moves to its terminal.
const TerminalView = lazy(() => import('@/terminal/TerminalView').then((module) => ({ default: module.TerminalView })))

// The terminal each chat handed over to, kept for the app run so reopening the chat reattaches to it.
const handedOver = new Map<string, TerminalSession>()

const folder = (path: string) => path.split('/').at(-1) ?? path

const ended = (state: NativeChat['state']) => state === 'stopped' || state === 'error'

/** A conversation megabrain owns through the agent's protocol, followed live while it is open. */
export function NativeChatView({ chat: listed, onOpenChat, onOpenPath }: { chat: NativeChat; onOpenChat?: OpenChat; onOpenPath?: OpenPath }) {
  const { state, error, update } = useFollowChat(listed)
  // The followed record is live; the listed one only fills in until the first line arrives.
  const chat = state.chat ?? listed
  const [switching, setSwitching] = useState(false)
  const [exited, setExited] = useState<number | null | undefined>(undefined)
  const toggle = modeToggle(chat)
  const inTerminal = chat.mode === 'terminal'
  const [actionError, setActionError] = useState<unknown>(null)
  const title = chat.title ?? 'New chat'
  const pending = pendingApproval(state)

  const answer = async (approvalId: string, decision: ApprovalDecision) => {
    await api.answerApproval(chat.id, approvalId, decision)
    update((current) => markAnswered(current, approvalId))
    announceAction()
  }

  // A new function whenever what is pending changes, so the cards re-render with it.
  const renderApproval = useCallback(
    (event: TranscriptEvent) => {
      const approval = state.approvals[event.id]
      if (approval === undefined) return <p className="text-center text-[12px] text-ink-400">{event.text}</p>
      return <ApprovalCard approval={approval} pending={pending?.id === approval.id} onAnswer={(decision) => answer(approval.id, decision)} />
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.approvals, pending?.id, chat.id],
  )

  const act = (run: () => Promise<void>) =>
    run().then(
      () => {
        setActionError(null)
        announceAction()
      },
      (caught: unknown) => setActionError(caught),
    )

  const send = async (parts: MessagePart[]): Promise<Notice> => {
    await api.sendChat(chat.id, parts)
    return { tone: 'ok', text: 'Sent.' }
  }

  // The CLI refuses while the agent works; the composer shows its error.
  const changeModel = async (model: string, effort: string | undefined) => {
    await api.setChatModel(chat.id, model, effort)
    update((current) => withModel(current, listed, model))
    announceAction()
  }

  const switchMode = async () => {
    if (!toggle.enabled || switching) return
    setSwitching(true)
    try {
      if (toggle.target === 'chat') {
        const terminal = handedOver.get(chat.id)
        handedOver.delete(chat.id)
        if (terminal !== undefined) await api.closeTerminal(terminal.id)
      }
      const result = await api.setChatMode(chat.id, toggle.target)
      if (result.terminal !== null) handedOver.set(chat.id, result.terminal)
      setExited(undefined)
      update((current) => ({ ...current, chat: result.chat }))
      setActionError(null)
      announceAction()
    } catch (caught) {
      setActionError(caught)
    } finally {
      setSwitching(false)
    }
  }

  // The terminal megabrain handed over, else one running the agent's own TUI on this conversation
  // with the engine chosen in settings.
  const connectTerminal = async (cols: number, rows: number): Promise<TerminalSession> => {
    const known = handedOver.get(chat.id)
    if (known !== undefined) {
      await api.resizeTerminal(known.id, cols, rows).catch(() => {})
      return known
    }
    const [command, engine] = await Promise.all([api.chatTerminalCommand(chat.id), terminalEngine()])
    const terminal = await api.openTerminal({ engine, cwd: chat.cwd, command, cols, rows })
    handedOver.set(chat.id, terminal)
    return terminal
  }

  // Esc in an empty composer stops the agent's turn; the composer keeps every other key.
  const onComposerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const box = event.target
    if (event.defaultPrevented || !(box instanceof HTMLElement) || !box.isContentEditable) return
    if (!shouldInterrupt(event.key, box.textContent ?? '', chat.state)) return
    event.preventDefault()
    void act(() => api.interruptChat(chat.id))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={chat.agent}
        title={title}
        meta={[chat.agent, chat.model, folder(chat.cwd)].filter(Boolean).join(' · ')}
        metaTitle={chat.cwd}
        actions={<ViewSwitch view={chat.mode} enabled={toggle.enabled && !switching} reason={toggle.reason} switching={switching} onView={() => void switchMode()} />}
      />
      {(error !== null || actionError !== null) && (
        <div className="mx-8 mt-3 space-y-2">
          {error !== null && <ErrorNote error={error} />}
          {actionError !== null && <ErrorNote error={actionError} />}
        </div>
      )}
      {inTerminal ? (
        <>
          {exited !== undefined && (
            <p className="mx-8 mt-3 text-[13px] text-ink-400">
              The terminal exited{exited === null ? '' : ` with code ${exited}`}. Switch back to Chat to continue here.
            </p>
          )}
          <Suspense fallback={<TerminalSkeleton label={`Opening ${chat.agent} in its terminal`} />}>
            <TerminalView key={chat.id} connect={connectTerminal} onExit={(code) => setExited(code)} startingLabel={`Opening ${chat.agent} in its terminal`} />
          </Suspense>
        </>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            <ApprovalRendererContext.Provider value={renderApproval}>
              {/* Until the first line of the follow arrives the history is still being read. */}
              {state.cursor === null && state.events.length === 0 && error === null ? (
                <TranscriptSkeleton />
              ) : (
                <ConversationList events={state.events} onOpenChat={onOpenChat} root={chat.cwd} onOpenPath={onOpenPath} />
              )}
            </ApprovalRendererContext.Provider>
          </div>
          {pending !== null && <p className="mx-8 -mb-1 px-3 text-[12.5px] text-warn">{pending.tool} waits for your approval above.</p>}
          <div onKeyDown={onComposerKey} className="contents">
            <Composer
              placeholder={ended(chat.state) ? 'This chat has stopped' : chat.state === 'working' ? `Reply to ${title}… (Esc stops the turn)` : `Reply to ${title}…`}
              disabled={ended(chat.state)}
              agent={chat.agent}
              cwd={chat.cwd}
              context={composerContext(chat)}
              model={chat.model}
              onModelChange={changeModel}
              onSend={send}
            />
          </div>
        </>
      )}
    </div>
  )
}

/** Chat or Terminal: who drives the conversation. Moving to the terminal waits for an idle agent. */
