import { describe, expect, test } from 'bun:test'
import { mockStatus } from '@/api/fixtures/mock'
import type { Dispatch } from '@/api/schema'
import { buildColumns, parentLabel } from '@/advanced/columns-model'

function chat(id: string, fields: Partial<Dispatch> = {}): Dispatch {
  return {
    dispatchId: `dispatch-20261015000000000-1-${id}`,
    state: 'running',
    owner: 'foreign',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    supervision: { lastCheck: null, finding: null },
    ...fields,
  }
}

describe('parentLabel', () => {
  test('reads the agent name and a short id from the session prefix', () => {
    expect(parentLabel('claude:5f1c2a7e-0d6b-4b8e-9c55-1e2f3a4b5c6d')).toBe('Claude 5f1c2a7e')
  })
  test('falls back to the raw value when there is no id half', () => {
    expect(parentLabel('claude')).toBe('Claude')
  })
})

describe('buildColumns', () => {
  test('groups chats into one column per root parent session', () => {
    const columns = buildColumns([chat('a', { parentSessionId: 'claude:aaa' }), chat('b', { parentSessionId: 'claude:bbb' })])
    expect(columns.map((column) => column.parentSessionId)).toEqual(['claude:aaa', 'claude:bbb'])
    expect(columns[0]?.children.map((node) => node.chat.dispatchId.slice(-1))).toEqual(['a'])
  })

  test('nests a chat under the sibling whose agentSessionId it names as its parent', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root', agentSessionId: 'codex:child' }),
      chat('b', { parentSessionId: 'codex:child' }),
    ])
    expect(columns).toHaveLength(1)
    const [root] = columns[0]?.children ?? []
    expect(root?.chat.dispatchId.slice(-1)).toBe('a')
    expect(root?.children.map((node) => node.chat.dispatchId.slice(-1))).toEqual(['b'])
  })

  test('nests a grandchild two levels deep', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root', agentSessionId: 'codex:a' }),
      chat('b', { parentSessionId: 'codex:a', agentSessionId: 'codex:b' }),
      chat('c', { parentSessionId: 'codex:b' }),
    ])
    const [a] = columns[0]?.children ?? []
    const [b] = a?.children ?? []
    const [c] = b?.children ?? []
    expect(a?.chat.dispatchId.slice(-1)).toBe('a')
    expect(b?.chat.dispatchId.slice(-1)).toBe('b')
    expect(c?.chat.dispatchId.slice(-1)).toBe('c')
  })

  test('ended chats are counted but not shown', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root', state: 'running' }),
      chat('b', { parentSessionId: 'claude:root', state: 'done' }),
      chat('c', { parentSessionId: 'claude:root', state: 'failed' }),
    ])
    expect(columns[0]?.children.map((node) => node.chat.dispatchId.slice(-1))).toEqual(['a'])
    expect(columns[0]?.endedCount).toBe(2)
  })

  test('counts an ended grandchild toward its root column', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root', agentSessionId: 'codex:a' }),
      chat('b', { parentSessionId: 'codex:a', state: 'done' }),
    ])
    expect(columns[0]?.endedCount).toBe(1)
    expect(columns[0]?.children[0]?.children).toEqual([])
  })

  test('leaves out a parent whose chats have all ended', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root', state: 'done' }),
      chat('b', { parentSessionId: 'claude:root', state: 'failed' }),
    ])
    expect(columns).toEqual([])
  })

  test('keeps a parent with an open grandchild even though its direct child has ended', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root', agentSessionId: 'codex:a', state: 'done' }),
      chat('b', { parentSessionId: 'codex:a', state: 'running' }),
    ])
    expect(columns).toHaveLength(1)
    expect(columns[0]?.endedCount).toBe(1)
  })

  test('orders columns by their earliest chat and children by createdAt', () => {
    const columns = buildColumns([
      chat('a', { parentSessionId: 'claude:root1', createdAt: '2026-10-15T12:00:00.000Z' }),
      chat('b', { parentSessionId: 'claude:root2', createdAt: '2026-10-15T09:00:00.000Z' }),
      chat('c', { parentSessionId: 'claude:root1', createdAt: '2026-10-15T08:00:00.000Z' }),
    ])
    expect(columns.map((column) => column.parentSessionId)).toEqual(['claude:root1', 'claude:root2'])
    expect(columns[0]?.children.map((node) => node.chat.dispatchId.slice(-1))).toEqual(['c', 'a'])
  })

  test('a chat with no parentSessionId is excluded from every column', () => {
    const columns = buildColumns([chat('a', { parentSessionId: null })])
    expect(columns).toEqual([])
  })

  test('the mock produces at least one column with a nested child', () => {
    const columns = buildColumns(mockStatus.dispatches)
    expect(columns.length).toBeGreaterThan(0)
    const nested = columns.some((column) => column.children.some((node) => node.children.length > 0))
    expect(nested).toBe(true)
  })
})
