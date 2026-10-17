import { isActive, type RunState } from '@/device/device-model'

// The Device tab's live screen: which frames to fetch, and how a pointer or a key on the rendered
// image becomes input on the simulator. The image is drawn object-contain, so a box of another
// aspect letterboxes it; points are the image's pixels divided by the device scale.

export interface Point {
  x: number
  y: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** The device point under a client point, or null in the letterbox bars or before the image decoded. */
export function screenPoint(client: Point, box: Box, image: { width: number; height: number }, scale: number): Point | null {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return null
  const fit = Math.min(box.width / image.width, box.height / image.height)
  const drawnWidth = image.width * fit
  const drawnHeight = image.height * fit
  const x = client.x - box.left - (box.width - drawnWidth) / 2
  const y = client.y - box.top - (box.height - drawnHeight) / 2
  if (x < 0 || y < 0 || x > drawnWidth || y > drawnHeight) return null
  const pixelsPerPoint = scale > 0 ? scale : 1
  return { x: Math.round(x / fit / pixelsPerPoint), y: Math.round(y / fit / pixelsPerPoint) }
}

/** Device points per screen pixel of the drawn image, to turn a wheel's pixels into points. */
export function pointsPerPixel(box: Box, image: { width: number; height: number }, scale: number): number {
  if (box.width <= 0 || box.height <= 0 || image.width <= 0 || image.height <= 0) return 0
  return 1 / Math.min(box.width / image.width, box.height / image.height) / (scale > 0 ? scale : 1)
}

/** How far, in screen pixels, a pointer may move between down and up and still be a tap. */
export const tapSlop = 8
const minSwipeMs = 50

export type Gesture = { kind: 'tap' } | { kind: 'swipe'; durationMs: number }

export function gestureOf(down: Point & { at: number }, up: Point & { at: number }): Gesture {
  if (Math.hypot(up.x - down.x, up.y - down.y) < tapSlop) return { kind: 'tap' }
  return { kind: 'swipe', durationMs: Math.max(minSwipeMs, Math.round(up.at - down.at)) }
}

export const pausedNote = 'Maestro is running: input paused'

/** Maestro drives the device for the whole run, so the person's input waits until it ends. */
export const inputPaused = (run: RunState, udid: string | null) => udid !== null && isActive(run) && run.device === udid

export const frameMs = 250
/** A window that lost focus keeps its screen live this long, so a glance at another app does not freeze it. */
export const blurGraceMs = 3_000

/** When the next frame is due, or null to pause until something changes. */
export function frameDelay({ visible, focused, blurredAt, now, booted }: { visible: boolean; focused: boolean; blurredAt: number | null; now: number; booted: boolean }): number | null {
  if (!visible || !booted) return null
  if (focused) return frameMs
  return blurredAt !== null && now - blurredAt < blurGraceMs ? frameMs : null
}

export type KeyAction = { type: 'text'; text: string } | { type: 'key'; name: string } | { type: 'release' }

const namedKeys: Record<string, string> = { Enter: 'return', Backspace: 'delete', Tab: 'tab', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** What a key pressed on the focused screen sends: Esc releases it, and the app's shortcuts stay the app's. */
export function keyAction(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): KeyAction | null {
  if (event.key === 'Escape') return { type: 'release' }
  if (event.metaKey || event.ctrlKey) return null
  const name = namedKeys[event.key]
  if (name !== undefined) return { type: 'key', name }
  return [...event.key].length === 1 ? { type: 'text', text: event.key } : null
}

export const phoneButtons = [
  { name: 'home', label: 'Home' },
  { name: 'lock', label: 'Lock' },
  { name: 'volume-down', label: 'Volume down' },
  { name: 'volume-up', label: 'Volume up' },
] as const

export const remoteButtons = ['up', 'down', 'left', 'right', 'select', 'menu', 'play-pause', 'home'] as const
