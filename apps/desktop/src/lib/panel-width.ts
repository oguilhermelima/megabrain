/** How narrow, how wide and how wide at first a resizable panel may be, in CSS pixels. */
export interface WidthLimits {
  min: number
  max: number
  initial: number
}

export type WidthStorage = Pick<Storage, 'getItem' | 'setItem'>

export const sidebarLimits: WidthLimits = { min: 220, max: 480, initial: 300 }
export const runPanelLimits: WidthLimits = { min: 320, max: 760, initial: 420 }

export function clampWidth(width: number, limits: WidthLimits): number {
  if (!Number.isFinite(width)) return limits.initial
  return Math.min(limits.max, Math.max(limits.min, Math.round(width)))
}

// A remembered width is a per-viewer convenience: storage that is missing, blocked or holds
// something else gives the initial width.
export function readWidth(storage: () => WidthStorage, key: string, limits: WidthLimits): number {
  try {
    const raw = storage().getItem(key)
    if (raw === null || raw.trim() === '') return limits.initial
    return clampWidth(Number(raw), limits)
  } catch {
    return limits.initial
  }
}

export function writeWidth(storage: () => WidthStorage, key: string, width: number, limits: WidthLimits): number {
  const clamped = clampWidth(width, limits)
  try {
    storage().setItem(key, String(clamped))
  } catch {
    // Not remembering the width is fine.
  }
  return clamped
}
