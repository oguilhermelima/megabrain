import type { TranscriptEvent } from '@/api/schema'

// Pure logic for the conversation view: pairing tool calls with their results, merging polled
// event batches without duplicates, and formatting assistant text into paragraphs, code fences
// and inline code.

export type ToolStatus = 'ok' | 'error' | 'running'

export type ConversationItem =
  | { type: 'message'; event: TranscriptEvent }
  | { type: 'tool'; id: string; call: TranscriptEvent; result: TranscriptEvent | null; status: ToolStatus }

/** Pairs each tool-call with the tool-result event that immediately follows it (by position). */
export function buildConversationItems(events: TranscriptEvent[]): ConversationItem[] {
  const items: ConversationItem[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    if (event.kind === 'tool-result') continue
    if (event.kind !== 'tool-call') {
      items.push({ type: 'message', event })
      continue
    }
    const next = events[index + 1]
    const result = next !== undefined && next.kind === 'tool-result' ? next : null
    const status: ToolStatus = result === null ? 'running' : (result.tool?.status ?? 'ok')
    items.push({ type: 'tool', id: event.id, call: event, result, status })
  }
  return items
}

/** Appends events from a newer poll onto the known list, skipping any id already present. */
export function mergeEvents(known: TranscriptEvent[], incoming: TranscriptEvent[]): TranscriptEvent[] {
  const seen = new Set(known.map((event) => event.id))
  const merged = known.slice()
  for (const event of incoming) {
    if (seen.has(event.id)) continue
    seen.add(event.id)
    merged.push(event)
  }
  return merged
}

export type TextSegment = { type: 'text' | 'code' | 'inline-code'; value: string }

/** Splits text on ``` fences first, then inline `code` within the remaining plain runs. */
export function formatText(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  const fenceParts = text.split(/```/)
  fenceParts.forEach((part, index) => {
    const isFence = index % 2 === 1
    if (isFence) {
      segments.push({ type: 'code', value: part.replace(/^[^\n]*\n/, '') })
      return
    }
    const inlineParts = part.split(/`([^`]+)`/)
    inlineParts.forEach((inlinePart, inlineIndex) => {
      if (inlinePart === '') return
      segments.push({ type: inlineIndex % 2 === 1 ? 'inline-code' : 'text', value: inlinePart })
    })
  })
  return segments
}
