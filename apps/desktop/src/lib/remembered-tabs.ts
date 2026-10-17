import type { WidthStorage } from '@/lib/panel-width'

// The tab a page last showed on each of its items (a topic, an artifact), kept as [item id, tab] pairs
// with the one picked last at the end. Like a panel's width, a remembered tab is a convenience:
// storage missing, blocked or holding something else remembers nothing. Pairs, not an object, so the
// order picked survives (an object puts number-like keys first).

/** How many items keep their tab; the ones picked longest ago are forgotten first. */
const keptItems = 200

export function rememberedTabs<T extends string>(key: string, tabs: readonly T[]) {
  const isPair = (value: unknown): value is [string, T] => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && tabs.includes(value[1] as T)
  const readAll = (storage: () => WidthStorage): [string, T][] => {
    try {
      const parsed: unknown = JSON.parse(storage().getItem(key) ?? '[]')
      return Array.isArray(parsed) ? parsed.filter(isPair) : []
    } catch {
      return []
    }
  }
  return {
    read: (storage: () => WidthStorage, item: string): T | null => readAll(storage).find(([id]) => id === item)?.[1] ?? null,
    write: (storage: () => WidthStorage, item: string, tab: T): T => {
      const pairs = readAll(storage).filter(([id]) => id !== item)
      pairs.push([item, tab])
      try {
        storage().setItem(key, JSON.stringify(pairs.slice(-keptItems)))
      } catch {
        // Not remembering it is fine.
      }
      return tab
    },
  }
}
