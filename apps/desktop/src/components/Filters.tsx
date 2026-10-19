import { Checkbox } from '@/components/Checkbox'
import { activeCount, chipLabel, clearAll, clearField, isActive, type SheetField } from '@/components/filter-sheet-model'
import { Sheet, type SheetState } from '@/components/Sheet'

// The page bars' filters (filter-sheet-model.ts): a Filter button in the bar's one row, with the count
// of filters set; a Sheet (components/Sheet) holding every filter, with Clear; and, only while any is
// set, a line of removable chips under the row. Every field applies as it changes, so a pinned sheet
// filters the page live and needs no Apply.

const pill = 'flex shrink-0 items-center gap-1.5 rounded-full border font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-accent'

/** The button that opens the sheet; `place` matches the bar it sits in: the 30px page bar or a 36px filter row. */
export function FilterButton({ fields, sheet, place }: { fields: readonly SheetField[]; sheet: SheetState; place: 'bar' | 'row' }) {
  const count = activeCount(fields)
  const size = place === 'bar' ? 'h-[30px] px-2.5 text-[12px]' : 'h-9 px-3.5 text-[13px]'
  const tone = count > 0 || sheet.open ? 'border-accent/50 bg-accent/[0.16] text-ink-100' : 'border-white/[0.08] bg-white/[0.05] text-ink-300 hover:text-ink-100'
  return (
    <button type="button" onClick={sheet.toggle} aria-expanded={sheet.open} aria-haspopup="dialog" className={`${pill} ${size} ${tone}`}>
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

/** Every filter of the page on its Sheet, with Clear while any is set. */
/** The filters sheet; `error` says which options could not be read, so their empty lists are not taken for none. */
export function FilterPanel({ sheet, fields, error = null }: { sheet: SheetState; fields: readonly SheetField[]; error?: string | null }) {
  const count = activeCount(fields)
  const clear = (
    <button type="button" onClick={() => clearAll(fields)} className="h-8 rounded-full px-3 text-[12.5px] font-semibold text-ink-300 hover:bg-white/[0.06] hover:text-ink-100">
      Clear
    </button>
  )
  return (
    <Sheet sheet={sheet} title="Filters" note={count > 0 ? `${count} set` : undefined} footer={count > 0 ? clear : undefined}>
      <div className="space-y-4">
        {error !== null && (
          <p role="alert" className="text-[12.5px] leading-relaxed text-bad select-text">
            {error}
          </p>
        )}
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
    </Sheet>
  )
}
