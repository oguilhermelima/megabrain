// A list read a page at a time from GitHub's cursors: page n (0-based here, 1-based on screen) is read
// from the cursor page n-1 answered with, so only pages already reached, and the one after the last of
// them, can be opened. The pages remember those cursors; previous goes back through them and next reads
// the cursor the current page answered with.

/** Entry n is the cursor page n is read from; page 0 reads from the start. */
export type Cursors = readonly (string | null)[]

export const firstCursors: Cursors = [null]

/**
 * Page `index` answered with `next`, the cursor of the page after it (null on the last page). A cursor
 * that differs from the one recorded means the list moved under the later pages, so their cursors go.
 */
export function withNext(cursors: Cursors, index: number, next: string | null): Cursors {
  if (index + 1 < cursors.length && cursors[index + 1] === next) return cursors
  const kept = cursors.slice(0, index + 1)
  return next === null ? kept : [...kept, next]
}

/** How many pages the total fills; an empty list still shows one. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size))
}

/** "26 to 50 of 687": the items this page shows among the total. */
export function pageRange(index: number, size: number, shown: number, total: number): string {
  if (shown === 0) return `0 of ${total}`
  const from = index * size + 1
  return `${from} to ${from + shown - 1} of ${total}`
}

/** The pages to offer as numbers around the current one: up to `radius` each side, only those with a known cursor. */
export function pageWindow(index: number, cursors: Cursors, count: number, radius = 2): number[] {
  const last = Math.min(cursors.length, count) - 1
  const pages: number[] = []
  for (let page = Math.max(0, index - radius); page <= Math.min(last, index + radius); page++) pages.push(page)
  return pages
}
