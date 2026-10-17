import type { NoticeDisplayItem } from '@/chat/notice-model'

// The rail beside a chat's transcript: one tick per message of the person, the answer below it belonging to
// that turn. Ticks are 3 px tall and 8 px apart; with many turns the gap shrinks to 3 px, then the rail
// samples them, so it always fits its height and never scrolls.

export const tickHeight = 3
const roomyGap = 8
const tightGap = 3
const fewestTurns = 3
const narrowestChat = 700
const previewLength = 80

/** A message of the person: where it sits in the transcript's rows, and what its tick previews. */
export interface Turn {
  key: string
  row: number
  preview: string
  at: string | null
}

export function chatTurns(rows: readonly NoticeDisplayItem[]): Turn[] {
  return rows.flatMap((item, row) =>
    item.type === 'message' && item.event.kind === 'user' ? [{ key: item.event.id, row, preview: turnPreview(item.event.text), at: item.event.at }] : [],
  )
}

/** The first line with text, cut to fit the hover preview. */
export function turnPreview(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  return line.length <= previewLength ? line : `${line.slice(0, previewLength - 1)}…`
}

/** The turn being read: the last one starting above a line a third of the way down the view; the last one at the bottom. */
export function activeTurn(starts: readonly number[], view: { offset: number; height: number; total: number }): number {
  if (starts.length === 0) return -1
  if (view.offset + view.height >= view.total - 1) return starts.length - 1
  const line = view.offset + view.height / 3
  const after = starts.findIndex((start) => start > line)
  return after === -1 ? starts.length - 1 : Math.max(0, after - 1)
}

const gapFor = (ticks: number, height: number) => (ticks <= 1 ? roomyGap : Math.min(roomyGap, Math.floor((height - ticks * tickHeight) / (ticks - 1))))

/** Where a jump lands a turn: its top just above the reading line, so the turn jumped to is the one in view. */
export function turnLanding(height: number): number {
  return Math.max(0, height / 3 - 24)
}

/** Which turns get a tick, and the gap between them, for a rail `height` px tall. */
export function railLayout(count: number, active: number, height: number): { gap: number; ticks: number[] } {
  const all = Array.from({ length: count }, (_, index) => index)
  if (gapFor(count, height) >= tightGap) return { gap: gapFor(count, height), ticks: all }
  // Every Nth turn, plus the last and the active one, within as many ticks as fit at the tightest gap.
  const room = Math.max(fewestTurns, Math.floor((height + tightGap) / (tickHeight + tightGap)))
  const stride = Math.ceil(count / (room - 2))
  const kept = new Set(all.filter((index) => index % stride === 0))
  kept.add(count - 1)
  if (active >= 0 && active < count) kept.add(active)
  const ticks = [...kept].sort((a, b) => a - b)
  return { gap: Math.max(tightGap, gapFor(ticks.length, height)), ticks }
}

/** A short conversation needs no rail, and a narrow chat has no room for one. */
export function railShown(count: number, width: number): boolean {
  return count >= fewestTurns && width >= narrowestChat
}

/** Alt+Up and Alt+Down: the turn before or after, held at the ends. */
export function stepTurn(active: number, delta: -1 | 1, count: number): number {
  if (count === 0) return -1
  if (active < 0) return delta === 1 ? 0 : count - 1
  return Math.min(count - 1, Math.max(0, active + delta))
}
