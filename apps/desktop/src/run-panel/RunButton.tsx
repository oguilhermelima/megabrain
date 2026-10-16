import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { ProjectScripts } from '@/api/schema'
import { onAction } from '@/lib/app-events'
import { useRunControls } from '@/run-panel/run-context'
import { commandFor, primaryAction, runActionLabel, runActions, type RunAction } from '@/run-panel/run-model'

function useProjectScripts(root: string | null): ProjectScripts | null {
  const [scripts, setScripts] = useState<ProjectScripts | null>(null)
  useEffect(() => {
    setScripts(null)
    if (root === null) return
    let current = true
    const load = () =>
      api.projectScripts(root).then(
        (next) => {
          if (current) setScripts(next)
        },
        () => {},
      )
    void load()
    const stop = onAction(() => void load())
    return () => {
      current = false
      stop()
    }
  }, [root])
  return scripts
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
      <path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" />
    </svg>
  )
}

function Caret() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  )
}

/**
 * Run, Build or Install in the open chat's worktree. The main half repeats the action used last
 * (Run at first); the caret lists all three with their commands. An action without a command
 * offers Set up, which opens the project's commands in Settings.
 */
export function RunButton() {
  const controls = useRunControls()
  const scripts = useProjectScripts(controls?.root ?? null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || box.current?.contains(event.target) !== true) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (controls === null) return null
  const repo = scripts?.repo ?? controls.root
  const primary = primaryAction(controls.panel.last)
  const primaryCommand = commandFor(scripts, primary)

  const choose = (action: RunAction) => {
    setOpen(false)
    const command = commandFor(scripts, action)
    if (command === null) controls.editCommands(repo)
    else controls.run(action, command)
  }

  const item = 'flex w-full items-center gap-3 rounded-[10px] px-3 py-1.5 text-left text-[13px] text-ink-200 hover:bg-white/[0.08] focus-visible:bg-white/[0.08] focus-visible:outline-none'

  return (
    <div ref={box} className="relative flex shrink-0">
      <button
        type="button"
        onClick={() => choose(primary)}
        title={primaryCommand ?? `Set up the ${runActionLabel[primary].toLowerCase()} command`}
        className="flex h-7 items-center gap-1.5 rounded-l-full border border-white/10 bg-white/[0.05] pr-2.5 pl-3 text-[12px] font-semibold text-ink-100 hover:bg-white/[0.1]"
      >
        <PlayIcon />
        {primaryCommand === null ? `Set up ${runActionLabel[primary]}` : runActionLabel[primary]}
      </button>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Run, build or install"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-7 w-7 items-center justify-center rounded-r-full border border-l-0 border-white/10 bg-white/[0.05] text-ink-300 hover:bg-white/[0.1] hover:text-ink-100"
      >
        <Caret />
      </button>
      {open && (
        <div role="menu" className="glass absolute top-full right-0 z-50 mt-1.5 w-[300px] max-w-[80vw] rounded-[16px] border border-white/[0.1] p-1.5 shadow-2xl">
          {!controls.panel.open && controls.panel.tabs.length > 0 && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                controls.showPanel()
              }}
              className={item}
            >
              Show run panel
            </button>
          )}
          {runActions.map((action) => {
            const command = commandFor(scripts, action)
            return (
              <button key={action} type="button" role="menuitem" onClick={() => choose(action)} title={command ?? undefined} className={item}>
                <span className="w-14 shrink-0 font-medium">{runActionLabel[action]}</span>
                {command === null ? (
                  <span className="ml-auto shrink-0 text-[12px] font-semibold text-accent">Set up</span>
                ) : (
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-400">{command}</span>
                )}
              </button>
            )
          })}
          <div className="my-1 h-px bg-white/[0.06]" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              controls.editCommands(repo)
            }}
            className={`${item} text-ink-300`}
          >
            Edit commands…
          </button>
        </div>
      )}
    </div>
  )
}
