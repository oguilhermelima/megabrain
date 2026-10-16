import type { Dispatch, TranscriptEvent } from '@/api/schema'
import type { DisplayItem } from '@/chat/tool-groups'

// A megabrain notice (a child finished, asked, is stuck, ...) renders as a card instead of a plain
// system row. Consecutive notices for one dispatch read as one card with a count, and the card's
// tone follows the dispatch's current state, so an old "stuck" reads finished once it finished.

export type Notice = NonNullable<TranscriptEvent['notice']>
export type NoticeKind = Notice['kind']
export type NoticeTone = 'ok' | 'accent' | 'warn' | 'bad' | 'neutral'

export type NoticeCard = { type: 'notice'; id: string; events: TranscriptEvent[]; notice: Notice }
export type NoticeDisplayItem = DisplayItem | NoticeCard

const tones: Record<NoticeKind, NoticeTone> = { finished: 'ok', ask: 'accent', stuck: 'warn', limit: 'warn', failed: 'bad', other: 'neutral' }

export function noticeTone(kind: NoticeKind): NoticeTone {
  return tones[kind]
}

/** The 8-character suffix megabrain prints in a notice's details line, from either form of the id. */
const suffix = (dispatchId: string): string => dispatchId.slice(-8)

function noticeOf(item: DisplayItem): Notice | null {
  return item.type === 'message' ? (item.event.notice ?? null) : null
}

/**
 * The rows with each notice turned into a card, consecutive notices for the same dispatch folded
 * into one. A card whose events are the ones `previous` had keeps its identity, so memoised rows
 * do not render again on a poll.
 */
export function collapseNotices(display: DisplayItem[], previous: NoticeDisplayItem[] = []): NoticeDisplayItem[] {
  const known = new Map<string, NoticeCard>()
  for (const item of previous) if (item.type === 'notice') known.set(item.id, item)
  const rows: NoticeDisplayItem[] = []
  let open: { events: TranscriptEvent[]; notice: Notice } | null = null
  const close = () => {
    if (open === null) return
    const first = open.events[0]
    const id = `notice-${first?.id ?? ''}`
    const before = known.get(id)
    const same = before !== undefined && before.events.length === open.events.length && before.events.every((event, index) => event === open?.events[index])
    rows.push(same ? before : { type: 'notice', id, events: open.events, notice: open.notice })
    open = null
  }
  for (const item of display) {
    const notice = noticeOf(item)
    if (notice === null || item.type !== 'message') {
      close()
      rows.push(item)
      continue
    }
    const joins = open !== null && notice.dispatchId !== null && open.notice.dispatchId !== null && suffix(notice.dispatchId) === suffix(open.notice.dispatchId)
    if (!joins) close()
    if (open === null) open = { events: [item.event], notice }
    else open = { events: [...open.events, item.event], notice }
  }
  close()
  return rows
}

/** The dispatch a notice names, by full id or by its 8-character suffix. */
export function noticeDispatch(notice: Notice, dispatches: readonly Dispatch[]): Dispatch | null {
  const id = notice.dispatchId
  if (id === null) return null
  return dispatches.find((dispatch) => dispatch.dispatchId === id) ?? dispatches.find((dispatch) => suffix(dispatch.dispatchId) === suffix(id)) ?? null
}

const stateText: Record<string, string> = { done: 'finished', running: 'working', spawning: 'starting' }

export interface LiveNotice {
  kind: NoticeKind
  tone: NoticeTone
  /** What the dispatch is doing now; null when the app does not know the dispatch. */
  state: string | null
}

/** The notice as its dispatch stands now: a finished or failed dispatch overrides what the notice said. */
export function liveNotice(notice: Notice, dispatches: readonly Dispatch[]): LiveNotice {
  const dispatch = noticeDispatch(notice, dispatches)
  if (dispatch === null) return { kind: notice.kind, tone: noticeTone(notice.kind), state: null }
  const kind: NoticeKind = dispatch.state === 'done' ? 'finished' : dispatch.state === 'failed' ? 'failed' : notice.kind
  const finding = dispatch.supervision.finding
  const state = finding !== null && dispatch.state !== 'done' && dispatch.state !== 'failed' ? `needs you · ${finding.cause}` : (stateText[dispatch.state] ?? dispatch.state)
  return { kind, tone: noticeTone(kind), state }
}
