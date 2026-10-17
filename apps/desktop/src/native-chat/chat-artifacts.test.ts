import { describe, expect, test } from 'bun:test'
import type { ArtifactRevision, ChatArtifact, ChatEventLine } from '@/api/schema'
import { applyLine, followState } from '@/native-chat/chat-model'
import { mockNativeChat } from '@/api/fixtures/chat'
import { artifactGroup, artifactRow, artifactStamps, chatPanelLimits, overlayBelow, panelLayout, panelStoreKey, pickRevision, readChatPanel, revisionEntries, revisionRead, revisionView, writeChatPanel } from '@/native-chat/chat-artifacts'
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

const titled = (id: string, title: string, updatedAt: string, revision: number | null = 1): ChatArtifact => ({ ...artifact(id, updatedAt, revision), title })

describe('one chip per artifact', () => {
  const older = titled('old', 'Leva de correções do QA Social', '2026-10-17T11:40:00Z', 2)
  const newer = titled('new', '  leva de CORRECOES do qa social ', '2026-10-17T12:20:00Z', 3)
  const other = titled('other', 'Something else', '2026-10-17T12:00:00Z')

  test('artifacts with the same title, case and accents folded and trimmed, share one chip showing the newest', () => {
    const row = artifactRow([older, other, newer], null, null)
    expect(row?.map((chip) => chip.artifact.id)).toEqual(['new', 'other'])
    expect(row?.[0]?.members.map((member) => member.id)).toEqual(['new', 'old'])
    expect(row?.[1]?.members.map((member) => member.id)).toEqual(['other'])
  })

  test('the chip is active while any of its artifacts is open', () => {
    expect(artifactRow([older, newer, other], null, 'old')?.filter((chip) => chip.active).map((chip) => chip.artifact.id)).toEqual(['new'])
  })

  test('the chip pulses when any of its artifacts changed', () => {
    const before = artifactStamps([older, newer, other])
    const row = artifactRow([{ ...older, revision: 3 }, newer, other], before, null)
    expect(row?.find((chip) => chip.artifact.id === 'new')?.pulse).toBe(true)
    expect(row?.find((chip) => chip.artifact.id === 'other')?.pulse).toBe(false)
  })

  test('different titles stay apart', () => {
    expect(artifactRow([titled('x', 'Plan', a.updatedAt), titled('y', 'Plans', b.updatedAt)], null, null)?.length).toBe(2)
  })

  test('the group of an open artifact, newest first, from any of its ids', () => {
    expect(artifactGroup([older, other, newer], 'old')?.map((member) => member.id)).toEqual(['new', 'old'])
    expect(artifactGroup([older, other, newer], 'new')?.map((member) => member.id)).toEqual(['new', 'old'])
    expect(artifactGroup([older, other, newer], 'gone')).toBeNull()
    expect(artifactGroup([older, other, newer], null)).toBeNull()
  })
})

const earlier = (revision: number, updatedAt: string, replacedAt: string, title = 'Leva'): ArtifactRevision => ({ revision, title, updatedAt, replacedAt })

describe('revisionEntries', () => {
  test('one artifact: its current version, then the earlier ones, numbered oldest 1', () => {
    const current = titled('one', 'Leva', '2026-10-17T12:00:00Z', 3)
    const entries = revisionEntries([current], new Map([['one', [earlier(1, '2026-10-17T10:00:00Z', '2026-10-17T11:00:00Z'), earlier(2, '2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z')]]]))
    expect(entries.map((entry) => [entry.number, entry.artifactId, entry.revision, entry.current])).toEqual([
      [3, 'one', 3, true],
      [2, 'one', 2, false],
      [1, 'one', 1, false],
    ])
    expect(entries[2]?.at).toBe('2026-10-17T10:00:00Z')
  })

  test('grouped artifacts merge into one list in time order', () => {
    const older = titled('old', 'Leva', '2026-10-17T11:30:00Z', 2)
    const newer = titled('new', 'Leva', '2026-10-17T12:30:00Z', 2)
    const listed = new Map([
      ['old', [earlier(1, '2026-10-17T10:00:00Z', '2026-10-17T11:30:00Z', 'Leva v0')]],
      ['new', [earlier(1, '2026-10-17T12:00:00Z', '2026-10-17T12:30:00Z')]],
    ])
    const entries = revisionEntries([newer, older], listed)
    expect(entries.map((entry) => `${entry.number}:${entry.artifactId}#${entry.revision}`)).toEqual(['4:new#2', '3:new#1', '2:old#2', '1:old#1'])
    expect(entries.map((entry) => entry.current)).toEqual([true, false, true, false])
    expect(entries[3]?.title).toBe('Leva v0')
  })

  test('an artifact with no listed revisions shows only its current version', () => {
    const plan = titled('plan', 'Plan', '2026-10-17T12:00:00Z', 4)
    expect(revisionEntries([plan], new Map()).map((entry) => [entry.number, entry.revision, entry.current])).toEqual([[1, 4, true]])
    const url = titled('url', 'Plan', '2026-10-17T12:00:00Z', null)
    expect(revisionEntries([url], new Map())[0]?.revision).toBeNull()
  })

  test('a listed revision equal to the current one is not shown twice', () => {
    const current = titled('one', 'Leva', '2026-10-17T12:00:00Z', 2)
    const entries = revisionEntries([current], new Map([['one', [earlier(1, '2026-10-17T10:00:00Z', '2026-10-17T11:00:00Z'), earlier(2, '2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z')]]]))
    expect(entries.map((entry) => entry.revision)).toEqual([2, 1])
  })

  test('every entry has its own key', () => {
    const older = titled('old', 'Leva', '2026-10-17T11:30:00Z', 1)
    const newer = titled('new', 'Leva', '2026-10-17T12:30:00Z', 1)
    const keys = revisionEntries([newer, older], new Map()).map((entry) => entry.key)
    expect(new Set(keys).size).toBe(2)
  })
})

describe('the picked revision', () => {
  const current = titled('one', 'Leva', '2026-10-17T12:00:00Z', 3)
  const entries = revisionEntries([current], new Map([['one', [earlier(1, '2026-10-17T10:00:00Z', '2026-10-17T11:00:00Z'), earlier(2, '2026-10-17T11:00:00Z', '2026-10-17T12:00:00Z')]]]))
  const [latest, second, first] = entries

  test('nothing picked shows the latest', () => {
    const view = revisionView(entries, null)
    expect(view?.shown).toBe(latest)
    expect(view?.latest).toBe(latest)
    expect(view?.old).toBe(false)
  })

  test('an older pick shows it, marked old against the newest', () => {
    const view = revisionView(entries, pickRevision(entries, first?.key ?? ''))
    expect(view?.shown).toBe(first)
    expect(view?.latest).toBe(latest)
    expect(view?.old).toBe(true)
  })

  test('picking the latest, or going back to it, is no pick at all', () => {
    expect(pickRevision(entries, latest?.key ?? '')).toBeNull()
    expect(pickRevision(entries, second?.key ?? '')).toBe(second?.key ?? 'missing')
  })

  test('a pick no longer listed falls back to the latest', () => {
    expect(revisionView(entries, 'gone')?.shown).toBe(latest)
    expect(revisionView(entries, 'gone')?.old).toBe(false)
  })

  test('no entries, no view', () => {
    expect(revisionView([], null)).toBeNull()
  })

  test('a current version reads without a revision, an earlier one names it', () => {
    expect(latest === undefined ? null : revisionRead(latest)).toEqual({ artifactId: 'one', revision: undefined })
    expect(first === undefined ? null : revisionRead(first)).toEqual({ artifactId: 'one', revision: 1 })
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
