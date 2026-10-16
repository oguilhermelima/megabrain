import type { TerminalSession } from '@/api/schema'

// Terminal views kept alive by key (a chat id) for the app run: leaving the view only takes its screen
// off the page, so coming back shows the same xterm, scrollback included, without rebuilding it or
// waiting for the program to repaint. Kept here, apart from the view, so code that never shows a
// terminal can end a kept session without loading xterm.

export interface KeptTerminal {
  /** The terminal it shows now; null between programs (before the first, after one exited or closed). */
  session: TerminalSession | null
  /** Stops listening to the current session's output. */
  unlisten: (() => void) | undefined
}

export const keptTerminals = new Map<string, KeptTerminal>()

/** The kept view stops showing its session (it was closed); its screen and scrollback stay for the next one. */
export function endKeptSession(key: string) {
  const kept = keptTerminals.get(key)
  if (kept === undefined) return
  kept.unlisten?.()
  kept.unlisten = undefined
  kept.session = null
}

/** Loads the terminal view's code ahead of the first switch, so the switch does not wait for it. */
export function preloadTerminalView() {
  void import('@/terminal/TerminalView')
}
