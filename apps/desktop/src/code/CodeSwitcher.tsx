import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Project } from '@/api/schema'
import { ProjectPicture } from '@/advanced/ProjectPicture'
import { switchGroups, type CodeTarget } from '@/code/code-mode-model'

// The rail's "Open project" popover: every visible project and its worktrees, filtered as the
// person types. It renders into document.body, never inside the rail: the rail's backdrop-filter
// makes it the containing block and stacking context of anything fixed inside it, which put the
// old menu under the main pane and its VS Code iframe, so the button looked dead.
export function CodeSwitcher({
  anchor,
  projects,
  active,
  onSelect,
  onClose,
}: {
  /** Where the button that opened it sits on screen. */
  anchor: DOMRect
  projects: Project[]
  active: string | null
  onSelect: (target: CodeTarget) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const groups = switchGroups(projects, active, query)
  const first = groups[0]?.items[0]

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || ref.current?.contains(event.target) !== true) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    // A click into VS Code never reaches this window; it only takes focus away.
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const pick = (target: CodeTarget) => {
    onClose()
    onSelect(target)
  }

  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 420))
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Open project"
      style={{ left: anchor.right + 8, top }}
      className="glass fixed z-50 flex max-h-[min(420px,calc(100vh-16px))] w-[300px] flex-col rounded-[16px] border border-white/[0.1] p-1.5 shadow-2xl"
    >
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && first !== undefined) pick(first.target)
        }}
        placeholder="Search projects and branches"
        aria-label="Search projects and branches"
        className="mb-1 shrink-0 rounded-[10px] bg-white/[0.06] px-3 py-1.5 text-[13px] text-ink-100 placeholder:text-ink-400 focus-visible:outline-none"
      />
      <div className="min-h-0 overflow-y-auto">
        {groups.length === 0 && <p className="px-3 py-2 text-[12.5px] text-ink-400">Nothing matches.</p>}
        {groups.map((group) => (
          <section key={group.project.path} aria-label={group.project.name} className="py-1">
            <h3 className="flex items-center gap-2 px-3 py-1 text-[11.5px] font-semibold text-ink-300">
              <span className="scale-[0.75]">
                <ProjectPicture project={group.project} />
              </span>
              {group.project.name}
            </h3>
            {group.items.map((item) => (
              <button
                key={item.target.root}
                type="button"
                onClick={() => pick(item.target)}
                aria-current={item.current ? 'true' : undefined}
                title={item.target.root}
                className="flex w-full items-center gap-2 rounded-[10px] px-3 py-1.5 text-left text-[13px] text-ink-200 hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none"
              >
                <span className="w-3 shrink-0 text-accent" aria-hidden="true">{item.current ? '✓' : ''}</span>
                <span className="truncate">{item.label}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>,
    document.body,
  )
}
