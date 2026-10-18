import type { ChatApproval } from '@/api/schema'

// The keyboard of an approval card: one decision is the tab stop and the arrow keys move it, the way
// a toolbar's buttons rove. Enter and Space stay the buttons' own.

/** Where a key moves the roving focus among `count` decisions from `index`, wrapping; null for any other key. */
export function rovingIndex(key: string, index: number, count: number): number | null {
  if (count === 0) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** The decision the card offers first: Deny, the safe one, else the first listed. */
export function safeDecision(decisions: ChatApproval['decisions']): number {
  return Math.max(0, decisions.indexOf('deny'))
}

/** Whether a card that appears may take the focus: never from a field the person is typing in. */
export function mayTakeFocus(active: { editable: boolean; text: string } | null): boolean {
  return active === null || !active.editable || active.text.trim() === ''
}
