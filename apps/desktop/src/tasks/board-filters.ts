import type { GithubProjectItem } from '@/api/schema'
import { updatedWithin, updatedWithinOptions } from '@/components/filter-sheet-model'
import type { WidthStorage } from '@/lib/panel-width'

// What the Tasks board narrows its items to, over every column at once: words in the title or the
// number, an assignee, a label, the item's kind, its state, its repository and how recently it changed. The board remembers
// its filters per viewer, for each board (board-cache.ts boardKey), and whether it shows No status,
// for every board. Like the page's memory, that is a
// convenience: storage missing, blocked or holding something else remembers nothing.

export type BoardItemType = GithubProjectItem['type']
export type BoardItemState = 'OPEN' | 'CLOSED' | 'MERGED'

export interface BoardFilters {
  query: string
  assignee: string | null
  label: string | null
  type: BoardItemType | null
  state: BoardItemState | null
  repository: string | null
  /** Days, or "" for any time (filter-sheet-model updatedWithin). */
  updated: string
}

export const emptyBoardFilters: BoardFilters = { query: '', assignee: null, label: null, type: null, state: null, repository: null, updated: '' }

export const itemTypes: readonly BoardItemType[] = ['ISSUE', 'PULL_REQUEST', 'DRAFT_ISSUE']
export const itemStates: readonly BoardItemState[] = ['OPEN', 'CLOSED', 'MERGED']

/** An item's state as the filter reads it: a draft, which GitHub gives none, is open. */
export const itemState = (item: Pick<GithubProjectItem, 'state'>): BoardItemState => item.state ?? 'OPEN'

export const isFiltered = (filters: BoardFilters) => filters.query.trim() !== '' || filters.assignee !== null || filters.label !== null || filters.type !== null || filters.state !== null || filters.repository !== null || filters.updated !== ''

/** Whether the words match the item: in its title, ignoring case, or as the start of its number, with or without #. */
function matchesQuery(item: Pick<GithubProjectItem, 'title' | 'number'>, query: string): boolean {
  const words = query.trim().toLowerCase()
  if (words === '') return true
  if (item.title.toLowerCase().includes(words)) return true
  const digits = words.replace(/^#/, '')
  return /^\d+$/.test(digits) && item.number !== null && String(item.number).startsWith(digits)
}

export function matchesBoardFilters(item: GithubProjectItem, filters: BoardFilters, now = Date.now()): boolean {
  return (
    matchesQuery(item, filters.query) &&
    (filters.assignee === null || item.assignees.some((assignee) => assignee.login === filters.assignee)) &&
    (filters.label === null || item.labels.some((label) => label.name === filters.label)) &&
    (filters.type === null || item.type === filters.type) &&
    (filters.state === null || itemState(item) === filters.state) &&
    (filters.repository === null || item.repository === filters.repository) &&
    updatedWithin(item.updatedAt, filters.updated, now)
  )
}

export const filterBoardItems = (items: readonly GithubProjectItem[], filters: BoardFilters, now = Date.now()): GithubProjectItem[] => items.filter((item) => matchesBoardFilters(item, filters, now))

export interface BoardFilterOptions {
  assignees: string[]
  labels: string[]
  types: BoardItemType[]
  states: BoardItemState[]
  /** Offered only when the board holds items from more than one repository. */
  repositories: string[]
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))

/** What each filter offers: what the board's items carry, plus whatever is picked, so a picked value no item has still shows. */
export function boardFilterOptions(items: readonly GithubProjectItem[], filters: BoardFilters): BoardFilterOptions {
  const picked = <T>(value: T | null) => (value === null ? [] : [value])
  const types = new Set([...items.map((item) => item.type), ...picked(filters.type)])
  const states = new Set([...items.map(itemState), ...picked(filters.state)])
  const repositories = sorted([...items.flatMap((item) => (item.repository === null ? [] : [item.repository])), ...picked(filters.repository)])
  return {
    assignees: sorted([...items.flatMap((item) => item.assignees.map((assignee) => assignee.login)), ...picked(filters.assignee)]),
    labels: sorted([...items.flatMap((item) => item.labels.map((label) => label.name)), ...picked(filters.label)]),
    types: itemTypes.filter((type) => types.has(type)),
    states: itemStates.filter((state) => states.has(state)),
    repositories: repositories.length > 1 || filters.repository !== null ? repositories : [],
  }
}

export interface BoardPrefs {
  /** Each board's filters, by its boardKey. */
  filters: Readonly<Record<string, BoardFilters>>
  /** Whether the board shows its No status column, on every board; hidden unless asked for. */
  showNoStatus: boolean
}

export const boardPrefsKey = 'megabrain.tasks.board'

export const emptyBoardPrefs: BoardPrefs = { filters: {}, showNoStatus: false }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null)
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => values.find((entry) => entry === value) ?? null

/** One board's stored filters, each field kept only when it holds what that field takes. */
function readFilters(value: unknown): BoardFilters {
  if (!isRecord(value)) return emptyBoardFilters
  return {
    query: typeof value.query === 'string' ? value.query : '',
    assignee: stringOrNull(value.assignee),
    label: stringOrNull(value.label),
    type: oneOf(itemTypes, value.type),
    state: oneOf(itemStates, value.state),
    repository: stringOrNull(value.repository),
    updated: updatedWithinOptions.find((option) => option.value === value.updated)?.value ?? '',
  }
}

export function readBoardPrefs(storage: () => WidthStorage): BoardPrefs {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(boardPrefsKey) ?? 'null')
    if (!isRecord(parsed)) return emptyBoardPrefs
    const filters = isRecord(parsed.filters) ? Object.fromEntries(Object.entries(parsed.filters).map(([key, value]) => [key, readFilters(value)])) : {}
    return { filters, showNoStatus: parsed.showNoStatus === true }
  } catch {
    return emptyBoardPrefs
  }
}

export function writeBoardPrefs(storage: () => WidthStorage, prefs: BoardPrefs): BoardPrefs {
  try {
    // A board left unfiltered needs no entry.
    const filters = Object.fromEntries(Object.entries(prefs.filters).filter((entry) => isFiltered(entry[1])))
    storage().setItem(boardPrefsKey, JSON.stringify({ ...prefs, filters }))
  } catch {
    // Not remembering it is fine.
  }
  return prefs
}
