import { clampWidth, type WidthLimits, type WidthStorage } from '@/lib/panel-width'

// What a Sheet (components/Sheet.tsx) remembers per viewer, under its id: whether it is pinned, whether
// a pinned sheet was left open, and its width. A floating sheet never reopens by itself; a pinned one
// comes back as it was left. Like every remembered panel, this is a convenience: storage that is
// missing, blocked or holds something else remembers nothing.

export const sheetLimits: WidthLimits = { min: 280, max: 560, initial: 320 }

/** The margin between a sheet and the edges it sits against, in pixels. */
export const sheetInset = 12

/** The top margin: under the window's 28px overlay title bar, then the inset. */
export const sheetTop = 28 + sheetInset

export interface SheetMemory {
  pinned: boolean
  /** Only a pinned sheet's: whether it stays open across visits to its page. */
  open: boolean
  width: number
}

export const emptySheetMemory: SheetMemory = { pinned: false, open: false, width: sheetLimits.initial }

export const sheetKey = (id: string) => `megabrain.sheet.${id}`

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function readSheetMemory(storage: () => WidthStorage, id: string): SheetMemory {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(sheetKey(id)) ?? 'null')
    if (!isRecord(parsed)) return emptySheetMemory
    const pinned = parsed.pinned === true
    return { pinned, open: pinned && parsed.open === true, width: typeof parsed.width === 'number' ? clampWidth(parsed.width, sheetLimits) : sheetLimits.initial }
  } catch {
    return emptySheetMemory
  }
}

/** Stores the memory as it will read back, and returns that. */
export function writeSheetMemory(storage: () => WidthStorage, id: string, memory: SheetMemory): SheetMemory {
  const kept: SheetMemory = { pinned: memory.pinned, open: memory.pinned && memory.open, width: clampWidth(memory.width, sheetLimits) }
  try {
    storage().setItem(sheetKey(id), JSON.stringify(kept))
  } catch {
    // Not remembering it is fine.
  }
  return kept
}

/** Where focus goes when a floating sheet closes: back where it was before it opened, if that is still on the page. */
export function focusBack<T extends { isConnected: boolean }>(before: T | null): T | null {
  return before !== null && before.isConnected ? before : null
}
