import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AnchorRect } from '@/advanced/menu-placement'
import { runningLabel, taskDurationMs, taskTool, type BackgroundTask } from '@/chat/background-tasks'
import { ToolIcon } from '@/chat/ToolIcon'
import { menuFocusStep } from '@/components/menu-model'
import { Popover } from '@/components/Popover'
import { usePresence } from '@/lib/usePresence'
import { formatElapsed } from '@/native-chat/chat-model'

// Above a native chat's composer while the agent's background work runs: how many tasks still run,
// opening the list of them; picking one scrolls the transcript to the row where it started.

export function BackgroundIndicator({ tasks, onJump }: { tasks: BackgroundTask[]; onJump: (taskId: string) => void }) {
  const [menuAt, setMenuAt] = useState<AnchorRect | null>(null)
  const menu = usePresence(menuAt)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeMenu = useRef(() => setMenuAt(null)).current
  // The last task ending takes the list with it.
  useEffect(() => {
    if (tasks.length === 0) setMenuAt(null)
  }, [tasks.length])
  if (tasks.length === 0 && menu.shown === null) return null
  return (
    <div className="mb-1.5 flex">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        // The composer keeps the focus until the list opens.
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
          setMenuAt((current) => (current === null ? { left, top, right, bottom } : null))
        }}
        className={`flex h-7 items-center gap-1.5 rounded-full pr-2 pl-2.5 text-[12.5px] font-medium transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 motion-reduce:transition-none ${
          menuAt !== null ? 'bg-white/[0.14] text-ink-100' : 'bg-white/[0.05] text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'
        }`}
      >
        <span aria-hidden="true" className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-ink-600 border-t-ink-300" />
        {runningLabel(tasks.length)}
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 opacity-70">
          <path d="m5 9.5 3-3 3 3" />
        </svg>
      </button>
      {menu.shown !== null && (
        <TaskMenu
          tasks={tasks}
          anchor={menu.shown}
          leaving={menu.leaving}
          trigger={trigger.current}
          onPick={(task) => {
            setMenuAt(null)
            onJump(task.id)
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

function TaskMenu({ tasks, anchor, leaving, trigger, onPick, onClose }: { tasks: BackgroundTask[]; anchor: AnchorRect; leaving: boolean; trigger: HTMLElement | null; onPick: (task: BackgroundTask) => void; onClose: () => void }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  // Up and down walk the tasks, wrapping; Home and End jump.
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const next = menuFocusStep(items.length, items.indexOf(event.target as HTMLElement), event.key)
    if (next === null) return
    event.preventDefault()
    items[next]?.focus()
  }
  return (
    <Popover role="menu" focus='[role="menuitem"]' className="max-h-[min(320px,calc(100vh-16px))] overflow-y-auto p-1.5" anchor={anchor} label="Background tasks" leaving={leaving} onClose={onClose} trigger={trigger} gap={4}>
      <div className="w-[300px] max-w-[calc(100vw-32px)]" onKeyDown={walk}>
        <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-[0.04em] text-ink-400 uppercase">Running in background</p>
        {tasks.map((task) => {
          const ms = taskDurationMs(task, now)
          return (
            <button
              key={task.id}
              type="button"
              role="menuitem"
              title={`${task.label}\nShow where it started`}
              onClick={() => onPick(task)}
              className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] transition-colors duration-100 hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none motion-reduce:transition-none"
            >
              <ToolIcon name={taskTool[task.kind]} status="running" size={13} />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-200">{task.label}</span>
              {ms !== null && <span className="shrink-0 text-[11.5px] text-ink-400 tabular-nums">{formatElapsed(ms)}</span>}
            </button>
          )
        })}
      </div>
    </Popover>
  )
}
