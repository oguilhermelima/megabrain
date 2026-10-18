import type { WidthStorage } from '@/lib/panel-width'
import { itemKey } from '@/panes/pane-model'

// What the Tasks page keeps and picks: its one pane item, and what it remembers per viewer — the view
// shown (the repository's issues as a list, or a GitHub Projects board), the repository shown, and
// the board last picked for each repository. Like a panel's width, the memory is a convenience:
// storage missing, blocked or holding something else remembers nothing.

/** The Tasks page's item; the page is one in the layout, so its id never changes. */
export const tasksItem = itemKey('tasks', 'home')

export type TasksView = 'list' | 'board'

export interface TasksMemory {
  view: TasksView
  /** The repository's path. */
  repo: string | null
  /** The board picked for each repository, by its path: the project's number. */
  boards: Readonly<Record<string, number>>
}

export const tasksMemoryKey = 'megabrain.tasks'

export const emptyTasksMemory: TasksMemory = { view: 'list', repo: null, boards: {} }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function readTasksMemory(storage: () => WidthStorage): TasksMemory {
  try {
    const parsed: unknown = JSON.parse(storage().getItem(tasksMemoryKey) ?? 'null')
    if (!isRecord(parsed)) return emptyTasksMemory
    const boards = isRecord(parsed.boards) ? Object.fromEntries(Object.entries(parsed.boards).filter((entry): entry is [string, number] => Number.isInteger(entry[1]))) : {}
    return { view: parsed.view === 'board' ? 'board' : 'list', repo: typeof parsed.repo === 'string' ? parsed.repo : null, boards }
  } catch {
    return emptyTasksMemory
  }
}

export function writeTasksMemory(storage: () => WidthStorage, memory: TasksMemory): TasksMemory {
  try {
    storage().setItem(tasksMemoryKey, JSON.stringify(memory))
  } catch {
    // Not remembering it is fine.
  }
  return memory
}

/** The repository the page shows: the remembered one while it is still offered, else the first offered. */
export function shownRepo(offered: readonly string[], remembered: string | null): string | null {
  return remembered !== null && offered.includes(remembered) ? remembered : (offered[0] ?? null)
}

/** The board the page shows: the remembered one while the repository still has it, else its first open board, else its first. */
export function shownBoard(boards: readonly { number: number; closed: boolean }[], remembered: number | undefined): number | null {
  if (remembered !== undefined && boards.some((board) => board.number === remembered)) return remembered
  return (boards.find((board) => !board.closed) ?? boards[0])?.number ?? null
}
