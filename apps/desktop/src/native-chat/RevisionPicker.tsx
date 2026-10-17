import { useRef, useState, type KeyboardEvent } from 'react'
import type { AnchorRect } from '@/advanced/menu-placement'
import { relativeAge } from '@/advanced/projects-model'
import { menuFocusStep } from '@/components/menu-model'
import { Popover } from '@/components/Popover'
import { usePresence } from '@/lib/usePresence'
import { pickRevision, titleKey, type RevisionEntry } from '@/native-chat/chat-artifacts'

// An artifact's revision picker, the chat's artifact panel's and the Artifacts page's top bar's: a
// pill naming the version shown, of how many, opening every version newest first, each with when it
// was written; and the note an earlier version reads under, with the way back to the latest. The
// versions and the rules that pick among them are chat-artifacts.ts's.

export const updated = (at: string, now: number) => (relativeAge(at, now) === 'now' ? 'just now' : `${relativeAge(at, now)} ago`)

const stampOf = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

/** The trigger at either size: 24px inside the panel's header line, the bar's 30px pill on a page's top bar; an earlier version shown tints it. */
const triggerClass = (size: 'inline' | 'bar', old: boolean, open: boolean) => {
  const state = old ? 'bg-accent/[0.14] text-accent hover:bg-accent/[0.2]' : open ? (size === 'bar' ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.08] text-ink-100') : 'text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'
  const shape = size === 'bar' ? `bar-control gap-1 pr-2 pl-3 font-semibold ${old ? 'border-accent/30' : ''}` : 'flex h-6 items-center gap-1 rounded-full pr-1.5 pl-2 font-medium'
  return `${shape} shrink-0 text-[12px] tabular-nums transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${state}`
}

/** The picker: its trigger, and the menu it opens; `onPick` gets the version picked, null for the latest. */
export function RevisionPicker({ entries, shown, old, title, now, size, className = '', onPick }: { entries: RevisionEntry[]; shown: RevisionEntry; old: boolean; title: string; now: number; size: 'inline' | 'bar'; className?: string; onPick: (key: string | null) => void }) {
  const [menuAt, setMenuAt] = useState<AnchorRect | null>(null)
  const menu = usePresence(menuAt)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeMenu = useRef(() => setMenuAt(null)).current
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        title={`Revision ${shown.number} of ${entries.length}: pick another to read`}
        onClick={(event) => {
          const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
          setMenuAt((current) => (current === null ? { left, top, right, bottom } : null))
        }}
        className={`${triggerClass(size, old, menuAt !== null)} ${className}`}
      >
        Revision {shown.number} of {entries.length}
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 opacity-70">
          <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" />
        </svg>
      </button>
      {menu.shown !== null && (
        <RevisionMenu
          entries={entries}
          shown={shown}
          title={title}
          now={now}
          anchor={menu.shown}
          leaving={menu.leaving}
          trigger={trigger.current}
          onPick={(entry) => {
            onPick(pickRevision(entries, entry.key))
            setMenuAt(null)
            trigger.current?.focus({ preventScroll: true })
          }}
          onClose={closeMenu}
        />
      )}
    </>
  )
}

/** What an earlier version reads under: which one, that it is read-only, and the way back to the latest. */
export function OldRevisionNote({ shown, latest, onBack, className = '' }: { shown: RevisionEntry; latest: RevisionEntry; onBack: () => void; className?: string }) {
  return (
    <div role="status" className={`flex items-center gap-2 border-accent/20 bg-accent/[0.07] py-1.5 text-[12px] ${className}`}>
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-accent">
        <circle cx="8" cy="8" r="5.75" />
        <path d="M8 5v3.25l2 1.25" />
      </svg>
      <span className="min-w-0 flex-1 truncate text-ink-200">
        Viewing revision {shown.number}, read-only. <span className="text-ink-400">Newest is {latest.number}.</span>
      </span>
      <button type="button" onClick={onBack} className="h-6 shrink-0 rounded-full px-2.5 text-[12px] font-medium text-accent transition-colors duration-100 hover:bg-accent/[0.14] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 motion-reduce:transition-none">
        Back to latest
      </button>
    </div>
  )
}

/** Every version of the artifact, newest first, each with when it was written; the one shown is checked. */
function RevisionMenu({ entries, shown, title, now, anchor, leaving, trigger, onPick, onClose }: { entries: RevisionEntry[]; shown: RevisionEntry; title: string; now: number; anchor: AnchorRect; leaving: boolean; trigger: HTMLElement | null; onPick: (entry: RevisionEntry) => void; onClose: () => void }) {
  // Up and down walk the versions, wrapping; Home and End jump.
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
    const next = menuFocusStep(items.length, items.indexOf(event.target as HTMLElement), event.key)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
  return (
    <Popover role="menu" focus='[aria-checked="true"]' className="max-h-[min(420px,calc(100vh-16px))] overflow-y-auto p-1.5" anchor={anchor} label="Revisions" leaving={leaving} onClose={onClose} trigger={trigger} gap={4}>
      <div className="w-[268px] max-w-[calc(100vw-32px)]" onKeyDown={walk}>
        <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">Revisions</p>
        {entries.map((entry, index) => {
          const checked = entry === shown
          const renamed = titleKey(entry.title) !== titleKey(title)
          return (
            <button
              key={entry.key}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              title={`${entry.title}\n${new Date(entry.at).toLocaleString()}`}
              onClick={() => onPick(entry)}
              className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left transition-colors duration-100 focus-visible:outline-none motion-reduce:transition-none ${checked ? 'bg-accent/[0.14] hover:bg-accent/[0.18] focus-visible:bg-accent/[0.2]' : 'hover:bg-white/[0.06] focus-visible:bg-white/[0.08]'}`}
            >
              <span className={`grid h-6 min-w-6 shrink-0 place-items-center rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${index === 0 ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.05] text-ink-400'}`}>{entry.number}</span>
              <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-1.5 text-[13px] leading-5 ${checked ? 'font-semibold text-ink-100' : 'font-medium text-ink-200'}`}>
                  <span className="truncate">{renamed ? entry.title : `Revision ${entry.number}`}</span>
                  {index === 0 && <span className="shrink-0 rounded-full bg-white/[0.07] px-1.5 text-[10.5px] leading-[16px] font-medium text-ink-300">Latest</span>}
                </span>
                <span className="block truncate text-[11.5px] leading-4 text-ink-400 tabular-nums">
                  {stampOf(entry.at)} · {updated(entry.at, now)}
                </span>
              </span>
              <span aria-hidden="true" className={`grid size-5 shrink-0 place-items-center rounded-full ${checked ? 'bg-accent text-accent-ink' : ''}`}>
                {checked && (
                  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12.5 4.5 4.5L19 7.5" />
                  </svg>
                )}
              </span>
            </button>
          )
        })}
      </div>
    </Popover>
  )
}
