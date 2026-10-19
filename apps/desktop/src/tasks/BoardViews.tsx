import type { ReactNode } from 'react'
import { SearchIcon } from '@/advanced/SidebarTools'
import type { GithubProject, GithubProjectItem, GithubProjectView } from '@/api/schema'
import { Avatar, LabelChip } from '@/github/parts'
import { cardChips, type CardChip } from '@/tasks/board-view'

// A GitHub Project's saved views as tabs over the board, the bar that holds the shown view's filter,
// and the table a table-layout view draws. The filter is evaluated by the data layer
// (api.githubProjectFilter); editing it here never changes the view saved on GitHub.

function BoardLayoutIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.75" y="2.75" width="3.5" height="10.5" rx="1" />
      <rect x="6.25" y="2.75" width="3.5" height="7" rx="1" />
      <rect x="10.75" y="2.75" width="3.5" height="9" rx="1" />
    </svg>
  )
}

function TableLayoutIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
      <path d="M1.75 6.25h12.5M1.75 9.75h12.5M6 6.25v7" />
    </svg>
  )
}

function RoadmapLayoutIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M2 4h6M5 8h8M3 12h5" />
    </svg>
  )
}

const layoutIcons: Record<GithubProjectView['layout'], () => ReactNode> = { BOARD_LAYOUT: BoardLayoutIcon, TABLE_LAYOUT: TableLayoutIcon, ROADMAP_LAYOUT: RoadmapLayoutIcon }

export function ViewTabs({ views, shown, onShow }: { views: readonly GithubProjectView[]; shown: string | null; onShow: (id: string) => void }) {
  if (views.length === 0) return null
  return (
    <div role="tablist" aria-label="Views" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {views.map((view) => {
        const Icon = layoutIcons[view.layout]
        const selected = view.id === shown
        return (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onShow(view.id)}
            className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold transition-colors ${selected ? 'bg-white/[0.1] text-ink-100' : 'text-ink-400 hover:bg-white/[0.05] hover:text-ink-100'}`}>
            <Icon />
            {view.name}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The view's filter, editable: what it matches is counted beside it; an edit is marked unsaved with
 * a reset to the view's own filter; qualifiers the evaluator could not apply are listed quietly.
 */
export function ViewFilterBar({ value, saved, count, warnings, onChange }: { value: string; saved: string; count: number | null; warnings: readonly string[]; onChange: (value: string) => void }) {
  const unsaved = value.trim() !== saved.trim()
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <label className="flex h-9 min-w-[180px] flex-1 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.05] px-3 text-ink-400 focus-within:border-accent/60">
        <SearchIcon />
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || value === '') return
            event.preventDefault()
            onChange('')
          }}
          spellCheck={false}
          placeholder="Filter by keyword or by field"
          aria-label="Filter the view"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-ink-100 outline-none placeholder:font-sans placeholder:text-ink-500"
        />
        {count !== null && <span className="shrink-0 text-[12px] text-ink-500 tabular-nums">{count} {count === 1 ? 'item' : 'items'}</span>}
        {value !== '' && (
          <button type="button" onClick={() => onChange('')} aria-label="Clear the filter" className="grid size-5 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
            ×
          </button>
        )}
      </label>
      {unsaved && (
        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-400">
          Unsaved changes
          <button type="button" onClick={() => onChange(saved)} className="rounded-full px-2 py-0.5 font-semibold text-accent hover:bg-accent/[0.12]">
            Reset
          </button>
        </span>
      )}
      {warnings.length > 0 && (
        <span title={`Not applied: ${warnings.join(', ')}`} className="shrink-0 truncate text-[12px] text-ink-500">
          Ignored: {warnings.join(', ')}
        </span>
      )}
    </div>
  )
}

/** A table-layout view: a row per item, a column per visible field, each cell drawn as the card's chips for that field. */
export function ViewTable({ project, view, items, onOpen }: { project: GithubProject; view: GithubProjectView; items: readonly GithubProjectItem[]; onOpen: (item: GithubProjectItem) => void }) {
  const fields = view.visibleFields.filter((field) => field.name.toLowerCase() !== 'title')
  return (
    <table className="w-full min-w-max border-collapse text-left text-[12.5px]">
      <thead className="sticky top-0 z-10 bg-ink-950">
        <tr className="border-b border-white/[0.07] text-ink-400">
          <th className="px-3 py-2 font-semibold">Title</th>
          {fields.map((field) => (
            <th key={field.id} className="px-3 py-2 font-semibold whitespace-nowrap">
              {field.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b border-white/[0.04] hover:bg-white/[0.03]">
            <td className="max-w-[420px] px-3 py-2">
              <button type="button" onClick={() => onOpen(item)} className="block max-w-full truncate text-left font-semibold text-ink-100 hover:underline">
                {item.title}
                {item.number !== null && <span className="ml-1.5 font-normal text-ink-500 tabular-nums">#{item.number}</span>}
              </button>
            </td>
            {fields.map((field) => (
              <td key={field.id} className="px-3 py-2 whitespace-nowrap text-ink-300">
                {field.name.toLowerCase() === 'repository' ? (item.repository ?? '') : <CellChips item={item} project={project} view={{ ...view, visibleFields: [field] }} />}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** A card's chips (board-view cardChips): labels and options in their colours, values plainly, assignees as avatars. */
export function Chips({ chips }: { chips: readonly CardChip[] }) {
  return (
    <>
      {chips.map((chip) =>
        chip.kind === 'label' ? (
          <LabelChip key={`label:${chip.name}`} name={chip.name} color={chip.color} />
        ) : chip.kind === 'option' ? (
          <span key={`option:${chip.field}`} title={chip.field} style={{ color: chip.color, borderColor: `${chip.color}66`, backgroundColor: `${chip.color}1f` }} className="inline-flex h-[20px] shrink-0 items-center rounded-full border px-2 text-[11.5px] leading-none font-semibold whitespace-nowrap">
            {chip.name}
          </span>
        ) : chip.kind === 'value' ? (
          <span key={`value:${chip.field}`} title={chip.field} className="inline-flex h-[20px] shrink-0 items-center gap-1 rounded-full border border-white/[0.1] px-2 text-[11.5px] leading-none whitespace-nowrap text-ink-300">
            <span className="text-ink-500">{chip.field}</span>
            {chip.text}
          </span>
        ) : (
          <span key="assignees" className="ml-auto flex -space-x-1.5" title={`Assigned to ${chip.logins.join(', ')}`}>
            {chip.logins.slice(0, 3).map((login) => (
              <span key={login} className="rounded-full ring-2 ring-ink-850">
                <Avatar login={login} size={18} />
              </span>
            ))}
          </span>
        ),
      )}
    </>
  )
}

function CellChips({ item, project, view }: { item: GithubProjectItem; project: GithubProject; view: GithubProjectView }) {
  return (
    <span className="flex items-center gap-1">
      <Chips chips={cardChips(item, project, view)} />
    </span>
  )
}
