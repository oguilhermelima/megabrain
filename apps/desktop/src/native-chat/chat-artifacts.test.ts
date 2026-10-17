import { describe, expect, test } from 'bun:test'
import type { ArtifactRevision, ChatArtifact, ChatEventLine } from '@/api/schema'
import { applyLine, followState } from '@/native-chat/chat-model'
import { mockNativeChat } from '@/api/fixtures/chat'
import { artifactRow, artifactStamps, chatPanelLimits, closeChip, hiddenStoreKey, openArtifact, readHiddenChips, writeHiddenChips, type ArtifactChip, type HiddenChips, overlayBelow, panelLayout, panelStoreKey, pickRevision, readChatPanel, revisionEntries, revisionRead, revisionView, writeChatPanel } from '@/native-chat/chat-artifacts'
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
  const diagram = titled('art-20261017-e82e7a18', 'Leva de correções do QA Social — fluxo', '2026-10-17T12:20:00Z', 3)
  const doc = titled('art-20261017-6b1338f8', 'Leva de correções do QA Social', '2026-10-17T11:40:00Z', 1)
  const twin = titled('twin', '  leva de CORRECOES do qa social ', '2026-10-17T11:00:00Z', 2)

  test('artifacts with similar or equal titles stay one chip each, newest first', () => {
    expect(artifactRow([doc, twin, diagram], null, null)?.map((chip) => chip.artifact.id)).toEqual(['art-20261017-e82e7a18', 'art-20261017-6b1338f8', 'twin'])
  })

  test('only the open artifact is active, not one sharing its title', () => {
    expect(artifactRow([diagram, doc, twin], null, 'twin')?.filter((chip) => chip.active).map((chip) => chip.artifact.id)).toEqual(['twin'])
  })

  test('only the artifact that changed pulses', () => {
    const before = artifactStamps([diagram, doc, twin])
    const row = artifactRow([diagram, { ...doc, revision: 2 }, twin], before, null)
    expect(row?.filter((chip) => chip.pulse).map((chip) => chip.artifact.id)).toEqual(['art-20261017-6b1338f8'])
  })

  test('the open artifact is found by its id alone', () => {
    expect(openArtifact([diagram, doc, twin], 'art-20261017-6b1338f8')?.id).toBe('art-20261017-6b1338f8')
    expect(openArtifact([diagram, doc, twin], 'gone')).toBeNull()
    expect(openArtifact([diagram, doc, twin], null)).toBeNull()
  })
})

describe('closing a chip', () => {
  const chipOf = (row: ArtifactChip[] | null, id: string) => row?.find((chip) => chip.artifact.id === id)

  test('a closed chip leaves the row; the others stay', () => {
    const hidden = closeChip(new Map(), a, null).hidden
    expect(artifactRow([a, b, c], null, null, hidden)?.map((chip) => chip.artifact.id)).toEqual(['b', 'c'])
  })

  test('the row disappears when every chip is closed', () => {
    let hidden: HiddenChips = new Map()
    for (const shown of [a, b]) hidden = closeChip(hidden, shown, null).hidden
    expect(artifactRow([a, b], null, null, hidden)).toBeNull()
  })

  test('a closed chip comes back on a newer revision of its artifact', () => {
    const hidden = closeChip(new Map(), a, null).hidden
    expect(chipOf(artifactRow([{ ...a, revision: 2 }, b], null, null, hidden), 'a')).toBeDefined()
    expect(chipOf(artifactRow([{ ...a, updatedAt: '2026-10-17T13:00:00Z' }, b], null, null, hidden), 'a')).toBeDefined()
    expect(chipOf(artifactRow([a, b], null, null, hidden), 'a')).toBeUndefined()
  })

  test('closing a chip hides only that id, not one sharing its title', () => {
    const one = titled('one', 'Same title', a.updatedAt)
    const two = titled('two', 'Same title', b.updatedAt)
    const hidden = closeChip(new Map(), one, null).hidden
    expect(artifactRow([one, two], null, null, hidden)?.map((chip) => chip.artifact.id)).toEqual(['two'])
  })

  test('closing the open chip closes the panel; closing another keeps it open', () => {
    expect(closeChip(new Map(), a, 'a').open).toBeNull()
    expect(closeChip(new Map(), a, 'b').open).toBe('b')
    expect(closeChip(new Map(), a, null).open).toBeNull()
  })

  test('closed chips are remembered per chat under one key', () => {
    const storage = memory()
    writeHiddenChips(() => storage, 'chat-1', closeChip(new Map(), a, null).hidden)
    writeHiddenChips(() => storage, 'chat-2', closeChip(new Map(), b, null).hidden)
    expect(Object.keys(storage.values)).toEqual([hiddenStoreKey])
    expect(artifactRow([a, b], null, null, readHiddenChips(() => storage, 'chat-1'))?.map((chip) => chip.artifact.id)).toEqual(['b'])
    expect(artifactRow([a, b], null, null, readHiddenChips(() => storage, 'chat-2'))?.map((chip) => chip.artifact.id)).toEqual(['a'])
    expect(readHiddenChips(() => storage, 'chat-3').size).toBe(0)
  })

  test('garbage or blocked storage hides nothing, and writing to it does not throw', () => {
    expect(readHiddenChips(() => memory({ [hiddenStoreKey]: '{not json' }), 'chat-1').size).toBe(0)
    expect(readHiddenChips(() => memory({ [hiddenStoreKey]: JSON.stringify({ 'chat-1': [7, 'x'] }) }), 'chat-1').size).toBe(0)
    expect(readHiddenChips(() => throwing, 'chat-1').size).toBe(0)
    const hidden = closeChip(new Map(), a, null).hidden
    expect(writeHiddenChips(() => throwing, 'chat-1', hidden)).toBe(hidden)
  })

  test('keeps the most recently written chats, a bounded number', () => {
    const storage = memory()
    const hidden = closeChip(new Map(), a, null).hidden
    for (let index = 0; index < 250; index += 1) writeHiddenChips(() => storage, `chat-${index}`, hidden)
    const kept = Object.keys(JSON.parse(storage.values[hiddenStoreKey] ?? '{}') as object)
    expect(kept.length).toBeLessThanOrEqual(200)
    expect(kept).toContain('chat-249')
    expect(kept).not.toContain('chat-0')
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
