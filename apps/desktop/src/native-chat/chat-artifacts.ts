import type { ChatArtifact } from '@/api/schema'
import { clampWidth, type WidthLimits, type WidthStorage } from '@/lib/panel-width'

// The artifacts row above a native chat's composer and the panel that opens one beside the chat. The
// row lists the chat's artifacts newest change first and pulses the ones a new listing changed; the
// panel remembers, per chat, which artifact was open and how wide, across pane switches and restarts.

export type ArtifactChip = { artifact: ChatArtifact; active: boolean; pulse: boolean }

/** What says an artifact changed: its update time and its revision. */
const stamp = (artifact: ChatArtifact) => `${artifact.updatedAt}#${artifact.revision ?? ''}`

/** Each artifact's stamp, kept from one listing to compare the next against. */
export const artifactStamps = (artifacts: readonly ChatArtifact[]): Map<string, string> => new Map(artifacts.map((artifact) => [artifact.id, stamp(artifact)]))

/**
 * The row's chips, newest change first (ties keep the listed order), or null when the chat has none.
 * `previous` is the listing before this one; an artifact new or changed since then pulses. The first
 * listing (null) pulses nothing.
 */
export function artifactRow(artifacts: readonly ChatArtifact[], previous: ReadonlyMap<string, string> | null, activeId: string | null): ArtifactChip[] | null {
  if (artifacts.length === 0) return null
  return [...artifacts]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((artifact) => ({ artifact, active: artifact.id === activeId, pulse: previous !== null && previous.get(artifact.id) !== stamp(artifact) }))
}

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
