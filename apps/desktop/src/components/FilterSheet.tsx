import { useEffect } from 'react'
import { Checkbox } from '@/components/Checkbox'
import { activeCount, chipLabel, clearAll, clearField, isActive, type SheetField } from '@/components/filter-sheet-model'
import { pageDivider } from '@/lib/page'

// The page bars' filters (filter-sheet-model.ts): a Filter button in the bar's one row, with the count
// of filters set; a sheet from the right holding every filter, with Clear; and, only while any is set,
// a line of removable chips under the row. The sheet lies over the nearest positioned ancestor, so a
// page puts it inside a `relative` box that spans its body.

const pill = 'flex shrink-0 items-center gap-1.5 rounded-full border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent'

/** The button that opens the sheet; `place` matches the bar it sits in: the 30px page bar or a 36px filter row. */
export function FilterButton({ fields, open, onClick, place }: { fields: readonly SheetField[]; open: boolean; onClick: () => void; place: 'bar' | 'row' }) {
  const count = activeCount(fields)
  const size = place === 'bar' ? 'h-[30px] px-2.5 text-[12px]' : 'h-9 px-3.5 text-[13px]'
  const tone = count > 0 || open ? 'border-accent/50 bg-accent/[0.16] text-ink-100' : 'border-white/[0.08] bg-white/[0.05] text-ink-300 hover:text-ink-100'
  return (
    <button type="button" onClick={onClick} aria-expanded={open} aria-haspopup="dialog" className={`${pill} ${size} ${tone}`}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
        <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
      </svg>
      Filter
      {count > 0 && <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[11px] leading-none text-white tabular-nums">{count}</span>}
    </button>
  )
}

const cross = (
  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
)

/** The filters set, each a chip that clears it; nothing at all while none is set. */
export function FilterChips({ fields, className = '' }: { fields: readonly SheetField[]; className?: string }) {
  const set = fields.filter(isActive)
  if (set.length === 0) return null
  return (
    <ul aria-label="Filters set" className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {set.map((field) => (
        <li key={field.label}>
          <button type="button" onClick={() => clearField(field)} aria-label={`Remove ${chipLabel(field)}`} className="inline-flex h-6 items-center gap-1 rounded-full bg-white/[0.07] pr-1.5 pl-2.5 text-[11.5px] font-semibold text-ink-200 hover:bg-white/[0.12] hover:text-ink-100">
            {chipLabel(field)}
            <span className="text-ink-400">{cross}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Every filter of the page, from the right; Escape or a click beside it closes it. */
export function FilterSheet({ open, fields, onClose }: { open: boolean; fields: readonly SheetField[]; onClose: () => void }) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])
  if (!open) return null
  const count = activeCount(fields)
  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      <button type="button" tabIndex={-1} aria-label="Close filters" onClick={onClose} className="absolute inset-0 cursor-default bg-black/30" />
      <aside role="dialog" aria-label="Filters" className={`relative flex h-full w-[min(320px,100%)] flex-col border-l ${pageDivider} bg-ink-900 shadow-2xl shadow-black/60`}>
        <header className={`flex h-14 shrink-0 items-center gap-2 border-b ${pageDivider} pr-3 pl-5`}>
          <h2 className="text-[14px] font-semibold text-ink-100">Filters</h2>
          {count > 0 && <span className="text-[12px] text-ink-400 tabular-nums">{count} set</span>}
          <span className="ml-auto" />
          {count > 0 && (
            <button type="button" onClick={() => clearAll(fields)} className="h-8 rounded-full px-3 text-[12.5px] font-semibold text-ink-400 hover:text-ink-100">
              Clear
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close filters" className="grid size-8 place-items-center rounded-full text-ink-400 hover:bg-white/[0.06] hover:text-ink-100">
            {cross}
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {fields.map((field) =>
            field.kind === 'select' ? (
              <label key={field.label} className="block space-y-1.5">
                <span className="text-[12px] font-semibold text-ink-400">{field.label}</span>
                <select value={field.value} onChange={(event) => field.onChange(event.target.value)} style={{ colorScheme: 'dark' }} className={`h-9 w-full cursor-pointer truncate rounded-[10px] border px-3 text-[13px] outline-none focus:border-accent/60 ${isActive(field) ? 'border-accent/50 bg-accent/[0.12] text-ink-100' : 'border-white/[0.08] bg-white/[0.05] text-ink-200'}`}>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <Checkbox key={field.label} checked={field.on} onChange={field.onChange} className="text-[13px] text-ink-200">
                {field.label}
              </Checkbox>
            ),
          )}
        </div>
      </aside>
    </div>
  )
}
