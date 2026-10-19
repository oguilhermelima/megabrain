import type { TranscriptEvent } from '@/api/schema'
import { formatElapsed } from '@/native-chat/chat-model'

// The line under each message of the person: how long the agent worked on it. A turn runs from that
// message to the last event before the next one; while the chat works, the last turn has no end and
// counts on.

export interface TurnSpan {
  start: number
  /** Null while the turn runs. */
  end: number | null
}

const startsTurn = (event: TranscriptEvent) => event.kind === 'user' && event.origin === undefined && event.parentId === undefined

/** Each turn's span by the id of the message that started it; a settled turn the agent never answered has none. */
export function turnSpans(events: readonly TranscriptEvent[], running: boolean): ReadonlyMap<string, TurnSpan> {
  const spans = new Map<string, TurnSpan>()
  let open: { id: string; start: number; end: number | null } | null = null
  const close = (last: boolean) => {
    if (open === null) return
    if (last && running) spans.set(open.id, { start: open.start, end: null })
    else if (open.end !== null) spans.set(open.id, { start: open.start, end: open.end })
    open = null
  }
  for (const event of events) {
    const time = event.at === null ? Number.NaN : Date.parse(event.at)
    if (startsTurn(event)) {
      close(false)
      if (!Number.isNaN(time)) open = { id: event.id, start: time, end: null }
      continue
    }
    if (open !== null && !Number.isNaN(time)) open.end = time
  }
  close(true)
  return spans
}

export function turnHeaderLabel(span: TurnSpan, now: number): string {
  if (span.end === null) return `Working for ${formatElapsed(now - span.start)}`
  return `Worked for ${formatElapsed(span.end - span.start)}`
}
