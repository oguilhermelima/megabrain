import { useSyncExternalStore } from 'react'
import { api } from '@/api'
import { bindingsOf, noShortcutOverrides, parseShortcutOverrides, saveShortcutOverrides, type ShortcutBindings, type ShortcutOverrides } from '@/lib/shortcuts'

// The shortcut overrides the person chose, read once from `settings get shortcuts` and shared by the
// window's key handlers and Settings > Shortcuts. While Settings records a combination, the
// handlers stand aside so the press is not also acted on.

let overrides: ShortcutOverrides = noShortcutOverrides
let bindings: ShortcutBindings = bindingsOf(noShortcutOverrides)
let recording = false
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: ShortcutOverrides) {
  overrides = next
  bindings = bindingsOf(next)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (loaded === null) loaded = api.shortcuts().then((raw) => publish(parseShortcutOverrides(raw)), () => {})
  return () => listeners.delete(listener)
}

/** The keys every shortcut has now, defaults included. */
export function useShortcutBindings(): ShortcutBindings {
  return useSyncExternalStore(subscribe, () => bindings)
}

export function useShortcutOverrides(): ShortcutOverrides {
  return useSyncExternalStore(subscribe, () => overrides)
}

/** Saves the next overrides; shown at once, and put back when the write fails. */
export async function saveShortcuts(next: ShortcutOverrides): Promise<void> {
  const before = overrides
  publish(next)
  try {
    await api.setShortcuts(saveShortcutOverrides(next))
  } catch (caught) {
    publish(before)
    throw caught
  }
}

export function setRecordingShortcut(on: boolean) {
  recording = on
}

/** True while Settings waits for a combination; key handlers ignore the press then. */
export function recordingShortcut(): boolean {
  return recording
}
