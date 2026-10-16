import type { TranscriptEvent } from '@/api/schema'
import { buildConversationItems } from '@/chat/conversation-model'
import { closesRun, groupToolRuns, type DisplayItem } from '@/chat/tool-groups'

// A live chat polls only its new events; deriving the rows again from every event on each poll is
// O(all events). Everything up to the last message that closes a tool run is settled: a tool call
// pairs only with the event right after it, and grouping restarts after such a message. So only
// the events after it are derived again, and the settled rows keep their identity.

export interface DerivedConversation {
  events: TranscriptEvent[]
  /** How many leading events produced `settled`. */
  settledEvents: number
  settled: DisplayItem[]
  display: DisplayItem[]
}

function extendsKnown(previous: DerivedConversation, events: TranscriptEvent[]): boolean {
  if (events.length < previous.events.length) return false
  for (let index = 0; index < previous.events.length; index++) if (events[index] !== previous.events[index]) return false
  return true
}

function derive(events: TranscriptEvent[], start: number, settled: DisplayItem[]): DerivedConversation {
  const tailEvents = events.slice(start)
  const items = buildConversationItems(tailEvents)
  const tail = groupToolRuns(items)
  let settledEvents = start
  let settledDisplay = settled
  let closing: DisplayItem | undefined
  for (let index = items.length - 1; index >= 0 && closing === undefined; index--) {
    const item = items[index]
    if (item !== undefined && closesRun(item)) closing = item
  }
  if (closing !== undefined && closing.type === 'message') {
    const shown = tail.indexOf(closing)
    settledDisplay = settled.concat(tail.slice(0, shown + 1))
    settledEvents = start + tailEvents.lastIndexOf(closing.event) + 1
  }
  return { events, settledEvents, settled: settledDisplay, display: settled.concat(tail) }
}

/** The rows of a conversation, reusing what `previous` derived when `events` only adds to its events. */
export function deriveConversation(previous: DerivedConversation | null, events: TranscriptEvent[]): DerivedConversation {
  if (previous === null || !extendsKnown(previous, events)) return derive(events, 0, [])
  if (events.length === previous.events.length) return previous
  return derive(events, previous.settledEvents, previous.settled)
}
