import { z } from 'zod'
import { githubProjectItemSchema, githubProjectSchema, type GithubProject, type GithubProjectItem } from '@/api/schema'
import type { WidthStorage } from '@/lib/panel-width'

// The Tasks board's last read, kept so opening it paints at once and reads again behind it: each
// repository's list of projects and each board's items, in memory for the app's life and per viewer
// in storage, small (the few boards opened last, each capped). A project's items come a page at a
// time; a read paints each page as it arrives over what the board showed before. Memory holds the
// same trimmed cache storage does, so boards opened one after another never grow it past that.

export const boardCacheKey = 'megabrain.tasks.board-cache'

/** How many repositories' project lists, and how many boards' items, storage keeps: the latest opened. */
export const keptEntries = 4
/** How many items the cache keeps of one board. */
export const keptItems = 300

export interface Cached<T> {
  value: T
  /** When it was read, in ms since the epoch. */
  at: number
}

export interface BoardCache {
  /** Each repository's projects, by its path. */
  projects: Readonly<Record<string, Cached<GithubProject[]>>>
  /** Each board's items, by boardKey. */
  items: Readonly<Record<string, Cached<GithubProjectItem[]> & { totalCount?: number; fullAt?: number }>>
}

export const emptyBoardCache: BoardCache = { projects: {}, items: {} }

/** How old a board's last read may be before the board reads again on its own. */
export const boardFreshMs = 60_000

/** How long a board may go without a full read before checking every page again. */
export const boardFullFreshMs = 600_000

/** Whether a periodic board read must visit every page: no full read yet, ten minutes old, or asked for. */
export const boardFullReadDue = (fullAt: number | undefined, now: number, asked: boolean) => asked || fullAt === undefined || now - fullAt >= boardFullFreshMs

/** Whether a board read last at `at` reads again now: never read, older than a minute, or asked for. */
export const boardReadDue = (at: number | undefined, now: number, asked: boolean) => asked || at === undefined || now - at >= boardFreshMs

/** How old a repository's list of projects may be before it is read again on its own. */
export const boardListFreshMs = 300_000

/** Whether a list of projects read last at `at` is read again now: never read, five minutes old, or asked for. */
export const boardListReadDue = (at: number | undefined, now: number, asked: boolean) => asked || at === undefined || now - at >= boardListFreshMs

/** A board's identity, the same under every repository whose items it holds. */
export const boardKey = (board: Pick<GithubProject, 'owner' | 'number'>) => `${board.owner}/${board.number}`

const cachedSchema = <T extends z.ZodType>(value: T) => z.object({ value, at: z.number() })
const storedSchema = z.object({
  projects: z.record(z.string(), cachedSchema(z.array(githubProjectSchema))),
  items: z.record(z.string(), cachedSchema(z.array(githubProjectItemSchema)).extend({ totalCount: z.number().optional(), fullAt: z.number().optional() })),
})

export function readBoardCache(storage: () => WidthStorage): BoardCache {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(storage().getItem(boardCacheKey) ?? 'null'))
    return parsed.success ? parsed.data : emptyBoardCache
  } catch {
    return emptyBoardCache
  }
}

/** The latest `keptEntries` entries, each list capped at `cap`. */
function kept<T>(entries: Readonly<Record<string, Cached<T[]>>>, cap: number): Record<string, Cached<T[]>> {
  const latest = Object.entries(entries)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, keptEntries)
  return Object.fromEntries(latest.map(([key, entry]) => [key, { ...entry, value: entry.value.slice(0, cap) }]))
}

/** The cache at its kept size: the latest entries, each board's items capped. */
const trimmed = (cache: BoardCache): BoardCache => ({ projects: kept(cache.projects, Number.POSITIVE_INFINITY), items: kept(cache.items, keptItems) })

/** Stores the cache trimmed to its kept size; storage missing, blocked or full keeps nothing. */
export function writeBoardCache(storage: () => WidthStorage, cache: BoardCache): void {
  try {
    storage().setItem(boardCacheKey, JSON.stringify(trimmed(cache)))
  } catch {
    // Not remembering it is fine.
  }
}

/** The cache for the app's life, read from storage the first time it is asked for; what it remembers is trimmed and stored. */
export function createBoardMemory(storage: () => WidthStorage): { get: () => BoardCache; remember: (next: BoardCache) => void } {
  let cache: BoardCache | null = null
  return {
    get: () => (cache ??= readBoardCache(storage)),
    remember: (next) => {
      cache = trimmed(next)
      writeBoardCache(storage, cache)
    },
  }
}

export const withProjects = (cache: BoardCache, root: string, projects: GithubProject[], at: number): BoardCache => ({ ...cache, projects: { ...cache.projects, [root]: { value: projects, at } } })

export const withItems = (cache: BoardCache, key: string, items: GithubProjectItem[], at: number, totalCount?: number, fullAt?: number): BoardCache => ({
  ...cache,
  items: { ...cache.items, [key]: { value: items, at, ...(totalCount === undefined ? {} : { totalCount }), ...(fullAt === undefined ? {} : { fullAt }) } },
})

/** Items in order, each id once: the first one read wins, as a page boundary can shift mid-read and repeat one. */
export function distinctItems(items: readonly GithubProjectItem[]): GithubProjectItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/**
 * The board while a read is under way: the pages read so far, then the items shown before that the
 * read has not reached yet, so a refresh grows nothing twice and drops nothing until it ends.
 */
export function mergedPages(read: readonly GithubProjectItem[], before: readonly GithubProjectItem[]): GithubProjectItem[] {
  return distinctItems([...read, ...before])
}

/**
 * Reads a board a page at a time, at most `maxPages`, handing `show` the items read so far after each
 * page (`last` on the final one). A read whose board is no longer the one shown (`current` false)
 * shows nothing more, asks for no more pages and answers null.
 */
export async function readBoardPages({ read, maxPages, current, show, unchanged, onTotalCount, onFullRead, fullRead = false }: {
  read: (after: string | null) => Promise<{ items: GithubProjectItem[]; next: string | null; totalCount?: number }>
  maxPages: number
  current: () => boolean
  show: (items: GithubProjectItem[], last: boolean) => void
  unchanged?: { items: GithubProjectItem[]; totalCount: number }
  onTotalCount?: (totalCount: number | undefined) => void
  onFullRead?: () => void
  fullRead?: boolean
}): Promise<GithubProjectItem[] | null> {
  let all: GithubProjectItem[] = []
  let after: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const next = await read(after)
    if (!current()) return null
    if (page === 0) onTotalCount?.(next.totalCount)
    all = distinctItems([...all, ...next.items])
    if (
      page === 0 &&
      !fullRead &&
      unchanged !== undefined &&
      next.totalCount !== undefined &&
      next.totalCount === unchanged.totalCount &&
      sameItems(next.items, unchanged.items.slice(0, next.items.length))
    ) {
      show(unchanged.items, true)
      return unchanged.items
    }
    after = next.next
    const last = after === null || page === maxPages - 1
    show(all, last)
    if (last) break
  }
  onFullRead?.()
  return all
}

const sameItems = (left: readonly GithubProjectItem[], right: readonly GithubProjectItem[]) =>
  left.length === right.length && left.every((item, index) => item.id === right[index]?.id && item.updatedAt === right[index]?.updatedAt)
