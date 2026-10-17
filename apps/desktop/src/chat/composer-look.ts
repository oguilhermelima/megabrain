// Pure look of the composer: what the send button shows and how far the context ring is drawn.

/** ready: accent, sends; empty: grey, nothing to send; sending: a message is on its way; disabled: the box is; stop: ends the running turn. */
export type SendState = 'ready' | 'empty' | 'sending' | 'disabled' | 'stop'

/** While the agent's turn runs, an empty box turns the button into Stop; a typed draft still sends. */
export function sendState({ sendable, sending, disabled, running = false }: { sendable: boolean; sending: boolean; disabled: boolean; running?: boolean }): SendState {
  if (disabled) return 'disabled'
  if (sending) return 'sending'
  if (sendable) return 'ready'
  return running ? 'stop' : 'empty'
}

/** The stroke offset that draws a ring to a share of its circumference, never less than a sliver. */
export function ringOffset(fraction: number, circumference: number): number {
  const shown = Math.min(1, Math.max(0.02, fraction))
  return circumference * (1 - shown)
}

/** What the composer reports after an action: a send's outcome, a failed model switch, a refused file. */
export type Notice = { tone: 'ok' | 'bad'; text: string }

/** What a model switch leaves above the composer: nothing when it went through, the reason when it failed. */
export function switchNotice(result: Notice | null): Notice | null {
  return result !== null && result.tone === 'bad' ? result : null
}

/** A notice as the banner on the composer's top edge shows it. */
export interface Banner {
  tone: Notice['tone']
  /** alert interrupts a screen reader for a failure; status waits its turn. */
  role: 'status' | 'alert'
  text: string
  /** retry sends the draft again: only for a failed send whose draft is still there. */
  action: 'retry' | null
}

export function composerBanner(notice: Notice | null, { failedSend, sendable }: { failedSend: boolean; sendable: boolean }): Banner | null {
  if (notice === null) return null
  const bad = notice.tone === 'bad'
  return { tone: notice.tone, role: bad ? 'alert' : 'status', text: notice.text, action: bad && failedSend && sendable ? 'retry' : null }
}

/** What a key does in the ownership prompt: Enter confirms unless a button takes it, Esc cancels, Tab stays inside. */
export function promptKey({ key, onButton }: { key: string; onButton: boolean }): 'confirm' | 'cancel' | 'trap' | null {
  if (key === 'Escape') return 'cancel'
  if (key === 'Tab') return 'trap'
  if (key === 'Enter' && !onButton) return 'confirm'
  return null
}

/** The next control Tab reaches in a card of `count`, wrapping at both ends; -1 is focus outside the card. */
export function trapFocus(index: number, count: number, back: boolean): number | null {
  if (count === 0) return null
  if (index < 0) return back ? count - 1 : 0
  return (index + (back ? count - 1 : 1)) % count
}
