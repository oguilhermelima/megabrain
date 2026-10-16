import { useEffect, useState } from 'react'
import { ErrorNote } from '@/components/ui'
import { recordingShortcut, saveShortcuts, setRecordingShortcut, useShortcutOverrides } from '@/lib/shortcut-store'
import { bindingsOf, comboLabel, comboOf, rebindShortcut, resetShortcut, shortcutConflicts, shortcuts, type ShortcutDef, type ShortcutId } from '@/lib/shortcuts'
import { field, quiet, SettingsGroup } from '@/settings/settings-ui'

const labelOf = (id: ShortcutId) => shortcuts.find((shortcut) => shortcut.id === id)?.label ?? id

/**
 * Every shortcut of the window by group, with a search. Record waits for the next combination and
 * binds it; Escape cancels. A combination two actions share shows as a conflict on both.
 */
export function ShortcutsSection() {
  const overrides = useShortcutOverrides()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [error, setError] = useState<unknown>(null)
  const bindings = bindingsOf(overrides)
  const conflicts = shortcutConflicts(bindings)

  const save = (next: typeof overrides) => {
    setError(null)
    saveShortcuts(next).catch(setError)
  }

  // The capture phase runs before the window's own shortcuts and Settings' Escape, and the store's
  // flag tells the window's handlers to stand aside.
  useEffect(() => {
    if (recording === null) return
    setRecordingShortcut(true)
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setRecording(null)
        return
      }
      const combo = comboOf(event)
      if (combo === null) return
      setRecording(null)
      save(rebindShortcut(overrides, recording, [combo]))
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (recordingShortcut()) setRecordingShortcut(false)
    }
  }, [recording, overrides])

  const words = query.trim().toLowerCase()
  const matches = (shortcut: ShortcutDef) => words === '' || `${shortcut.label} ${shortcut.group} ${bindings[shortcut.id].map((combo) => comboLabel(combo)).join(' ')}`.toLowerCase().includes(words)
  const groups = [...new Set(shortcuts.map((shortcut) => shortcut.group))].map((group) => ({ group, items: shortcuts.filter((shortcut) => shortcut.group === group && matches(shortcut)) })).filter((entry) => entry.items.length > 0)
  const changed = Object.keys(overrides).length

  return (
    <>
      <div className="flex items-center gap-2">
        <input type="search" aria-label="Search shortcuts" placeholder="Search shortcuts" value={query} onChange={(event) => setQuery(event.target.value)} className={`${field} flex-1`} />
        <button type="button" disabled={changed === 0} onClick={() => save({})} className={quiet}>
          Reset all
        </button>
      </div>
      {groups.length === 0 && <p className="px-1 text-[13px] text-ink-400">No shortcut matches “{query}”.</p>}
      {groups.map(({ group, items }) => (
        <SettingsGroup key={group} title={group}>
          {items.map((shortcut) => {
            const keys = bindings[shortcut.id]
            const clashes = [...new Set(keys.flatMap((combo) => (conflicts[combo] ?? []).filter((id) => id !== shortcut.id)))]
            const isRecording = recording === shortcut.id
            return (
              <div key={shortcut.id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-medium text-ink-100">{shortcut.label}</p>
                  {shortcut.fixed === true && <p className="mt-0.5 text-[12px] text-ink-400">Set by the pane's view bar.</p>}
                  {clashes.length > 0 && <p className="mt-0.5 text-[12px] text-warn">Also bound to {clashes.map(labelOf).join(', ')}.</p>}
                </div>
                <span className="flex shrink-0 items-center gap-1" aria-live="polite">
                  {isRecording ? (
                    <span className="rounded-[8px] border border-accent/60 px-2 py-0.5 text-[12px] text-ink-200">Press keys… Esc cancels</span>
                  ) : keys.length === 0 ? (
                    <span className="text-[12px] text-ink-500">None</span>
                  ) : (
                    keys.map((combo) => (
                      <kbd key={combo} className={`rounded-[8px] border px-2 py-0.5 font-sans text-[12px] tabular-nums ${clashes.length > 0 ? 'border-warn/50 text-warn' : 'border-white/[0.1] bg-white/[0.04] text-ink-200'}`}>
                        {comboLabel(combo)}
                      </kbd>
                    ))
                  )}
                </span>
                {shortcut.fixed !== true && (
                  <span className="flex shrink-0 items-center">
                    <button type="button" onClick={() => setRecording(isRecording ? null : shortcut.id)} aria-label={`Record a new shortcut for ${shortcut.label}`} className={quiet}>
                      {isRecording ? 'Cancel' : 'Record'}
                    </button>
                    <button type="button" disabled={!(shortcut.id in overrides)} onClick={() => save(resetShortcut(overrides, shortcut.id))} aria-label={`Reset ${shortcut.label} to its default`} className={quiet}>
                      Reset
                    </button>
                  </span>
                )}
              </div>
            )
          })}
        </SettingsGroup>
      ))}
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
