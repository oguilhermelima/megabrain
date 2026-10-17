import { describe, expect, test } from 'bun:test'
import type { ChatArtifact, ChatEventLine } from '@/api/schema'
import { applyLine, followState } from '@/native-chat/chat-model'
import { mockNativeChat } from '@/api/fixtures/chat'
import { artifactRow, artifactStamps, chatPanelLimits, overlayBelow, panelLayout, panelStoreKey, readChatPanel, writeChatPanel } from '@/native-chat/chat-artifacts'
import type { WidthStorage } from '@/lib/panel-width'

const artifact = (id: string, updatedAt: string, revision: number | null = 1): ChatArtifact => ({ id, source: 'megabrain', title: id, format: 'markdown', updatedAt, revision, editable: false })

const a = artifact('a', '2026-10-17T12:00:00Z')
const b = artifact('b', '2026-10-17T12:10:00Z')
const c = artifact('c', '2026-10-17T12:05:00Z')

describe('artifactRow', () => {
  test('hidden when the chat has no artifacts', () => {
    expect(artifactRow([], null, null)).toBeNull()
    expect(artifactRow([], artifactStamps([a]), 'a')).toBeNull()
  })

  test('newest change first', () => {
    expect(artifactRow([a, b, c], null, null)?.map((chip) => chip.artifact.id)).toEqual(['b', 'c', 'a'])
  })

  test('equal times keep the listed order', () => {
    const twin = artifact('twin', a.updatedAt)
    expect(artifactRow([a, twin], null, null)?.map((chip) => chip.artifact.id)).toEqual(['a', 'twin'])
    expect(artifactRow([twin, a], null, null)?.map((chip) => chip.artifact.id)).toEqual(['twin', 'a'])
  })

  test('marks the open artifact active, only it', () => {
    const row = artifactRow([a, b, c], null, 'c')
    expect(row?.filter((chip) => chip.active).map((chip) => chip.artifact.id)).toEqual(['c'])
    expect(artifactRow([a, b], null, 'gone')?.some((chip) => chip.active)).toBe(false)
  })

  test('the first listing pulses nothing', () => {
    expect(artifactRow([a, b], null, null)?.some((chip) => chip.pulse)).toBe(false)
  })

  test('pulses an artifact whose update time changed since the last listing', () => {
    const before = artifactStamps([a, b])
    const changed = { ...a, updatedAt: '2026-10-17T12:20:00Z' }
    const row = artifactRow([changed, b], before, null)
    expect(row?.find((chip) => chip.artifact.id === 'a')?.pulse).toBe(true)
    expect(row?.find((chip) => chip.artifact.id === 'b')?.pulse).toBe(false)
  })

  test('pulses a new revision at the same time, and a new artifact', () => {
    const before = artifactStamps([a])
    const row = artifactRow([{ ...a, revision: 2 }, b], before, null)
    expect(row?.every((chip) => chip.pulse)).toBe(true)
  })

  test('nothing changed, nothing pulses', () => {
    expect(artifactRow([a, b], artifactStamps([a, b]), 'a')?.some((chip) => chip.pulse)).toBe(false)
  })
})

function memory(initial: Record<string, string> = {}): WidthStorage & { values: Record<string, string> } {
  const values = { ...initial }
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => {
      values[key] = value
    },
  }
}

const throwing: WidthStorage = {
  getItem: () => {
    throw new Error('blocked')
  },
  setItem: () => {
    throw new Error('blocked')
  },
}

describe('chat panel persistence', () => {
  test('a chat never opened has no artifact and the initial width', () => {
    expect(readChatPanel(() => memory(), 'chat-1')).toEqual({ artifactId: null, width: chatPanelLimits.initial })
  })

  test('round trips per chat under one key', () => {
    const storage = memory()
    writeChatPanel(() => storage, 'chat-1', { artifactId: 'a', width: 600 })
    writeChatPanel(() => storage, 'chat-2', { artifactId: null, width: 400 })
    expect(Object.keys(storage.values)).toEqual([panelStoreKey])
    expect(readChatPanel(() => storage, 'chat-1')).toEqual({ artifactId: 'a', width: 600 })
    expect(readChatPanel(() => storage, 'chat-2')).toEqual({ artifactId: null, width: 400 })
  })

  test('a width out of bounds is clamped on write and on read', () => {
    const storage = memory()
    expect(writeChatPanel(() => storage, 'chat-1', { artifactId: 'a', width: 10 }).width).toBe(chatPanelLimits.min)
    storage.values[panelStoreKey] = JSON.stringify({ 'chat-1': { artifactId: 'a', width: 99_999 } })
    expect(readChatPanel(() => storage, 'chat-1').width).toBe(chatPanelLimits.max)
  })

  test('garbage or blocked storage reads as a closed panel', () => {
    expect(readChatPanel(() => memory({ [panelStoreKey]: '{not json' }), 'chat-1')).toEqual({ artifactId: null, width: chatPanelLimits.initial })
    expect(readChatPanel(() => memory({ [panelStoreKey]: JSON.stringify({ 'chat-1': { artifactId: 7, width: 'wide' } }) }), 'chat-1')).toEqual({ artifactId: null, width: chatPanelLimits.initial })
    expect(readChatPanel(() => throwing, 'chat-1')).toEqual({ artifactId: null, width: chatPanelLimits.initial })
    expect(writeChatPanel(() => throwing, 'chat-1', { artifactId: 'a', width: 500 })).toEqual({ artifactId: 'a', width: 500 })
  })

  test('keeps the most recently written chats, a bounded number', () => {
    const storage = memory()
    for (let index = 0; index < 250; index += 1) writeChatPanel(() => storage, `chat-${index}`, { artifactId: 'a', width: 500 })
    const kept = Object.keys(JSON.parse(storage.values[panelStoreKey] ?? '{}') as object)
    expect(kept.length).toBeLessThanOrEqual(200)
    expect(kept).toContain('chat-249')
    expect(kept).not.toContain('chat-0')
  })
})

describe('panelLayout', () => {
  test('beside the chat on a wide pane', () => {
    expect(panelLayout(1400, 520)).toEqual({ mode: 'split', width: 520 })
  })

  test('beside the chat, the chat keeps room to write', () => {
    const layout = panelLayout(900, 800)
    expect(layout.mode).toBe('split')
    expect(900 - layout.width).toBeGreaterThanOrEqual(360)
  })

  test('over the chat below the threshold', () => {
    expect(panelLayout(overlayBelow - 1, 520).mode).toBe('overlay')
    expect(panelLayout(overlayBelow, 520).mode).toBe('split')
  })

  test('an overlay never runs past the pane', () => {
    expect(panelLayout(400, 520).width).toBeLessThanOrEqual(400)
    expect(panelLayout(300, 520).width).toBe(300)
  })
})

describe('the artifacts event and the transcript', () => {
  test('changes nothing the chat view holds', () => {
    const state = applyLine(followState(mockNativeChat), { cursor: '3', event: { id: 'e1', at: null, kind: 'user', text: 'hi' } } as ChatEventLine)
    const line = { cursor: '', event: { kind: 'artifacts' } } as ChatEventLine
    expect(applyLine(state, line)).toBe(state)
  })
})
