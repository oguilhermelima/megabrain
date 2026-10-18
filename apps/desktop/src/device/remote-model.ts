import type { WidthStorage } from '@/lib/panel-width'

// The Apple TV remote floats over the Device tab's screen: dragged anywhere inside it, folded to a
// round handle and back. Its place is kept as distances from the view's bottom-right corner, so a
// resize keeps it where the person put it relative to that corner, and per viewer.

/** Distances, in CSS pixels, from the view's right and bottom edges to the remote's. */
export interface RemotePlace {
  right: number
  bottom: number
}

export interface RemoteState extends RemotePlace {
  collapsed: boolean
}

export const remoteKey = 'megabrain.device.remote'

/** The gap the remote keeps from the view's edges. */
export const remoteMargin = 16
/** The band along the bottom the zoom bar takes (its 16 px inset, its 32 px height and a gap), which the remote never enters. */
export const zoomBarBand = 56

export const defaultRemote: RemoteState = { right: remoteMargin, bottom: zoomBarBand, collapsed: false }

/**
 * The place nearest `place` that keeps a remote of `size` inside a `view`, clear of the zoom bar's
 * band. A view too small for it pins it to the bottom-right corner above the band.
 */
export function clampRemote(place: RemotePlace, size: { width: number; height: number }, view: { width: number; height: number }): RemotePlace {
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high))
  return {
    right: clamp(place.right, remoteMargin, Math.max(remoteMargin, view.width - size.width - remoteMargin)),
    bottom: clamp(place.bottom, zoomBarBand, Math.max(zoomBarBand, view.height - size.height - remoteMargin)),
  }
}

/** Where a drag that started at `from` and moved by `delta` client pixels puts the remote, before clamping. */
export const dragRemote = (from: RemotePlace, delta: { x: number; y: number }): RemotePlace => ({ right: from.right - delta.x, bottom: from.bottom - delta.y })

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// Like a panel's open state, a remembered place is a convenience: storage missing, blocked or
// holding something else leaves the remote at its default.
export function readRemote(storage: () => WidthStorage): RemoteState {
  try {
    const raw = storage().getItem(remoteKey)
    if (raw === null) return defaultRemote
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return defaultRemote
    const { right, bottom, collapsed } = parsed as Record<string, unknown>
    return {
      right: finite(right) ? right : defaultRemote.right,
      bottom: finite(bottom) ? bottom : defaultRemote.bottom,
      collapsed: typeof collapsed === 'boolean' ? collapsed : defaultRemote.collapsed,
    }
  } catch {
    return defaultRemote
  }
}

export function writeRemote(storage: () => WidthStorage, state: RemoteState): RemoteState {
  try {
    storage().setItem(remoteKey, JSON.stringify({ right: Math.round(state.right), bottom: Math.round(state.bottom), collapsed: state.collapsed }))
  } catch {
    // Not remembering it is fine.
  }
  return state
}
