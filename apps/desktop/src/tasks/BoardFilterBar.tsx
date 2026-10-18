import { SearchIcon } from '@/advanced/SidebarTools'
import { FilterSelect, anyValue, fromAny, people } from '@/github/page-parts'
import { emptyBoardFilters, isFiltered, type BoardFilterOptions, type BoardFilters, type BoardItemState, type BoardItemType } from '@/tasks/board-filters'

// The Tasks board's filters, in the row under the bar after the project picker (board-filters.ts):
// a search over titles and numbers, then a select per filter, and Clear while any is set.

const typeNames: Record<BoardItemType, string> = { ISSUE: 'Issues', PULL_REQUEST: 'Pull requests', DRAFT_ISSUE: 'Drafts' }
const stateNames: Record<BoardItemState, string> = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' }

function named<T extends string>(label: string, values: readonly T[], names: Record<T, string>) {
  return [{ value: anyValue, label }, ...values.map((value) => ({ value, label: names[value] }))]
}

export function BoardFilterBar({ filters, options, onChange }: { filters: BoardFilters; options: BoardFilterOptions; onChange: (filters: BoardFilters) => void }) {
  const set = (patch: Partial<BoardFilters>) => onChange({ ...filters, ...patch })
  return (
    <>
      <label className="flex h-9 w-44 min-w-[120px] shrink items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-3 text-ink-400 focus-within:border-accent/60">
        <SearchIcon />
        <input
          type="search"
          value={filters.query}
          onChange={(event) => set({ query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || filters.query === '') return
            event.preventDefault()
            set({ query: '' })
          }}
          placeholder="Search title or #"
          aria-label="Search the board"
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-ink-100 placeholder:text-ink-400 focus:outline-none"
        />
      </label>
      <FilterSelect label="Type" value={filters.type ?? anyValue} options={named('Any type', options.types, typeNames)} onChange={(value) => set({ type: options.types.find((type) => type === value) ?? null })} />
      <FilterSelect label="State" value={filters.state ?? anyValue} options={named('Any state', options.states, stateNames)} onChange={(value) => set({ state: options.states.find((state) => state === value) ?? null })} />
      <FilterSelect label="Assignee" value={filters.assignee ?? anyValue} options={people('Any assignee', options.assignees)} onChange={(value) => set({ assignee: fromAny(value) })} />
      <FilterSelect label="Label" value={filters.label ?? anyValue} options={people('Any label', options.labels)} onChange={(value) => set({ label: fromAny(value) })} />
      {options.repositories.length > 0 && <FilterSelect label="Repository" value={filters.repository ?? anyValue} options={people('Any repository', options.repositories)} onChange={(value) => set({ repository: fromAny(value) })} />}
      {isFiltered(filters) && (
        <button type="button" onClick={() => onChange(emptyBoardFilters)} className="h-9 shrink-0 rounded-full px-3 text-[12.5px] font-semibold text-ink-400 hover:text-ink-100">
          Clear
        </button>
      )}
    </>
  )
}
