import { z } from 'zod'
import { githubProjectItemSchema, githubProjectSchema, type GithubProject, type GithubProjectItem } from '@/api/schema'
import type { WidthStorage } from '@/lib/panel-width'

// The Tasks board's last read, kept so opening it paints at once and reads again behind it: each
// repository's list of projects and each board's items, in memory for the app's life and per viewer
// in storage, small (the few boards opened last, each capped). A project's items come a page at a
// time; a read paints each page as it arrives over what the board showed before.

export const boardCacheKey = 'megabrain.tasks.board-cache'

/** How many repositories' project lists, and how many boards' items, storage keeps: the latest opened. */
export const keptEntries = 4
/** How many items storage keeps of one board; memory keeps them all. */
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
  items: Readonly<Record<string, Cached<GithubProjectItem[]>>>
}

export const emptyBoardCache: BoardCache = { projects: {}, items: {} }

/** A board's identity, the same under every repository whose items it holds. */
export const boardKey = (board: Pick<GithubProject, 'owner' | 'number'>) => `${board.owner}/${board.number}`

const cachedSchema = <T extends z.ZodType>(value: T) => z.object({ value, at: z.number() })
const storedSchema = z.object({
  projects: z.record(z.string(), cachedSchema(z.array(githubProjectSchema))),
  items: z.record(z.string(), cachedSchema(z.array(githubProjectItemSchema))),
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
  return Object.fromEntries(latest.map(([key, entry]) => [key, { value: entry.value.slice(0, cap), at: entry.at }]))
}

/** Stores the cache trimmed to its kept size; storage missing, blocked or full keeps nothing. */
export function writeBoardCache(storage: () => WidthStorage, cache: BoardCache): void {
  try {
    storage().setItem(boardCacheKey, JSON.stringify({ projects: kept(cache.projects, Number.POSITIVE_INFINITY), items: kept(cache.items, keptItems) }))
  } catch {
    // Not remembering it is fine.
  }
}

export const withProjects = (cache: BoardCache, root: string, projects: GithubProject[], at: number): BoardCache => ({ ...cache, projects: { ...cache.projects, [root]: { value: projects, at } } })

export const withItems = (cache: BoardCache, key: string, items: GithubProjectItem[], at: number): BoardCache => ({ ...cache, items: { ...cache.items, [key]: { value: items, at } } })

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
