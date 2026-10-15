import type { Dispatch } from '@/api/schema'
import { chatState } from '@/advanced/model'

export interface ChildNode {
  chat: Dispatch
  children: ChildNode[]
}

export interface ColumnModel {
  parentSessionId: string
  label: string
  children: ChildNode[]
  endedCount: number
}

/** Agent name and a short id from a session id such as "claude:5f1c2a7e-...". */
export function parentLabel(parentSessionId: string): string {
  const [agent, id] = parentSessionId.split(':')
  const name = agent === undefined || agent === '' ? 'unknown' : agent.charAt(0).toUpperCase() + agent.slice(1)
  const shortId = id === undefined || id === '' ? '' : id.slice(0, 8)
  return shortId === '' ? name : `${name} ${shortId}`
}

function countEnded(chats: Dispatch[], byParent: Map<string, Dispatch[]>, parentId: string): number {
  const direct = byParent.get(parentId) ?? []
  let count = 0
  for (const chat of direct) {
    if (chatState(chat) === 'ended') count += 1
    if (chat.agentSessionId !== null && chat.agentSessionId !== undefined) {
      count += countEnded(chats, byParent, chat.agentSessionId)
    }
  }
  return count
}

function buildChildren(byParent: Map<string, Dispatch[]>, parentId: string): ChildNode[] {
  const direct = (byParent.get(parentId) ?? []).filter((chat) => chatState(chat) !== 'ended')
  const sorted = [...direct].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return sorted.map((chat) => ({
    chat,
    children: chat.agentSessionId === null || chat.agentSessionId === undefined ? [] : buildChildren(byParent, chat.agentSessionId),
  }))
}

function earliestCreatedAt(chats: Dispatch[]): string {
  return chats.reduce((earliest, chat) => (chat.createdAt.localeCompare(earliest) < 0 ? chat.createdAt : earliest), chats[0]?.createdAt ?? '')
}

/** One column per root parent session, children nested by agentSessionId; ended chats counted, not shown. */
export function buildColumns(chats: Dispatch[]): ColumnModel[] {
  const byParent = new Map<string, Dispatch[]>()
  for (const chat of chats) {
    const parentId = chat.parentSessionId
    if (parentId === null || parentId === undefined || parentId === '') continue
    const group = byParent.get(parentId) ?? []
    group.push(chat)
    byParent.set(parentId, group)
  }

  const agentSessionIds = new Set(chats.map((chat) => chat.agentSessionId).filter((id): id is string => id !== null && id !== undefined && id !== ''))

  const rootIds = [...byParent.keys()].filter((parentId) => !agentSessionIds.has(parentId))

  const columns = rootIds.map((parentSessionId) => {
    const group = byParent.get(parentSessionId) ?? []
    return {
      parentSessionId,
      label: parentLabel(parentSessionId),
      children: buildChildren(byParent, parentSessionId),
      endedCount: countEnded(chats, byParent, parentSessionId),
      earliest: earliestCreatedAt(group),
    }
  })

  return columns.sort((left, right) => left.earliest.localeCompare(right.earliest)).map(({ earliest, ...column }) => column)
}
