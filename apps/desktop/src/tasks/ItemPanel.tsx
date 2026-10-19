import { useEffect, useState } from 'react'
import type { GithubProject, GithubProjectField, GithubProjectItem } from '@/api/schema'
import { CloseIcon } from '@/github/icons'
import { pillButton } from '@/github/page-parts'
import { openOnGithub } from '@/github/parts'
import { editableType, fieldValue, optionColor, optionOf } from '@/tasks/board-view'

// The side panel a card opens: the item's title, where it lives and its body, then every project
// field it can edit, each with the control its type takes, a clear, and archive. Each write goes to
// GitHub through the board (onSet, onClear, onArchive), which shows the answer or a note when refused.

export type FieldWrite = { field: GithubProjectField; type: NonNullable<ReturnType<typeof editableType>>; value: string }

/** A field's value as its control holds it: an option or iteration id, a number, a date or text; '' when empty. */
function controlValue(item: GithubProjectItem, field: GithubProjectField): string {
  if (field.dataType === 'SINGLE_SELECT') return optionOf(item, field) ?? ''
  const value = fieldValue(item, field.name)
  if (value === undefined) return ''
  if (value.kind === 'iteration') return field.iterations.find((entry) => entry.title === value.value.title)?.id ?? ''
  if (value.kind === 'number' || value.kind === 'text') return value.value === null ? '' : String(value.value)
  if (value.kind === 'date') return value.value?.slice(0, 10) ?? ''
  return ''
}

const control = 'h-8 w-full min-w-0 rounded-[10px] border border-white/[0.08] bg-white/[0.05] px-2.5 text-[12.5px] text-ink-100 outline-none focus:border-accent/60'

function FieldControl({ item, field, busy, onSet, onClear }: { item: GithubProjectItem; field: GithubProjectField; busy: boolean; onSet: (write: FieldWrite) => void; onClear: (field: GithubProjectField) => void }) {
  const type = editableType(field)
  const saved = controlValue(item, field)
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  if (type === null) return null
  const commit = (value: string) => {
    if (value === saved) return
    if (value === '') onClear(field)
    else onSet({ field, type, value })
  }
  const option = field.options.find((entry) => entry.id === draft)
  return (
    <div className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-2">
      <span className="truncate text-[12.5px] text-ink-400" title={field.name}>
        {field.name}
      </span>
      {type === 'single-select' || type === 'iteration' ? (
        <label className="relative flex items-center">
          {option !== undefined && <span aria-hidden="true" style={{ backgroundColor: optionColor(option.color) }} className="pointer-events-none absolute left-2.5 size-2.5 rounded-full" />}
          <select aria-label={field.name} disabled={busy} value={draft} onChange={(event) => commit(event.target.value)} style={{ colorScheme: 'dark' }} className={`${control} ${option !== undefined ? 'pl-7' : ''}`}>
            <option value="">—</option>
            {type === 'single-select'
              ? field.options.map((entry) => (
                  <option key={entry.id} value={entry.id} title={entry.description}>
                    {entry.name}
                  </option>
                ))
              : field.iterations.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title} · {entry.startDate}
                  </option>
                ))}
          </select>
        </label>
      ) : (
        <input
          aria-label={field.name}
          disabled={busy}
          type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft.trim())}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft.trim())
            if (event.key === 'Escape') setDraft(saved)
          }}
          style={{ colorScheme: 'dark' }}
          className={control}
        />
      )}
      <button type="button" disabled={busy || saved === ''} onClick={() => onClear(field)} aria-label={`Clear ${field.name}`} title="Clear" className="grid size-7 place-items-center rounded-full text-ink-500 hover:bg-white/[0.08] hover:text-ink-100 disabled:opacity-30">
        <CloseIcon size={12} />
      </button>
    </div>
  )
}

export function ItemPanel({ item, project, busy, onSet, onClear, onEditDraft, onArchive, onOpenDetail, onClose }: { item: GithubProjectItem; project: GithubProject; busy: boolean; onSet: (write: FieldWrite) => void; onClear: (field: GithubProjectField) => void; onEditDraft: (title: string, body: string) => void; onArchive: () => void; onOpenDetail: (() => void) | null; onClose: () => void }) {
  const fields = project.fields.filter((field) => editableType(field) !== null)
  const url = item.url
  const [title, setTitle] = useState(item.title)
  const [body, setBody] = useState(item.body ?? '')
  useEffect(() => { setTitle(item.title); setBody(item.body ?? '') }, [item.title, item.body])
  const draftChanged = title.trim() !== item.title || body !== (item.body ?? '')
  return (
    <aside aria-label={item.title} className="flex w-[380px] shrink-0 flex-col border-l border-white/[0.06] bg-ink-950">
      <header className="flex shrink-0 items-start gap-2 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-ink-500">
            {item.type === 'DRAFT_ISSUE' ? 'Draft' : `${item.repository ?? ''}${item.number === null ? '' : ` #${item.number}`}`}
            {item.isArchived === true && ' · Archived'}
          </p>
          {item.type === 'DRAFT_ISSUE' ? <input aria-label="Draft title" disabled={busy} value={title} onChange={(event) => setTitle(event.target.value)} className={`${control} mt-1 font-semibold`} /> : <h2 className="mt-0.5 text-[15px] leading-snug font-semibold text-ink-100">{item.title}</h2>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-full text-ink-400 hover:bg-white/[0.08] hover:text-ink-100">
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 pb-5">
        <div className="flex flex-wrap gap-2">
          {onOpenDetail !== null && (
            <button type="button" onClick={onOpenDetail} className={pillButton}>
              Open details
            </button>
          )}
          {url !== null && (
            <button type="button" onClick={() => void openOnGithub(url)} className={pillButton}>
              Open on GitHub
            </button>
          )}
        </div>
        {item.type === 'DRAFT_ISSUE' ? <section aria-label="Draft description" className="space-y-2"><label className="block text-[12px] font-semibold tracking-wide text-ink-500 uppercase" htmlFor="draft-body">Description</label><textarea id="draft-body" disabled={busy} value={body} onChange={(event) => setBody(event.target.value)} rows={6} className={`${control} h-auto resize-y py-2`} /><button type="button" disabled={busy || !draftChanged || title.trim() === ''} onClick={() => onEditDraft(title.trim(), body)} className="rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40">Save draft</button></section> : item.body !== undefined && item.body !== null && item.body.trim() !== '' && <p className="line-clamp-[12] text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-300">{item.body}</p>}
        <section aria-label="Fields" className="space-y-2">
          <h3 className="text-[12px] font-semibold tracking-wide text-ink-500 uppercase">Fields</h3>
          {fields.length === 0 ? <p className="text-[12.5px] text-ink-500">This project has no fields the app can edit.</p> : fields.map((field) => <FieldControl key={field.id} item={item} field={field} busy={busy} onSet={onSet} onClear={onClear} />)}
        </section>
        <button type="button" disabled={busy} onClick={onArchive} className="rounded-full px-3 py-1.5 text-[12.5px] font-semibold text-bad hover:bg-bad/[0.12] disabled:opacity-40">
          {item.isArchived === true ? 'Restore item' : 'Archive item'}
        </button>
      </div>
    </aside>
  )
}
