import type { ArtifactRevision, ChatArtifact } from '@/api/schema'
import { clampWidth, type WidthLimits, type WidthStorage } from '@/lib/panel-width'

// The artifacts row above a native chat's composer and the panel that opens one beside the chat. The
// row lists the chat's artifacts newest change first, one chip per artifact id, and pulses the ones a
// new listing changed; the person can close a chip until its artifact changes again. The panel
// remembers, per chat, which artifact was open and how wide, across pane switches and restarts.

/** One chip: one artifact, whether it is open in the panel, and whether it just changed. */
export type ArtifactChip = { artifact: ChatArtifact; active: boolean; pulse: boolean }

/** What says an artifact changed: its update time and its revision. */
const stamp = (artifact: ChatArtifact) => `${artifact.updatedAt}#${artifact.revision ?? ''}`

/** Each artifact's stamp, kept from one listing to compare the next against. */
export const artifactStamps = (artifacts: readonly ChatArtifact[]): Map<string, string> => new Map(artifacts.map((artifact) => [artifact.id, stamp(artifact)]))

/** Titles that name one artifact for the person: case and accents folded, ends trimmed. */
export const titleKey = (title: string) => title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** The closed chips of a chat: each artifact's stamp when it was closed. A newer stamp shows it again. */
export type HiddenChips = ReadonlyMap<string, string>

const hidden = (artifact: ChatArtifact, closed: HiddenChips) => closed.get(artifact.id) === stamp(artifact)

/**
 * The row's chips, one per artifact, newest change first (ties keep the listed order), or null when
 * none is left to show. `previous` is the listing before this one; an artifact new or changed since
 * then pulses, and the first listing (null) pulses nothing. A closed chip stays out until its
 * artifact changes.
 */
export function artifactRow(artifacts: readonly ChatArtifact[], previous: ReadonlyMap<string, string> | null, activeId: string | null, closed: HiddenChips = new Map()): ArtifactChip[] | null {
  const chips = [...artifacts]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .filter((artifact) => !hidden(artifact, closed))
    .map((artifact) => ({ artifact, active: artifact.id === activeId, pulse: previous !== null && previous.get(artifact.id) !== stamp(artifact) }))
  return chips.length === 0 ? null : chips
}

/** The open artifact, by its id; null when none is open or it is no longer listed. */
export const openArtifact = (artifacts: readonly ChatArtifact[], id: string | null): ChatArtifact | null => (id === null ? null : (artifacts.find((artifact) => artifact.id === id) ?? null))

/** Closes the artifact's chip at its current stamp; closing the one open in the panel closes the panel too. */
export function closeChip(closed: HiddenChips, artifact: ChatArtifact, openId: string | null): { hidden: HiddenChips; open: string | null } {
  return { hidden: new Map([...closed, [artifact.id, stamp(artifact)]]), open: openId === artifact.id ? null : openId }
}

/**
 * One version in the Artifacts page's revision picker. `number` counts the versions of every artifact sharing
 * the title, oldest 1; `revision` is the artifact's own; `current` marks its latest, read without one.
 */
export type RevisionEntry = { key: string; artifactId: string; revision: number | null; title: string; at: string; number: number; current: boolean }

/**
 * The versions of the artifacts sharing a title, newest first: each one's current version and the
 * earlier ones `artifact show` listed for it (none for a source that keeps none), in time order.
 */
export function revisionEntries(members: readonly Pick<ChatArtifact, 'id' | 'revision' | 'title' | 'updatedAt'>[], earlier: ReadonlyMap<string, readonly ArtifactRevision[]>): RevisionEntry[] {
  const versions = members.flatMap((member) => [
    { artifactId: member.id, revision: member.revision, title: member.title, at: member.updatedAt, current: true },
    ...(earlier.get(member.id) ?? []).filter((entry) => entry.revision !== member.revision).map((entry) => ({ artifactId: member.id, revision: entry.revision, title: entry.title, at: entry.updatedAt, current: false })),
  ])
  return versions
    .sort((left, right) => left.at.localeCompare(right.at) || (left.revision ?? 0) - (right.revision ?? 0))
    .map((version, index) => ({ ...version, key: `${version.artifactId}#${version.revision ?? ''}`, number: index + 1 }))
    .reverse()
}

/** The picked version's key, or null for the latest: picking the latest is going back to it. */
export const pickRevision = (entries: readonly RevisionEntry[], key: string): string | null => (key === entries[0]?.key ? null : key)

/** The version the panel shows and the newest; a pick no longer listed shows the newest. */
export function revisionView(entries: readonly RevisionEntry[], pick: string | null): { shown: RevisionEntry; latest: RevisionEntry; old: boolean } | null {
  const latest = entries[0]
  if (latest === undefined) return null
  const shown = entries.find((entry) => entry.key === pick) ?? latest
  return { shown, latest, old: shown !== latest }
}

/** What reads a version: its artifact, and the revision unless it is the artifact's current one. */
export const revisionRead = (entry: RevisionEntry): { artifactId: string; revision: number | undefined } => ({ artifactId: entry.artifactId, revision: entry.current || entry.revision === null ? undefined : entry.revision })

export type ChatPanel = { artifactId: string | null; width: number }

/** Every chat's panel under one key, the most recently written last. */
export const panelStoreKey = 'megabrain.chat.artifact-panel'
const keptChats = 200

export const chatPanelLimits: WidthLimits = { min: 320, max: 1200, initial: 520 }

const closed = (): ChatPanel => ({ artifactId: null, width: chatPanelLimits.initial })

function readAll(storage: () => WidthStorage, key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage().getItem(key) ?? '{}')
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The chat's panel as last left; a chat never opened, or storage that is blocked or holds something else, reads closed. */
export function readChatPanel(storage: () => WidthStorage, chatId: string): ChatPanel {
  const entry = readAll(storage, panelStoreKey)[chatId]
  if (typeof entry !== 'object' || entry === null) return closed()
  const { artifactId, width } = entry as Record<string, unknown>
  if ((artifactId !== null && typeof artifactId !== 'string') || typeof width !== 'number') return closed()
  return { artifactId, width: clampWidth(width, chatPanelLimits) }
}

/** Remembers the chat's panel, keeping the most recent chats only; not remembering it is fine. */
export function writeChatPanel(storage: () => WidthStorage, chatId: string, panel: ChatPanel): ChatPanel {
  const next = { artifactId: panel.artifactId, width: clampWidth(panel.width, chatPanelLimits) }
  writeChat(storage, panelStoreKey, chatId, next)
  return next
}

/** Writes one chat's entry under `key`, the most recent chats only; not remembering it is fine. */
function writeChat(storage: () => WidthStorage, key: string, chatId: string, value: unknown) {
  const { [chatId]: _previous, ...rest } = readAll(storage, key)
  const entries = Object.entries(rest).slice(-(keptChats - 1))
  try {
    storage().setItem(key, JSON.stringify(Object.fromEntries([...entries, [chatId, value]])))
  } catch {
    // Forgotten next time.
  }
}

/** Every chat's closed chips under one key, as [artifact id, stamp] pairs, the most recently written chat last. */
export const hiddenStoreKey = 'megabrain.chat.hidden-artifacts'

const isStampPair = (value: unknown): value is [string, string] => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string'

/** The chat's closed chips; storage that is blocked or holds something else closes none. */
export function readHiddenChips(storage: () => WidthStorage, chatId: string): HiddenChips {
  const entry = readAll(storage, hiddenStoreKey)[chatId]
  return new Map(Array.isArray(entry) ? entry.filter(isStampPair) : [])
}

/** Remembers the chat's closed chips; not remembering them is fine. */
export function writeHiddenChips(storage: () => WidthStorage, chatId: string, closed: HiddenChips): HiddenChips {
  writeChat(storage, hiddenStoreKey, chatId, [...closed])
  return closed
}

/** Below this pane width the panel lies over the chat instead of squeezing it. */
export const overlayBelow = 760
/** What the chat keeps beside the panel: room for the composer's controls. */
const chatRoom = 360
/** What an overlay leaves of the chat, so it still reads as over the chat. */
const overlayGap = 40

/** Beside the chat on a wide pane, the chat keeping room to write; over it on a narrow one, never past the pane. */
export function panelLayout(paneWidth: number, width: number): { mode: 'split' | 'overlay'; width: number } {
  if (paneWidth >= overlayBelow) return { mode: 'split', width: Math.max(chatPanelLimits.min, Math.min(width, paneWidth - chatRoom)) }
  return { mode: 'overlay', width: Math.max(Math.min(width, paneWidth - overlayGap), Math.min(paneWidth, chatPanelLimits.min)) }
}
