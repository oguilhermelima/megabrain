import { SearchIcon } from '@/advanced/SidebarTools'
import type { SheetField } from '@/components/filter-sheet-model'
import { anyValue, fromAny, people } from '@/github/page-parts'
import type { BoardFilterOptions, BoardFilters, BoardItemState, BoardItemType } from '@/tasks/board-filters'

// The Tasks board's filters (board-filters.ts): the search stays in the bar's row after the project
// picker; the rest go in the filter sheet (components/FilterSheet), with Show No status as a setting.

const typeNames: Record<BoardItemType, string> = { ISSUE: 'Issues', PULL_REQUEST: 'Pull requests', DRAFT_ISSUE: 'Drafts' }
const stateNames: Record<BoardItemState, string> = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' }

function named<T extends string>(label: string, values: readonly T[], names: Record<T, string>) {
  return [{ value: anyValue, label }, ...values.map((value) => ({ value, label: names[value] }))]
}

export function BoardSearch({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  return (
    <label className="flex h-9 w-44 min-w-[120px] shrink items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-3 text-ink-400 focus-within:border-accent/60">
      <SearchIcon />
      <input
        type="search"
        value={query}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || query === '') return
          event.preventDefault()
          onChange('')
        }}
        placeholder="Search title or #"
        aria-label="Search the board"
        className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink-100 placeholder:text-ink-400 focus:outline-none"
      />
    </label>
  )
}

/** The sheet's fields; `set` applies a change to the latest filters, and `noStatus` is null on a board without a Status field. */
export function boardSheetFields(filters: BoardFilters, options: BoardFilterOptions, set: (patch: Partial<BoardFilters>) => void, noStatus: { on: boolean; count: number; onChange: (on: boolean) => void } | null): SheetField[] {
  const fields: SheetField[] = [
    { kind: 'select', label: 'Type', value: filters.type ?? anyValue, options: named('Any type', options.types, typeNames), onChange: (value) => set({ type: options.types.find((type) => type === value) ?? null }) },
    { kind: 'select', label: 'State', value: filters.state ?? anyValue, options: named('Any state', options.states, stateNames), onChange: (value) => set({ state: options.states.find((state) => state === value) ?? null }) },
    { kind: 'select', label: 'Assignee', value: filters.assignee ?? anyValue, options: people('Any assignee', options.assignees), onChange: (value) => set({ assignee: fromAny(value) }) },
    { kind: 'select', label: 'Label', value: filters.label ?? anyValue, options: people('Any label', options.labels), onChange: (value) => set({ label: fromAny(value) }) },
  ]
  if (options.repositories.length > 0) fields.push({ kind: 'select', label: 'Repository', value: filters.repository ?? anyValue, options: people('Any repository', options.repositories), onChange: (value) => set({ repository: fromAny(value) }) })
  if (noStatus !== null) fields.push({ kind: 'switch', label: noStatus.count > 0 ? `Show No status (${noStatus.count})` : 'Show No status', on: noStatus.on, onChange: noStatus.onChange, setting: true })
  return fields
}
