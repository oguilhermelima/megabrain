import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import type { MessagePart, NativeChat, OrchestrationNode, TranscriptEvent } from '@/api/schema'
import { Composer } from '@/chat/Composer'
import { useComposeChannel } from '@/chat/chat-menu'
import { messagePartsToText } from '@/chat/composer-parts'
import { Conversation, ConversationList, type OpenChat } from '@/chat/Conversation'
import { ConversationAgent } from '@/components/agent-icons'
import { TranscriptSkeleton } from '@/components/Skeleton'
import { ErrorNote } from '@/components/ui'
import { pageMx } from '@/lib/page'
import { liveTail } from '@/native-chat/chat-model'
import { useFollowChat } from '@/native-chat/useFollowChat'
import { laneEvents, nodeChat } from '@/native-chat/orchestration/orchestration-chat'

const ended = (node: OrchestrationNode) => node.state === 'done' || node.state === 'closed' || node.state === 'failed'

// An app chat, followed live as its own view follows it, with a composer that sends into it.
function AppChat({ chat, onOpenChat }: { chat: NativeChat; onOpenChat?: OpenChat }) {
  const { state } = useFollowChat(chat)
  const compose = useComposeChannel()
  const live = useMemo(() => liveTail(state), [state])
  const current = state.chat ?? chat
  const busy = current.state === 'working' || current.state === 'waiting-approval'
  // The chat's user event shows the message once chatd takes it; a refusal stays in the box.
  const send = async (parts: MessagePart[]): Promise<null> => {
    await api.sendChat(current.id, parts)
    return null
  }
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationAgent.Provider value={current.agent}>
          <ConversationList events={state.events} live={live} onOpenChat={onOpenChat} root={current.cwd} channel={compose} busy={busy} />
        </ConversationAgent.Provider>
      </div>
      <Composer placeholder="Message…" disabled={false} agent={current.agent} cwd={current.cwd} model={current.model ?? null} onSend={send} running={busy} onStop={() => void api.interruptChat(current.id)} channel={compose} />
    </>
  )
}

function AppChatLoader({ chatId, onOpenChat }: { chatId: string; onOpenChat?: OpenChat }) {
  const [chat, setChat] = useState<NativeChat | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let stopped = false
    setChat(null)
    setError(null)
    api.chats().then(
      (chats) => {
        if (stopped) return
        const found = chats.find((entry) => entry.id === chatId)
        if (found === undefined) setError(new Error('That chat is no longer in the app.'))
        else setChat(found)
      },
      (caught: unknown) => !stopped && setError(caught),
    )
    return () => {
      stopped = true
    }
  }, [chatId])
  if (error !== null) return <div className={`${pageMx} my-4`}><ErrorNote error={error} /></div>
  if (chat === null) return <TranscriptSkeleton />
  return <AppChat key={chat.id} chat={chat} onOpenChat={onOpenChat} />
}

// A lane's messages with its coordinator, read again whenever the graph reports a newer one, and a
// composer whose message is the coordinator's reply.
function LaneChat({ node, dispatch, onOpenChat }: { node: OrchestrationNode; dispatch: string; onOpenChat?: OpenChat }) {
  const [events, setEvents] = useState<TranscriptEvent[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [sent, setSent] = useState(0)
  const compose = useComposeChannel()
  useEffect(() => {
    let stopped = false
    api.dispatchMessages(dispatch).then(
      (messages) => {
        if (stopped) return
        setEvents(laneEvents(messages))
        setError(null)
      },
      (caught: unknown) => !stopped && setError(caught),
    )
    return () => {
      stopped = true
    }
  }, [dispatch, node.last?.at, sent])
  useEffect(() => setEvents(null), [dispatch])

  const send = async (parts: MessagePart[]): Promise<null> => {
    await api.reply(dispatch, messagePartsToText(parts))
    setSent((count) => count + 1)
    return null
  }
  const closed = ended(node)
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {error !== null ? (
          <div className={`${pageMx} my-4`}>
            <ErrorNote error={error} />
          </div>
        ) : events === null ? (
          <TranscriptSkeleton />
        ) : (
          <ConversationAgent.Provider value={node.agent}>
            <ConversationList events={events} onOpenChat={onOpenChat} root={node.worktree} channel={compose} />
          </ConversationAgent.Provider>
        )}
      </div>
      <Composer
        placeholder={closed ? 'This lane has ended' : `Reply to ${node.label}…`}
        disabled={closed}
        agent={node.agent}
        cwd={node.worktree}
        dispatchId={dispatch}
        model={node.model}
        onSend={send}
        channel={compose}
      />
    </>
  )
}

/**
 * The selected node's conversation, drawn by the chat's own components: an app chat live with its
 * composer, a lane's messages with its coordinator and a composer that replies, or a session's
 * transcript to read.
 */
export function OrchestrationNodeChat({ node, onOpenChat }: { node: OrchestrationNode; onOpenChat?: OpenChat }) {
  const chat = nodeChat(node)
  if (chat.kind === 'app') return <AppChatLoader chatId={chat.chatId} onOpenChat={onOpenChat} />
  if (chat.kind === 'lane') return <LaneChat node={node} dispatch={chat.dispatch} onOpenChat={onOpenChat} />
  if (chat.kind === 'session')
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ConversationAgent.Provider value={node.agent}>
          <Conversation target={{ sessionId: chat.session }} live={!ended(node)} onOpenChat={onOpenChat} root={node.worktree} />
        </ConversationAgent.Provider>
      </div>
    )
  return <p className={`${pageMx} my-4 text-chat-small text-ink-400`}>This node has no conversation to show.</p>
}
