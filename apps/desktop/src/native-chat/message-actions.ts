import type { MessagePart, TranscriptEvent } from '@/api/schema'
import type { NoticeDisplayItem } from '@/chat/notice-model'

// What a message's hover actions work with: the text Copy puts on the clipboard, which messages can be
// edited (the latest of the person) or branched from (the last answer of each turn), and the parts an
// edit puts back in the composer.

const imageMarker = /\[Image #\d+\]/g

/** The person's message as they typed it: its text parts, without the images or their markers. */
function personText(event: TranscriptEvent): string {
  const parts = event.parts
  const text = parts !== undefined && parts.some((part) => part.type === 'image') ? parts.map((part) => (part.type === 'text' ? part.text : ' ')).join('') : event.text.replace(imageMarker, ' ')
  return text.replace(/[ \t]{2,}/g, ' ').trim()
}

/** Copy: the assistant's markdown as written, the person's plain text. */
export function messageCopyText(event: TranscriptEvent): string {
  return event.kind === 'user' ? personText(event) : event.text
}

/** Copy text of several messages: in order, a blank line apart, the person's quoted so the turns read apart. */
export function selectionCopyText(events: readonly TranscriptEvent[]): string {
  if (events.length === 1 && events[0] !== undefined) return messageCopyText(events[0])
  return events
    .map((event) =>
      event.kind === 'user'
        ? messageCopyText(event)
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n')
        : messageCopyText(event),
    )
    .join('\n\n')
}

const settled = (item: NoticeDisplayItem): item is Extract<NoticeDisplayItem, { type: 'message' }> => item.type === 'message' && item.streaming !== true && item.pending !== true

/**
 * The message Edit can take back (the latest of the person; none while a turn runs) and the answers a
 * branch can start from: the last assistant message before each message of the person, and the last
 * one of all once no turn runs, which is also the latest answer, whose actions always show.
 */
export function messageRoles(items: readonly NoticeDisplayItem[], busy: boolean): { lastPerson: string | null; turnEnds: Set<string>; lastAnswer: string | null } {
  const turnEnds = new Set<string>()
  let lastPerson: string | null = null
  let answer: string | null = null
  for (const item of items) {
    if (!settled(item)) continue
    const event = item.event
    if (event.kind === 'user') {
      if (answer !== null) turnEnds.add(answer)
      answer = null
      lastPerson = event.id
    } else if (event.kind === 'assistant' && event.command === undefined && event.origin === undefined) answer = event.id
  }
  const lastAnswer = busy ? null : answer
  if (lastAnswer !== null) turnEnds.add(lastAnswer)
  return { lastPerson: busy ? null : lastPerson, turnEnds, lastAnswer }
}

/** What an edit puts back in the composer: the parts it was sent with, or its text then the images kept as files. */
export function editableParts(event: TranscriptEvent): MessagePart[] {
  if (event.parts !== undefined && event.parts.length > 0) return event.parts.map((part) => ({ ...part }))
  const text = event.text.replace(imageMarker, '')
  const images = (event.images ?? []).flatMap((image): MessagePart[] => ('path' in image ? [{ type: 'image', path: image.path }] : []))
  return [...(text === '' ? [] : [{ type: 'text' as const, text }]), ...images]
}

/** A file name for a shared image: the chat's title, safe for any file system. */
export function shareFileName(title: string | null, count: number): string {
  const base = (title ?? '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Message'
  return `${base}${count > 1 ? ` (${count} messages)` : ''}.png`
}

const footerKey = 'megabrain.share.footer'

/** Whether a shared image shows the chat's title under the messages: yes unless the person left it out. */
export function readShareFooter(): boolean {
  try {
    return localStorage.getItem(footerKey) !== '0'
  } catch {
    return true
  }
}

export function keepShareFooter(shown: boolean) {
  try {
    localStorage.setItem(footerKey, shown ? '1' : '0')
  } catch {
    // Not kept: the next app run shows the title again.
  }
}
