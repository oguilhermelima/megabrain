import { CliError } from '@/api/adapter'
import type { ChatDaemonStatus } from '@/api/schema'

// What the app does with the chatd it finds on start. It never drains or restarts a daemon that can
// still serve it: an older compatible one keeps every chat streaming and is retired, so it exits by
// itself once idle. Only a daemon this CLI cannot speak to is stopped, and then only by draining it,
// which lets running turns finish and leaves queued messages for the next daemon.

export type Reconnect =
  | { kind: 'none' }
  | { kind: 'current' }
  | { kind: 'older'; liveChats: number; superseded: boolean }
  | { kind: 'incompatible'; liveChats: number }

/** How the person answered the incompatible notice; Wait is the default. */
export type PauseChoice = 'wait' | 'restart-now'
/** Waiting for chats to finish, or draining the old daemon. */
export type PausePhase = 'waiting' | 'restarting'

export function reconnectDecision(status: ChatDaemonStatus, appVersion: string): Reconnect {
  if (!status.running) return { kind: 'none' }
  const liveChats = status.liveChats ?? 0
  if (status.compatible === false) return { kind: 'incompatible', liveChats }
  // A daemon that does not say which megabrain started it predates retiring; it keeps serving as it is.
  if (status.daemonVersion === undefined || status.daemonVersion === appVersion) return { kind: 'current' }
  return { kind: 'older', liveChats, superseded: status.superseded === true }
}

/** The one call the decision asks for now; 'wait' means read the status again later. */
export function reconnectStep(decision: Reconnect, choice: PauseChoice): 'nothing' | 'retire' | 'wait' | 'drain' {
  if (decision.kind === 'older') return decision.superseded ? 'nothing' : 'retire'
  if (decision.kind !== 'incompatible') return 'nothing'
  return decision.liveChats === 0 || choice === 'restart-now' ? 'drain' : 'wait'
}

/** An older or incompatible daemon is read again until it has gone. */
export function watchesChatd(decision: Reconnect): boolean {
  return decision.kind === 'older' || decision.kind === 'incompatible'
}

export function isIncompatible(caught: unknown): boolean {
  return caught instanceof CliError && caught.refusalCode === 'chatd-incompatible'
}

export interface ChatdNotice {
  tone: 'muted' | 'attention'
  text: string
  dismissible: boolean
  actions: { id: PauseChoice; label: string; default: boolean }[]
}

export function chatdNotice(decision: Reconnect, phase: PausePhase): ChatdNotice | null {
  if (decision.kind === 'older') {
    if (decision.liveChats === 0) return null
    const chats = decision.liveChats === 1 ? '1 chat finishes' : `${decision.liveChats} chats finish`
    return { tone: 'muted', text: `Update applied · ${chats} on the previous version`, dismissible: true, actions: [] }
  }
  if (decision.kind !== 'incompatible') return null
  if (phase === 'restarting') return { tone: 'attention', text: 'Restarting the chats on the new version: running turns finish first', dismissible: false, actions: [] }
  const working = decision.liveChats === 1 ? '1 is working' : `${decision.liveChats} are working`
  return {
    tone: 'attention',
    text: `This update needs the chats to pause: ${working}`,
    dismissible: false,
    actions: [
      { id: 'wait', label: 'Wait', default: true },
      { id: 'restart-now', label: 'Restart now', default: false },
    ],
  }
}

const incompatibleListeners = new Set<() => void>()

/** A chat call was refused with chatd-incompatible; the watcher reads the status again. */
export function reportIncompatible() {
  for (const listener of incompatibleListeners) listener()
}

export function onIncompatible(listener: () => void): () => void {
  incompatibleListeners.add(listener)
  return () => incompatibleListeners.delete(listener)
}

/** How long to wait after `failures` failed status reads in a row: 1 s, doubling, never past a minute. */
export function chatdRetryMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, failures - 1), 60_000)
}
