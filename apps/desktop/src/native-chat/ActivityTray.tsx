import { useState, type ReactNode } from 'react'
import { ToolIcon } from '@/chat/ToolIcon'
import { useClock } from '@/lib/clock'
import { formatElapsed } from '@/native-chat/chat-model'
import { entryElapsed, trayPills, type TrayEntry, type TrayKind, type TrayPill } from '@/native-chat/activity-tray'

// Right above a native chat's composer: the work running outside the transcript, one collapsed pill
// per kind ("1 shell command — 1m 20s"). Opened, a pill lists each item with its time and state and
// the one action the app has for it; the queue's pill opens the queue strip with all its controls.

/** What a tray item offers: showing where it started, opening its chat. */
export interface TrayAction {
  label: string
  run: () => void
}

const kindIcon: Record<TrayKind, string> = { shell: 'Bash', monitor: 'Monitor', task: '', subagent: 'Task', lane: 'Task', queue: '' }

export function ActivityTray({ entries, action, queue }: { entries: readonly TrayEntry[]; action: (entry: TrayEntry) => TrayAction | null; queue?: { body: ReactNode; open: boolean } }) {
  const now = useClock(1000)
  const pills = trayPills(entries, now)
  if (pills.length === 0) return null
  return (
    <div className="mb-1.5 space-y-1">
      {pills.map((pill) => (
        <TrayPillRow key={pill.kind} pill={pill} entries={entries.filter((entry) => entry.kind === pill.kind)} now={now} action={action} {...(pill.kind === 'queue' && queue !== undefined ? { body: queue.body, forceOpen: queue.open } : {})} />
      ))}
    </div>
  )
}

function TrayPillRow({ pill, entries, now, action, body, forceOpen = false }: { pill: TrayPill; entries: readonly TrayEntry[]; now: number; action: (entry: TrayEntry) => TrayAction | null; body?: ReactNode; forceOpen?: boolean }) {
  const [chosen, setChosen] = useState(false)
  const open = chosen || forceOpen
  return (
    <div className="rounded-[12px] bg-white/[0.04]">
      <button
        type="button"
        aria-expanded={open}
        // The composer keeps the focus.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => setChosen((value) => !value)}
        className="flex h-7 w-full items-center gap-1.5 rounded-[12px] px-2.5 text-left text-chat-small font-medium text-ink-300 transition-colors duration-100 hover:bg-white/[0.06] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none"
      >
        <span aria-hidden="true" className="contents text-ink-400">
          <ToolIcon name={kindIcon[pill.kind]} status="ok" size={13} />
        </span>
        {/* The time changes every second; it is not announced. */}
        <span aria-live="off" className="min-w-0 truncate tabular-nums">{pill.label}</span>
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`shrink-0 opacity-70 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}>
          <path d="m5 6.5 3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div className="px-1 pb-1">
          {body ?? (
            <ul>
              {entries.map((entry) => (
                <TrayEntryRow key={entry.id} entry={entry} now={now} action={action(entry)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function TrayEntryRow({ entry, now, action }: { entry: TrayEntry; now: number; action: TrayAction | null }) {
  const ms = entryElapsed(entry, now)
  return (
    <li className="flex items-center gap-2.5 rounded-[10px] px-2 py-1 text-chat-ui">
      <span title={entry.label} className="min-w-0 flex-1 truncate font-mono text-chat-code text-ink-200">{entry.label}</span>
      {ms !== null && <span aria-live="off" className="shrink-0 text-chat-label text-ink-400 tabular-nums">{formatElapsed(ms)}</span>}
      <span className="shrink-0 text-chat-label text-ink-400">{entry.status}</span>
      {action !== null && (
        <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={action.run} className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-ink-200 transition-colors duration-100 hover:bg-white/[0.08] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none">
          {action.label}
        </button>
      )}
    </li>
  )
}
