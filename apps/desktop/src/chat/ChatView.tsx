import { memo, useEffect, useRef, useState } from 'react'
import { ConversationAgent } from '@/components/agent-icons'
import { api } from '@/api'
import type { ChatRead, Dispatch, MessagePart } from '@/api/schema'
import { chatState } from '@/advanced/model'
import { chatName } from '@/advanced/parts'
import { ChatHeader } from '@/chat/ChatHeader'
import { Conversation, type OpenChat, type OpenPath } from '@/chat/Conversation'
import { TextSkeleton } from '@/components/Skeleton'
import { ErrorNote, Mono } from '@/components/ui'
import { Composer } from '@/chat/Composer'
import { messagePartsToText } from '@/chat/composer-parts'

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Memoised: a status poll that left this chat unchanged keeps the same chat object (see reuse.ts).
export const ChatView = memo(function ChatView({ chat, repository, onOpenChat, onOpenPath }: { chat: Dispatch; repository: string | null; onOpenChat?: OpenChat; onOpenPath?: OpenPath }) {
  const [read, setRead] = useState<ChatRead | null>(null)
  const [readError, setReadError] = useState<unknown>(null)
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

  // A sent message shows in the conversation; only a failure needs words.
  const send = async (parts: MessagePart[]): Promise<null> => {
    await api.reply(chat.dispatchId, messagePartsToText(parts))
    return null
  }

  const finding = chat.supervision.finding
  const [tab, setTab] = useState<'conversation' | 'terminal'>('conversation')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        agent={chat.agent ?? ''}
        activity={state === 'working' ? 'working' : state === 'needs-you' ? 'waiting' : 'idle'}
        title={chatName(chat)}
        meta={[chat.agent, chat.model, repository, `started ${time(chat.createdAt)}`, chat.owner === 'mine' ? null : 'owned by another session'].filter(Boolean).join(' · ')}
      />
      {finding !== null && (
        <div className="mx-8 mt-3 rounded-[20px] border border-warn/25 bg-warn/[0.08] px-5 py-3.5 text-[13.5px]">
          <span className="font-semibold text-warn">{finding.cause}</span>
          {finding.errorText !== undefined && <span className="text-ink-300"> · {finding.errorText}</span>}
          {finding.recommendation !== undefined && (
            <div className="mt-1.5">
              <Mono>{finding.recommendation}</Mono>
            </div>
          )}
        </div>
      )}
      <div className="mx-8 mt-3 flex gap-1 self-start rounded-full border border-white/10 bg-white/[0.05] p-1">
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
      {tab === 'conversation' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <ConversationAgent.Provider value={chat.agent ?? null}>
            <Conversation target={{ dispatchId: chat.dispatchId }} live={state !== 'ended'} onOpenChat={onOpenChat} root={chat.worktreePath ?? null} onOpenPath={onOpenPath} />
          </ConversationAgent.Provider>
        </div>
      )}
      {tab === 'terminal' && read === null && readError === null && (
        <div className="mx-8 my-5 rounded-[24px] border border-white/[0.06] bg-[#050506] px-5 py-4">
          <TextSkeleton lines={6} />
        </div>
      )}
      <pre
        hidden={tab !== 'terminal' || read === null}
        ref={pane}
        className="mx-8 my-5 min-h-0 flex-1 overflow-auto rounded-[24px] border border-white/[0.06] bg-[#050506] px-5 py-4 font-mono text-[12.5px] leading-[1.65] whitespace-pre text-ink-300 select-text"
      >
        {read?.text || '(no output yet)'}
      </pre>
      {readError !== null && (
        <div className="mx-8 -mt-2 mb-3">
          <ErrorNote error={readError} />
        </div>
      )}
      <Composer
        placeholder={state === 'ended' ? 'This chat has ended' : `Reply to ${chatName(chat)}…`}
        disabled={state === 'ended'}
        agent={chat.agent ?? null}
        cwd={chat.worktreePath ?? null}
        dispatchId={chat.dispatchId}
        model={chat.model ?? null}
        onSend={send}
      />
    </div>
  )
})
