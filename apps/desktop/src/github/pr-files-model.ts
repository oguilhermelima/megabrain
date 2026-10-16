import type { GithubPullRequestFile } from '@/api/schema'
import { filterFiles } from '@/github/review-model'

// What keeps a large pull request light: its file list read a page at a time as the list scrolls,
// diffs fetched only for the files near the viewport, huge diffs folded behind a button, and the
// patches kept for the most recently seen files only.

export const filesPerPage = 100
/** A file with more changed lines than this starts folded and fetches its diff on demand. */
export const foldAboveLines = 2000
/** How many files' patches stay in memory; the rest are fetched again when they come back. */
export const patchCacheSize = 50
/** Files either side of the visible ones whose diffs are fetched ahead. */
export const prefetchFiles = 2
/** How close to the end of the loaded files the list may scroll before the next page is asked. */
const pageAhead = 20

export interface FilePages {
  files: GithubPullRequestFile[]
  /** How many files the pull request changes; null before the first page. */
  total: number | null
  /** Pages read so far. */
  pages: number
  loading: boolean
  /** Set once a page comes back short, empty or completing the total. */
  done: boolean
}

export const emptyPages: FilePages = { files: [], total: null, pages: 0, loading: false, done: false }

/** Appends the page that follows the ones read; any other page (stale, repeated) is dropped. */
export function pageArrived(state: FilePages, page: { total: number; page: number; perPage: number; files: GithubPullRequestFile[] }): FilePages {
  if (page.page !== state.pages + 1) return state
  const files = [...state.files, ...page.files]
  return { files, total: page.total, pages: page.page, loading: false, done: page.files.length < page.perPage || files.length >= page.total }
}

/** The page to read next, or null: the first at once, then when the list nears its end, every page while a filter is on. */
export function nextPage(state: FilePages, lastShown: number, filtering: boolean): number | null {
  if (state.loading || state.done) return null
  if (state.pages === 0) return 1
  if (filtering || lastShown >= state.files.length - pageAhead) return state.pages + 1
  return null
}

export const isLargeDiff = (file: GithubPullRequestFile) => file.additions + file.deletions > foldAboveLines

/** Large, removed and viewed files start folded; the person's own fold wins after that. */
export const startsFolded = (file: GithubPullRequestFile, viewed: boolean) => viewed || file.status === 'removed' || isLargeDiff(file)

export interface IndexRange {
  start: number
  end: number
}

/** The visible files widened by `prefetch` either side, inside the list; null when nothing shows. */
export function diffWindow(range: IndexRange | null, count: number, prefetch = prefetchFiles): IndexRange | null {
  if (range === null || count === 0) return null
  return { start: Math.max(0, range.start - prefetch), end: Math.min(count - 1, range.end + prefetch) }
}

/** The open files in the window whose diff is neither held nor on its way. */
export function filesToFetch(files: GithubPullRequestFile[], window: IndexRange | null, known: ReadonlySet<string>, folded: ReadonlySet<string>): string[] {
  if (window === null) return []
  const paths: string[] = []
  for (let index = window.start; index <= window.end; index++) {
    const file = files[index]
    if (file !== undefined && !known.has(file.path) && !folded.has(file.path)) paths.push(file.path)
  }
  return paths
}

/**
 * Moves the touched keys to the front, most recent first, and releases the least recently seen past
 * the cap; a pinned key (a file on screen) is never released.
 */
export function touchLru(order: readonly string[], keys: string[], cap: number, pinned: ReadonlySet<string>): { order: string[]; evicted: string[] } {
  const touched = new Set(keys)
  const next = [...keys, ...order.filter((key) => !touched.has(key))]
  const evicted: string[] = []
  for (let index = next.length - 1; index >= 0 && next.length - evicted.length > cap; index--) {
    const key = next[index]
    if (key !== undefined && !pinned.has(key)) evicted.push(key)
  }
  const gone = new Set(evicted)
  return { order: next.filter((key) => !gone.has(key)), evicted }
}

/** The person's mark when they made one, else what GitHub reported. */
export const isViewed = (file: GithubPullRequestFile, marks: Readonly<Record<string, boolean>>) => marks[file.path] ?? file.viewed ?? false

export const viewedCount = (files: GithubPullRequestFile[], marks: Readonly<Record<string, boolean>>) => files.reduce((count, file) => count + (isViewed(file, marks) ? 1 : 0), 0)

/** The files the list shows: matching the query, without the viewed ones when they are hidden. */
export function shownFiles(files: GithubPullRequestFile[], query: string, hideViewed: boolean, marks: Readonly<Record<string, boolean>>): GithubPullRequestFile[] {
  const matching = filterFiles(files, query)
  return hideViewed ? matching.filter((file) => !isViewed(file, marks)) : matching
}
