// A poll usually answers what it answered last time. Keeping the previous object when the new one
// is equal, and the previous parts that did not change when it is not, lets React skip the render
// and memoised rows keep their props.

/** `next`, with every part deeply equal to a part of `previous` replaced by that part. */
export function reuse<T>(previous: T | null | undefined, next: T): T {
  if (previous === null || previous === undefined) return next
  return share(previous, next) as T
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function share(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous
  if (Array.isArray(previous) && Array.isArray(next)) return shareArray(previous, next)
  if (isRecord(previous) && isRecord(next)) return shareRecord(previous, next)
  return next
}

function shareArray(previous: unknown[], next: unknown[]): unknown[] {
  // Entries are matched by position first; one that moved is found by its content.
  let byContent: Map<string, unknown> | null = null
  const moved = (item: unknown) => {
    if (typeof item !== 'object' || item === null) return undefined
    byContent ??= new Map(previous.filter((entry) => typeof entry === 'object' && entry !== null).map((entry) => [JSON.stringify(entry), entry]))
    return byContent.get(JSON.stringify(item))
  }
  const shared = next.map((item, index) => {
    if (index < previous.length) {
      const same = share(previous[index], item)
      if (same === previous[index]) return same
      return moved(item) ?? same
    }
    return moved(item) ?? item
  })
  return shared.length === previous.length && shared.every((item, index) => item === previous[index]) ? previous : shared
}

function shareRecord(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(next)
  let equal = keys.length === Object.keys(previous).length
  const shared: Record<string, unknown> = {}
  for (const key of keys) {
    const known = Object.hasOwn(previous, key)
    const value = known ? share(previous[key], next[key]) : next[key]
    if (!known || value !== previous[key]) equal = false
    shared[key] = value
  }
  return equal ? previous : shared
}
