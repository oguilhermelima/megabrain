import type { TranscriptEvent } from '@/api/schema'

// Pure logic for the conversation view: pairing tool calls with their results, merging polled
// event batches without duplicates, and formatting assistant text into paragraphs, code fences
// and inline code.

export type ToolStatus = 'ok' | 'error' | 'running'

export type ConversationItem =
  // streaming: a message still being generated; pending: a sent message the chat has not echoed yet.
  | { type: 'message'; event: TranscriptEvent; streaming?: boolean; pending?: boolean }
  | { type: 'tool'; id: string; call: TranscriptEvent; result: TranscriptEvent | null; status: ToolStatus }
  // A subagent where its call was: the steps it took, and the tool result that ended it once it has.
  | { type: 'subagent'; id: string; call: TranscriptEvent; steps: ConversationItem[]; end: TranscriptEvent | null }

/** A row that is still changing, shown after a conversation's history. */
export interface LiveRow {
  event: TranscriptEvent
  streaming?: boolean
  pending?: boolean
}

const subagentId = (event: TranscriptEvent, kind: 'tool-call' | 'tool-result'): string | null => (event.kind === kind ? (event.subagent?.id ?? null) : null)

/**
 * Pairs each tool-call with the tool-result event that immediately follows it (by position). A subagent's
 * steps and end come out of that flow and into the subagent, wherever they arrived; the ones whose
 * subagent is not among the events are dropped.
 */
export function buildConversationItems(events: TranscriptEvent[]): ConversationItem[] {
  const started = new Set(events.flatMap((event) => subagentId(event, 'tool-call') ?? []))
  if (started.size === 0 && !events.some((event) => event.parentId !== undefined || subagentId(event, 'tool-result') !== null)) return pairTools(events, new Map(), new Map())
  const steps = new Map<string, TranscriptEvent[]>()
  const ends = new Map<string, TranscriptEvent>()
  const main: TranscriptEvent[] = []
  for (const event of events) {
    const ended = subagentId(event, 'tool-result')
    if (event.parentId !== undefined) {
      if (started.has(event.parentId)) steps.set(event.parentId, (steps.get(event.parentId) ?? []).concat(event))
    } else if (ended !== null) {
      if (started.has(ended) && !ends.has(ended)) ends.set(ended, event)
    } else main.push(event)
  }
  return pairTools(main, steps, ends)
}

function pairTools(events: TranscriptEvent[], steps: Map<string, TranscriptEvent[]>, ends: Map<string, TranscriptEvent>): ConversationItem[] {
  const items: ConversationItem[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    if (event.kind === 'tool-result') continue
    if (event.kind !== 'tool-call') {
      items.push({ type: 'message', event })
      continue
    }
    const subagent = event.subagent?.id
    if (subagent !== undefined) {
      items.push({ type: 'subagent', id: subagent, call: event, steps: pairTools(steps.get(subagent) ?? [], steps, ends), end: ends.get(subagent) ?? null })
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

/** The first line of a relayed message, used as its collapsed-card preview. */
export function relayedPreview(text: string): string {
  return text.split('\n')[0] ?? ''
}

/** Where a relayed message's → button should navigate: dispatchId first, else sessionId, else nowhere. */
export function relayedTarget(origin: NonNullable<TranscriptEvent['origin']>): { dispatchId: string } | { sessionId: string } | null {
  if (origin.dispatchId !== null) return { dispatchId: origin.dispatchId }
  if (origin.sessionId !== null) return { sessionId: origin.sessionId }
  return null
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

// The field that says what a tool call did, for the tools whose input is JSON.
const summaryField: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  Write: 'file_path',
  NotebookEdit: 'notebook_path',
  Grep: 'pattern',
  Glob: 'pattern',
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string')) return value.join(' ')
  return null
}

/**
 * One line saying what a tool call did — the command, the file or the pattern — instead of its raw
 * JSON input. Known tools use their field, others the first string field; input that is not JSON
 * shows its first line. The full input stays available when the row is expanded.
 */
export function toolSummary(name: string, input: string | undefined): string {
  if (input === undefined || input === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return firstLine(input)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return typeof parsed === 'string' ? firstLine(parsed) : ''
  const fields = parsed as Record<string, unknown>
  const preferred = summaryField[name]
  const chosen = (preferred === undefined ? null : asText(fields[preferred])) ?? asText(fields.command) ?? Object.values(fields).map(asText).find((text) => text !== null) ?? ''
  return firstLine(chosen)
}
