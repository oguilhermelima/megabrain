import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api } from '@/api'
import type { Project } from '@/api/schema'
import { Segmented } from '@/components/ui'
import { GithubTab } from '@/import/ImportGithub'
import { LocalTab } from '@/import/ImportLocal'

type Tab = 'local' | 'github'

const focusable = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Import a project: a folder on this Mac (dropped, chosen, or one of the repositories megabrain
 * found that are not projects yet) or a clone from GitHub. Focus stays inside while it is open and
 * returns where it was on close; Esc steps back from a preview first, then closes.
 */
export function ImportProject({ projects, onClose, onImported }: { projects: Project[]; onClose: () => void; onImported: () => void }) {
  const [tab, setTab] = useState<Tab>('local')
  const [home, setHome] = useState<string | null>(null)
  const back = useRef<(() => void) | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.homeDir().then(
      (path) => setHome(path.replace(/\/+$/, '')),
      () => setHome(null),
    )
  }, [])

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (panel.current !== null && !panel.current.contains(document.activeElement)) panel.current.focus()
    return () => opener?.focus()
  }, [])

  // On the window, so Esc works wherever focus is while the dialog is open.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (back.current !== null) back.current()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setBack = useCallback((action: (() => void) | null) => {
    back.current = action
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab' && panel.current !== null) {
      const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter((item) => item.offsetParent !== null)
      const first = items[0]
      const last = items.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-ink-950/70 px-4 py-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-title"
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={panel} tabIndex={-1} className="glass flex outline-none h-[min(760px,100%)] w-full max-w-[880px] animate-[motion-pop-in_var(--motion-enter)_var(--motion-ease-out)] flex-col overflow-hidden rounded-[32px] border border-white/[0.1] shadow-2xl">
        <div className="flex items-start justify-between gap-4 px-7 pt-7">
          <div>
            <h2 id="import-title" className="text-[21px] font-semibold tracking-[-0.01em] text-ink-100">
              Import a project
            </h2>
            <p className="mt-1 text-[13.5px] text-ink-400">Pick a repository megabrain found on this Mac, drop a folder, or clone one from GitHub.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-300 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        <div className="px-7 pt-5 pb-5">
          <Segmented
            value={tab}
            onChange={(next) => {
              setBack(null)
              setTab(next)
            }}
            options={[
              { value: 'local', label: 'On this Mac' },
              { value: 'github', label: 'From GitHub' },
            ]}
          />
        </div>
        {tab === 'local' ? <LocalTab projects={projects} home={home} onImported={onImported} onBack={setBack} /> : <GithubTab projects={projects} home={home} onImported={onImported} />}
      </div>
    </div>
  )
}
