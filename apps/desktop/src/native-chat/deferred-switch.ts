import type { NativeChat } from '@/api/schema'

// One process owns an agent session at a time, so the agent's TUI cannot attach while the chat's
// protocol process is mid-turn. Asking for the terminal then shows the terminal view at once with this
// notice and the chat's live tail, and hands the conversation over by itself when the turn ends. A
// small link stops the turn and opens the terminal now; going back to the chat cancels the wait.

export const TERMINAL_WAIT_NOTICE = 'Opens when this turn ends'

/** Whether the pane waits for the turn, and what to run now. */
export type DeferredStep = { waiting: boolean; run: 'nothing' | 'switch' | 'stop-then-switch' }

const turnRunning = (chat: NativeChat) => chat.state === 'working' || chat.state === 'waiting-approval'

export function requestTerminal(chat: NativeChat): DeferredStep {
  return turnRunning(chat) ? { waiting: true, run: 'nothing' } : { waiting: false, run: 'switch' }
}

/** The followed chat changed: a waiting pane hands over once the turn is no longer running. */
export function chatChanged(waiting: boolean, chat: NativeChat): DeferredStep {
  if (!waiting) return { waiting: false, run: 'nothing' }
  return turnRunning(chat) ? { waiting: true, run: 'nothing' } : { waiting: false, run: 'switch' }
}

export function stopAndOpen(waiting: boolean): DeferredStep {
  return waiting ? { waiting: false, run: 'stop-then-switch' } : { waiting: false, run: 'nothing' }
}

export function backToChat(_waiting: boolean): DeferredStep {
  return { waiting: false, run: 'nothing' }
}
