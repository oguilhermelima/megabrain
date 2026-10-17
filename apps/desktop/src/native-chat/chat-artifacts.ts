import type { ArtifactRevision, ChatArtifact } from '@/api/schema'
import { clampWidth, type WidthLimits, type WidthStorage } from '@/lib/panel-width'

// The artifacts row above a native chat's composer and the panel that opens one beside the chat. The
// row lists the chat's artifacts newest change first, one chip per title, and pulses the ones a new
// listing changed; the panel remembers, per chat, which artifact was open and how wide, across pane
// switches and restarts.

/** One chip: the newest of the artifacts sharing a title, and all of them, newest first. */
export type ArtifactChip = { artifact: ChatArtifact; members: ChatArtifact[]; active: boolean; pulse: boolean }

/** What says an artifact changed: its update time and its revision. */
const stamp = (artifact: ChatArtifact) => `${artifact.updatedAt}#${artifact.revision ?? ''}`

/** Each artifact's stamp, kept from one listing to compare the next against. */
export const artifactStamps = (artifacts: readonly ChatArtifact[]): Map<string, string> => new Map(artifacts.map((artifact) => [artifact.id, stamp(artifact)]))

/** Titles that name one artifact for the person: case and accents folded, ends trimmed. */
export const titleKey = (title: string) => title.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** The artifacts newest change first (ties keep the listed order), those sharing a title together. */
function groups(artifacts: readonly ChatArtifact[]): [ChatArtifact, ...ChatArtifact[]][] {
  const byTitle = new Map<string, [ChatArtifact, ...ChatArtifact[]]>()
  for (const artifact of [...artifacts].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const key = titleKey(artifact.title)
    const group = byTitle.get(key)
    if (group === undefined) byTitle.set(key, [artifact])
    else group.push(artifact)
  }
  return [...byTitle.values()]
}

/**
 * The row's chips, newest change first, or null when the chat has none. Artifacts sharing a title are
 * one chip showing the newest. `previous` is the listing before this one; a chip with an artifact new
 * or changed since then pulses. The first listing (null) pulses nothing.
 */
export function artifactRow(artifacts: readonly ChatArtifact[], previous: ReadonlyMap<string, string> | null, activeId: string | null): ArtifactChip[] | null {
  if (artifacts.length === 0) return null
  return groups(artifacts).map((members) => ({
    artifact: members[0],
    members,
    active: members.some((member) => member.id === activeId),
    pulse: previous !== null && members.some((member) => previous.get(member.id) !== stamp(member)),
  }))
}

/** The artifacts sharing a title with the open one, newest first; null when it is not listed. */
export function artifactGroup(artifacts: readonly ChatArtifact[], id: string | null): [ChatArtifact, ...ChatArtifact[]] | null {
  return id === null ? null : (groups(artifacts).find((members) => members.some((member) => member.id === id)) ?? null)
}

/**
 * One version in the panel's revision picker. `number` counts the versions of every artifact sharing
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

function readAll(storage: () => WidthStorage): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(storage().getItem(panelStoreKey) ?? '{}')
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The chat's panel as last left; a chat never opened, or storage that is blocked or holds something else, reads closed. */
export function readChatPanel(storage: () => WidthStorage, chatId: string): ChatPanel {
  const entry = readAll(storage)[chatId]
  if (typeof entry !== 'object' || entry === null) return closed()
  const { artifactId, width } = entry as Record<string, unknown>
  if ((artifactId !== null && typeof artifactId !== 'string') || typeof width !== 'number') return closed()
  return { artifactId, width: clampWidth(width, chatPanelLimits) }
}

/** Remembers the chat's panel, keeping the most recent chats only; not remembering it is fine. */
export function writeChatPanel(storage: () => WidthStorage, chatId: string, panel: ChatPanel): ChatPanel {
  const next = { artifactId: panel.artifactId, width: clampWidth(panel.width, chatPanelLimits) }
  const { [chatId]: _previous, ...rest } = readAll(storage)
  const entries = Object.entries(rest).slice(-(keptChats - 1))
  try {
    storage().setItem(panelStoreKey, JSON.stringify(Object.fromEntries([...entries, [chatId, next]])))
  } catch {
    // The panel opens closed next time.
  }
  return next
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
