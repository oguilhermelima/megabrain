import type { DispatchMessage, OrchestrationNode, TranscriptEvent } from '@/api/schema'
import { dispatchOf } from '@/native-chat/orchestration/orchestration-layout'

// The pure side of the orchestration side panel: which conversation a node has, and a lane's messages
// with its coordinator as transcript rows the chat's own renderer draws.

/**
 * The conversation a selected node shows: an app chat's live transcript, a lane's messages with its
 * coordinator, a session's transcript to read, or none when the node has neither.
 */
export type NodeChat = { kind: 'app'; chatId: string } | { kind: 'lane'; dispatch: string } | { kind: 'session'; session: string } | { kind: 'none' }

export function nodeChat(node: OrchestrationNode): NodeChat {
  if (node.chatId !== null) return { kind: 'app', chatId: node.chatId }
  const dispatch = dispatchOf(node)
  if (dispatch !== null) return { kind: 'lane', dispatch }
  return node.session === null ? { kind: 'none' } : { kind: 'session', session: node.session }
}

// What the coordinator says is the person's side of the lane's chat, and what the lane says back the agent's.
const spoken: Record<string, TranscriptEvent['kind']> = { 'parent:prompt': 'user', 'parent:reply': 'user', 'parent:change': 'user', 'child:ask': 'assistant', 'child:done': 'assistant' }

/** A lane's messages, oldest first, as rows: the brief, replies and changes as sent, asks and done as answered, the rest as notices. */
export function laneEvents(messages: readonly DispatchMessage[]): TranscriptEvent[] {
  return messages.map((message, index) => {
    const kind = spoken[`${message.from}:${message.type}`]
    const at = message.createdAt ?? null
    if (kind !== undefined) return { id: `message-${index}`, at, kind, text: message.text }
    const text = message.type === 'received' ? 'Received the brief.' : message.text === '' || message.text === message.type ? message.type : `${message.type}: ${message.text}`
    return { id: `message-${index}`, at, kind: 'system', text }
  })
}
