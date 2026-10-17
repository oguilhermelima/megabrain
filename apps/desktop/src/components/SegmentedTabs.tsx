import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { tabStep, type SegmentOf } from '@/chat/action-bar-model'

/**
 * Tabs as one segmented control, the worktree view's (chat/ActionBar) and any page's: the bar's 30px
 * track (bar-control, as the chat or terminal switch beside a pane's title), each segment a 24px pill
 * with its icon, if any, and its name, and a badge after the name as a small counter. The shown
 * segment sits on a raised pill that slides to the next one with the motion tokens. A disabled segment
 * is dimmed and keeps a tooltip, for its reason. The shown segment takes the keyboard's Tab; Left and
 * Right then move between segments (action-bar-model's tabStep) and Enter or Space opens one. A
 * control wider than its container scrolls sideways.
 */
export function SegmentedTabs<V extends string>({ label, segments, icons, shown, onSelect }: { label: string; segments: readonly SegmentOf<V>[]; icons?: Partial<Record<V, ReactNode>>; shown: V; onSelect: (view: V) => void }) {
  const strip = useRef<HTMLDivElement>(null)
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null)
  // The pill follows the shown segment, measured again whenever the control or a segment changes size (a badge appearing, the pane resizing).
  useLayoutEffect(() => {
    const element = strip.current
    if (element === null) return
    const measure = () => {
      const segment = element.querySelector<HTMLElement>(`[data-view="${shown}"]`)
      setPill(segment === null ? null : { left: segment.offsetLeft, width: segment.offsetWidth })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const segment of element.querySelectorAll('[data-view]')) observer.observe(segment)
    return () => observer.disconnect()
  }, [shown, segments])
  const move = (event: KeyboardEvent<HTMLButtonElement>, from: V) => {
    const next = tabStep(segments, from, event.key)
    if (next === null) return
    event.preventDefault()
    const tab = strip.current?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
    tab?.focus()
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return (
    <div className="flex min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div ref={strip} role="tablist" aria-label={label} className="bar-control bar-group relative">
        {pill !== null && (
          <span
            aria-hidden="true"
            data-tab-pill=""
            style={{ width: pill.width, translate: `${pill.left}px 0`, transition: 'translate var(--motion-panel) var(--motion-ease-panel), width var(--motion-panel) var(--motion-ease-panel)' }}
            className="pointer-events-none absolute top-0.5 left-0 h-6 rounded-[9999px] bg-white/[0.14]"
          />
        )}
        {segments.map((segment) => {
          const current = segment.view === shown
          const icon = icons?.[segment.view]
          return (
            <button
              key={segment.view}
              type="button"
              role="tab"
              data-view={segment.view}
              aria-label={segment.badge === null ? segment.label : `${segment.label} ${segment.badge}`}
              aria-selected={current}
              tabIndex={current ? 0 : -1}
              title={segment.enabled ? undefined : segment.title}
              disabled={!segment.enabled}
              onClick={() => onSelect(segment.view)}
              onKeyDown={(event) => move(event, segment.view)}
              className={`bar-segment relative shrink-0 gap-1.5 pr-2.5 ${icon === undefined ? 'pl-2.5' : 'pl-2'} ${current ? 'text-ink-100 hover:bg-transparent' : ''}`}
            >
              {icon}
              <span aria-hidden="true">{segment.label}</span>
              {segment.badge !== null && (
                <span aria-hidden="true" className={`min-w-4 rounded-full px-1 text-center text-[10px] leading-4 tabular-nums ${!segment.enabled ? 'bg-white/[0.04]' : current ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.08] text-ink-300'}`}>
                  {segment.badge}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
