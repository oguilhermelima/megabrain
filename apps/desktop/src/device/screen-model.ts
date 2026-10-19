import type { SimulatorKind } from '@/api/schema'
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

/** Wheel deltas gathered for one device, in its points, from where the wheel started. */
export interface WheelGather extends Point {
  target: string
  dx: number
  dy: number
}

/** Adds a wheel event to the gathered one; an event for another device starts again. */
export function gatherWheel(pending: WheelGather | null, next: WheelGather): WheelGather {
  if (pending === null || pending.target !== next.target) return next
  return { ...pending, dx: pending.dx + next.dx, dy: pending.dy + next.dy }
}

/** The scroll to send once the wheel rests, or null when another device (or none) is shown by then. */
export function wheelScroll(gather: WheelGather, shown: string | null): WheelGather | null {
  if (gather.target !== shown) return null
  return { ...gather, dx: Math.round(gather.dx), dy: Math.round(gather.dy) }
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

// Zoom: 'fit' takes the largest box that fits; a number is CSS pixels per device point, so 1 is
// 100 percent. Input needs nothing more, as screenPoint reads the drawn image's own box.
export type Zoom = 'fit' | number

export const zoomSteps = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const

/** A device's size in points: its frame's pixels over its scale. */
export function pointSize(frame: { width: number; height: number; scale: number }): { width: number; height: number } {
  const scale = frame.scale > 0 ? frame.scale : 1
  return { width: frame.width / scale, height: frame.height / scale }
}

/** The zoom fit gives in `box`: the tighter side's ratio, or 0 before anything has a size. */
export function fitZoom(box: { width: number; height: number }, points: { width: number; height: number }): number {
  if (box.width <= 0 || box.height <= 0 || points.width <= 0 || points.height <= 0) return 0
  return Math.min(box.width / points.width, box.height / points.height)
}

export function zoomedSize(points: { width: number; height: number }, zoom: number): { width: number; height: number } {
  return { width: points.width * zoom, height: points.height * zoom }
}

const effective = (zoom: Zoom, fit: number) => (zoom === 'fit' ? fit : zoom)

/** The next step above where the screen is, or the last one. */
export function zoomIn(zoom: Zoom, fit: number): number {
  const now = effective(zoom, fit)
  return zoomSteps.find((step) => step > now + 1e-6) ?? zoomSteps[7]
}

/** The next step below where the screen is, or the first one. */
export function zoomOut(zoom: Zoom, fit: number): number {
  const now = effective(zoom, fit)
  return [...zoomSteps].reverse().find((step) => step < now - 1e-6) ?? zoomSteps[0]
}

export const zoomPercent = (zoom: Zoom, fit: number) => Math.round(effective(zoom, fit) * 100)

/** The zoom bar's readout: the percent, or a dash before the device's size is known (fit 0), as the Fit button beside it already says Fit. */
export const zoomLabel = (zoom: Zoom, fit: number) => (fit > 0 ? `${zoomPercent(zoom, fit)}%` : '–')

// The frame drawn around the screen. A TV is a 16:9 screen with a thin bezel whatever image it
// shows, so it never borrows a phone's shape while its first frame is on the way; a phone or a
// tablet takes its screen's aspect, rounded like a handset upright and less so on its side.

export const tvAspect = 16 / 9

export type FrameShape = 'tv' | 'browser' | 'landscape' | 'portrait'

/**
 * The frame for a device of `kind` whose screen is `aspect` wide per unit of height, and the screen's
 * ratio to draw. A browser is a plain viewport of its CSS size's aspect.
 */
export function deviceFrame(kind: SimulatorKind | 'web' | null, aspect: number): { shape: FrameShape; ratio: number } {
  if (kind === 'tv') return { shape: 'tv', ratio: tvAspect }
  if (kind === 'web') return { shape: 'browser', ratio: aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 10 }
  return { shape: aspect > 1 ? 'landscape' : 'portrait', ratio: aspect }
}

/**
 * A stream frame's pixels per point: a simulator's own scale; a browser's frame width over its CSS
 * width, as the stream may send it downscaled, else its device scale before a frame came.
 */
export function frameScale(frameWidth: number, browser: { width: number; scale: number } | null, simulatorScale: number): number {
  if (browser === null) return simulatorScale > 0 ? simulatorScale : 1
  if (frameWidth > 0 && browser.width > 0) return frameWidth / browser.width
  return browser.scale > 0 ? browser.scale : 1
}
