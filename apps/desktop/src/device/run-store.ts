import { useSyncExternalStore } from 'react'
import { api } from '@/api'
import { idleRun, isActive, reduceRun, type RunAction, type RunState } from '@/device/device-model'

// A worktree's Maestro run lives here, outside the Device view, so switching to another tab or
// pane keeps the run's stream (and the CLI under it) going; the view only reads it.

interface Entry {
  state: RunState
  /** Kills the run's stream; set once it opened. */
  close: (() => void) | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

const entryOf = (root: string): Entry => entries.get(root) ?? { state: idleRun, close: null }

function dispatch(root: string, action: RunAction) {
  const entry = entryOf(root)
  const state = reduceRun(entry.state, action)
  if (state === entry.state) return
  entries.set(root, { ...entry, state })
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDeviceRun(root: string): RunState {
  return useSyncExternalStore(subscribe, () => entryOf(root).state)
}

export function startRun(root: string, flow: string, device: string) {
  if (isActive(entryOf(root).state)) return
  dispatch(root, { type: 'request', flow, device })
  api
    .maestroRun(
      root,
      flow,
      device,
      (event) => dispatch(root, { type: 'event', event }),
      (error) => dispatch(root, { type: 'end', error }),
    )
    .then(
      (close) => entries.set(root, { ...entryOf(root), close }),
      (error: unknown) => dispatch(root, { type: 'end', error: error instanceof Error ? error.message : String(error) }),
    )
}

/**
 * Stops the run: `maestro stop` ends a started one, which then reports itself stopped. A run still
 * queued has no process to stop yet, so its stream is killed instead.
 */
export async function stopRun(root: string) {
  const entry = entryOf(root)
  if (!isActive(entry.state)) return
  dispatch(root, { type: 'stop' })
  if (entry.state.phase === 'queued') {
    entry.close?.()
    dispatch(root, { type: 'end', error: null })
    return
  }
  await api.maestroStop(root).catch(() => {
    entry.close?.()
    dispatch(root, { type: 'end', error: null })
  })
}
