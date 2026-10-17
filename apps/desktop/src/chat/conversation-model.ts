import type { TranscriptEvent } from '@/api/schema'
import { formatElapsed } from '@/native-chat/chat-model'

// Pure logic for the conversation view: pairing tool calls with their results, merging polled
// event batches without duplicates, and formatting assistant text into paragraphs, code fences
// and inline code.

export type ToolStatus = 'ok' | 'error' | 'running'

export type ConversationItem =
  // streaming: a message still being generated; pending: a sent message the chat has not echoed yet;
  // thoughtMs: on thinking, how long it took, from the event before it to its last part.
  | { type: 'message'; event: TranscriptEvent; streaming?: boolean; pending?: boolean; thoughtMs?: number }
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
 * subagent is not among the events are dropped. `before` is the event ahead of these, when they continue a
 * conversation, so thinking at their start is timed as it would be in the whole of it.
 */
/** Older chats stored a system line for every model or effort change; the composer shows the current pick, so they stay hidden. */
const isModelNotice = (event: TranscriptEvent) => event.kind === 'system' && event.text.startsWith('Model set to ')

export function buildConversationItems(all: TranscriptEvent[], before: TranscriptEvent | null = null): ConversationItem[] {
  const events = all.filter((event) => !isModelNotice(event))
  const started = new Set(events.flatMap((event) => subagentId(event, 'tool-call') ?? []))
  if (started.size === 0 && !events.some((event) => event.parentId !== undefined || subagentId(event, 'tool-result') !== null)) return pairTools(events, new Map(), new Map(), before)
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
  return pairTools(main, steps, ends, before)
}

const isThought = (event: TranscriptEvent) => event.kind === 'thinking' && event.origin === undefined

function elapsedMs(from: string | null, to: string | null): number | undefined {
  const ms = from === null || to === null ? Number.NaN : Date.parse(to) - Date.parse(from)
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined
}

/** The header of a thinking entry: how long it took when the events say, else just Thought. */
export function thoughtLabel(ms: number | undefined): string {
  return ms === undefined ? 'Thought' : `Thought for ${formatElapsed(Math.max(1000, Math.round(ms / 1000) * 1000))}`
}

const endsTurn = (event: TranscriptEvent) => event.kind === 'user' || event.kind === 'assistant' || event.kind === 'system' || event.kind === 'turn-cut'

function pairTools(events: TranscriptEvent[], steps: Map<string, TranscriptEvent[]>, ends: Map<string, TranscriptEvent>, before: TranscriptEvent | null = null): ConversationItem[] {
  let lastEnd = -1
  events.forEach((event, index) => {
    if (endsTurn(event)) lastEnd = index
  })
  const items: ConversationItem[] = []
  // Thinking with no visible text (Claude 5 often keeps only its signature) is no row, and consecutive
  // thinking reads as one entry, timed from the event before its first part.
  let thoughtFrom: string | null = null
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event === undefined) continue
    if (event.kind === 'tool-result') continue
    if (isThought(event)) {
      if (event.text.trim() === '') continue
      const last = items.at(-1)
      if (last?.type === 'message' && isThought(last.event)) {
        const thoughtMs = elapsedMs(thoughtFrom, event.at)
        items[items.length - 1] = { type: 'message', event: { ...last.event, text: `${last.event.text}\n\n${event.text}` }, ...(thoughtMs === undefined ? {} : { thoughtMs }) }
        continue
      }
      thoughtFrom = (index === 0 ? before : events[index - 1])?.at ?? null
      const thoughtMs = elapsedMs(thoughtFrom, event.at)
      items.push({ type: 'message', event, ...(thoughtMs === undefined ? {} : { thoughtMs }) })
      continue
    }
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
    // A call with no result runs only while its turn does: a message, a prompt or an Interrupted after it ended that turn.
    const cut = result === null && index < lastEnd
    const status: ToolStatus = result === null ? (cut ? 'error' : 'running') : (result.tool?.status ?? 'ok')
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
