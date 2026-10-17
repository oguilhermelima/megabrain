import type { Notice } from '@/chat/composer-look'
import type { NativeChat } from '@/api/schema'

// One process owns an agent session at a time. While the agent's TUI owns it, chatd follows the
// terminal's session log, so the chat view is always current: going to the chat only shows it, and
// the chat takes the session back (the daemon's safe handoff) when the person takes over or sends.

export type Owner = 'chat' | 'terminal' | 'none'
export type View = NativeChat['mode']
/** A draft the busy terminal kept: none, held in the composer, or armed to send once the terminal is free. */
export type Hold = 'none' | 'held' | 'armed'

export const OWNER_NOTICE = 'The terminal is driving this session'
export const TERMINAL_BUSY_NOTICE = 'The terminal is still answering; your message is kept'
export const CHAT_BUSY_NOTICE = 'The chat is still answering; switch to the terminal when it is done'
const ARMED_NOTICE = 'Sends when the terminal is free'

/** Who owns the session; a daemon that does not report it means the mode. */
export function ownerOf(chat: NativeChat): Owner {
  if (chat.owner === 'chat' || chat.owner === 'terminal' || chat.owner === 'none') return chat.owner
  return chat.mode === 'terminal' ? 'terminal' : 'chat'
}

const turnRunning = (chat: NativeChat) => chat.state === 'working' || chat.state === 'waiting-approval'

/** A refusal the daemon names in its error text; foreign is another process the person opened. */
export function refusalOf(error: unknown): 'terminal-busy' | 'chat-busy' | 'foreign' | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const code = error instanceof Error && 'refusalCode' in error ? String(error.refusalCode) : ''
  if (code === 'terminal-busy' || text.includes('terminal-busy')) return 'terminal-busy'
  if (code === 'chat-busy' || text.includes('chat-busy')) return 'chat-busy'
  if (text.includes('already open in another process')) return 'foreign'
  return null
}

/** show: only the view moves; switch: the session is handed to the terminal. */
export function viewSwitch(chat: NativeChat, to: View): 'show' | 'switch' {
  return to === 'chat' || ownerOf(chat) === 'terminal' ? 'show' : 'switch'
}

/** A refused switch to the terminal: the chat mid-turn is a plain message, anything else an error. */
export function switchFailure(error: unknown): { notice: string } | { error: true } {
  return refusalOf(error) === 'chat-busy' ? { notice: CHAT_BUSY_NOTICE } : { error: true }
}

export function sendRoute(chat: NativeChat): 'take-over-first' | 'send' {
  return ownerOf(chat) === 'terminal' ? 'take-over-first' : 'send'
}

/** A send the busy terminal refused keeps its draft (a bad notice); null rethrows. */
export function sendFailure(error: unknown): Notice | null {
  return refusalOf(error) === 'terminal-busy' ? { tone: 'bad', text: TERMINAL_BUSY_NOTICE } : null
}

/** The slim line above the composer while the terminal drives. */
export function ownerBar(chat: NativeChat, hold: Hold): { text: string; action: 'take-over' | 'send-when-free' | 'cancel' } | null {
  if (ownerOf(chat) !== 'terminal') return null
  if (hold === 'armed') return { text: ARMED_NOTICE, action: 'cancel' }
  return { text: OWNER_NOTICE, action: hold === 'held' ? 'send-when-free' : 'take-over' }
}

export function sendsWhenFree(hold: Hold, chat: NativeChat): boolean {
  return hold === 'armed' && !(ownerOf(chat) === 'terminal' && turnRunning(chat))
}
