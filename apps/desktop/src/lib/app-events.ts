import { api } from '@/api'

// What the background reads listen to: whether this window shows, and actions the person just
// took that change what megabrain reports.

type Listener = () => void

const actionListeners = new Set<Listener>()

/** Something changed megabrain's state (import, hide, remove, send); reads that show it refresh. */
export function announceAction() {
  for (const listener of actionListeners) listener()
}

export function onAction(listener: Listener): () => void {
  actionListeners.add(listener)
  return () => actionListeners.delete(listener)
}

const visibilityListeners = new Set<Listener>()
let visible = typeof document === 'undefined' || document.visibilityState === 'visible'
let watching = false

function setVisible(next: boolean) {
  if (next === visible) return
  visible = next
  for (const listener of visibilityListeners) listener()
}

// The document's own state follows a minimised or covered window; the native window state also
// catches one hidden to the tray. It is asked only when one of these events fires, not per read.
function recheck() {
  if (document.visibilityState !== 'visible') {
    setVisible(false)
    return
  }
  api.windowVisible().then(setVisible, () => setVisible(true))
}

function watch() {
  if (watching || typeof window === 'undefined') return
  watching = true
  document.addEventListener('visibilitychange', recheck)
  window.addEventListener('focus', recheck)
  window.addEventListener('blur', recheck)
  recheck()
}

export function windowShows(): boolean {
  watch()
  return visible
}

export function onVisibility(listener: Listener): () => void {
  watch()
  visibilityListeners.add(listener)
  return () => visibilityListeners.delete(listener)
}

export function onFocus(listener: Listener): () => void {
  window.addEventListener('focus', listener)
  return () => window.removeEventListener('focus', listener)
}
