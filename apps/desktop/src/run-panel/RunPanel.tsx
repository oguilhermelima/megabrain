import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { TerminalSession } from '@/api/schema'
import { terminalEngine } from '@/terminal/terminal-engine'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'
import { Spinner, ErrorNote } from '@/components/ui'
import { runActionLabel, runActions, attachCommand, runTabTitle, type RunTab, type WorktreePanel } from '@/run-panel/run-model'
import { runStatusView, type RunTone } from '@/run-panel/run-view'
import { RunButton } from '@/run-panel/RunButton'
import type { RunPanelsState } from '@/run-panel/useRunPanels'

// xterm loads the first time something runs.
const TerminalView = lazy(() => import('@/terminal/TerminalView').then((module) => ({ default: module.TerminalView })))

const toneDot: Record<RunTone, string> = {
  pending: 'bg-accent animate-pulse motion-reduce:animate-none',
  running: 'bg-ok shadow-[0_0_6px_var(--color-ok)]',
  ok: 'bg-ink-400',
  failed: 'bg-bad',
  stopped: 'bg-ink-500',
}

const toneText: Record<RunTone, string> = {
  pending: 'text-accent',
  running: 'text-ok',
  ok: 'text-ink-400',
  failed: 'text-bad',
  stopped: 'text-ink-400',
}

const ghost =
  'grid size-7 shrink-0 place-items-center rounded-full text-ink-400 transition-colors duration-100 hover:bg-white/[0.07] hover:text-ink-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}
      aria-label={copied ? 'Copied' : 'Copy command'}
      title={copied ? 'Copied' : 'Copy command'}
      className={`${ghost} size-6 ${copied ? 'text-ok hover:text-ok' : ''}`}
    >
      <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {copied ? (
          <path d="m3.5 8.5 3 3 6-7" />
        ) : (
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="2" />
            <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
          </>
        )}
      </svg>
    </button>
  )
}

function EmptyState({ onEditCommands }: { onEditCommands?: () => void }) {
  const lines: Record<(typeof runActions)[number], string> = {
    run: 'starts the project, a dev server or the app.',
    build: 'compiles or bundles it.',
    install: 'fetches its dependencies.',
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <span className="grid size-10 place-items-center rounded-full bg-white/[0.05] text-ink-300">
        <Icon>
          <path d="M5 3.5v9l7-4.5-7-4.5Z" />
        </Icon>
      </span>
      <div className="grid gap-1">
        <p className="text-[14px] font-semibold text-ink-100">Nothing running here</p>
        <p className="text-[12.5px] text-ink-400">Use the run button in the chat's top bar. Each command opens here in its own tab.</p>
      </div>
      <dl className="grid w-full max-w-72 gap-2 text-left text-[12.5px]">
        {runActions.map((action) => (
          <div key={action} className="flex gap-2">
            <dt className="w-14 shrink-0 font-semibold text-ink-200">{runActionLabel[action]}</dt>
            <dd className="text-ink-400">{lines[action]}</dd>
          </div>
        ))}
      </dl>
      {onEditCommands !== undefined && (
        <button
          type="button"
          onClick={onEditCommands}
          className="h-7 rounded-full px-3 text-[12.5px] font-semibold text-accent transition-colors duration-100 hover:bg-accent/[0.1] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 motion-reduce:transition-none"
        >
          Edit commands…
        </button>
      )}
    </div>
  )
}

/** A run that failed on a taken port offers the same choice as the dialog, in its tab. */
function PortChoice({ worktree, tab, runs }: { worktree: string; tab: RunTab; runs: RunPanelsState }) {
  const [busy, setBusy] = useState<'primary' | 'alternative' | null>(null)
  const [error, setError] = useState<unknown>(null)
  const conflict = tab.conflict
  if (conflict === null) return null
  const choose = (choice: 'primary' | 'alternative') => {
    if (busy !== null) return
    setBusy(choice)
    setError(null)
    runs.resolveConflict(worktree, tab, choice).then(
      () => setBusy(null),
      (caught: unknown) => {
        setBusy(null)
        setError(caught)
      },
    )
  }
  const button =
    'h-7 shrink-0 rounded-full px-3 text-[12.5px] font-semibold transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25 disabled:opacity-50 motion-reduce:transition-none'
  return (
    <div role="alert" className="mx-2.5 mb-2 grid shrink-0 gap-2 rounded-[12px] border border-bad/25 bg-bad/[0.06] px-2.5 py-2.5">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-200">{conflict.body}</p>
        <button type="button" onClick={() => runs.dismissConflict(worktree, tab)} aria-label="Dismiss" title="Dismiss" className={`${ghost} size-6`}>
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      {error !== null && <ErrorNote error={error} />}
      <div className="flex flex-wrap justify-end gap-1.5">
        {conflict.alternative !== null && (
          <button type="button" onClick={() => choose('alternative')} disabled={busy !== null} className={`${button} bg-white/[0.07] text-ink-100 hover:bg-white/[0.12]`}>
            {busy === 'alternative' ? <Spinner /> : conflict.alternative.label}
          </button>
        )}
        <button type="button" onClick={() => choose('primary')} disabled={busy !== null} className={`${button} bg-bad/[0.18] text-bad hover:bg-bad/[0.26]`}>
          {busy === 'primary' ? <Spinner /> : conflict.primaryLabel}
        </button>
      </div>
    </div>
  )
}

/**
 * One worktree's run panel: a tab per action run there, each an embedded terminal running the
 * command through the login shell with the engine chosen in settings. Every tab stays mounted
 * while the app runs, so its output survives moving between tabs and chats.
 */
export function RunPanel({ worktree, panel, visible, runs, onEditCommands }: { worktree: string; panel: WorktreePanel; visible: boolean; runs: RunPanelsState; onEditCommands?: () => void }) {
  const active = panel.tabs.find((tab) => tab.action === panel.active) ?? null
  const activeView = active === null ? null : runStatusView(active.status)
  const name = worktree.split('/').filter((part) => part !== '').pop() ?? worktree

  const connect = (tab: RunTab) => async (cols: number, rows: number): Promise<TerminalSession> => {
    try {
      // The CLI runs the script as a managed process under the resource policy (it waits here while queued);
      // the terminal only shows its tmux session, so closing the tab detaches and stopping goes through the CLI.
      const run = await api.runScript(worktree, tab.action, tab.command)
      const terminal = await api.openTerminal({ engine: await terminalEngine(), cwd: worktree, command: attachCommand(run.session), cols, rows })
      runs.started(worktree, tab, terminal.id)
      return terminal
    } catch (caught) {
      // The terminal shows the error; the tab is no longer running, so running it again needs no confirmation.
      runs.exited(worktree, tab, null)
      throw caught
    }
  }

  return (
    <div className={visible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {/* Laid out as the support panels are (lib/side-panel): the Run control and the tabs start 20px from the edge and the close glyph ends 20px from it; the command and a port choice are boxes 10px in, as a row's highlight. */}
      <header data-tauri-drag-region className="flex shrink-0 flex-col gap-2 px-5 pt-3 pb-2">
        <div data-tauri-drag-region className="flex items-center gap-2">
          {/* The top bar's Run control, moved here while the panel shows (it leaves the bar meanwhile). */}
          <RunButton inPanel />
          <span data-tauri-drag-region className="min-w-0 flex-1 self-stretch" />
          <button type="button" onClick={() => runs.setOpen(worktree, false)} aria-label="Close run panel" title="Hide panel (runs keep going)" className={`${ghost} -mr-[6px]`}>
            <Icon>
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
              <path d="M10 2.5v11" />
            </Icon>
          </button>
        </div>
        {panel.tabs.length > 0 && (
          <div role="tablist" aria-label="Runs" className="flex min-w-0 gap-1 overflow-x-auto">
            {panel.tabs.map((tab) => {
              const view = runStatusView(tab.status)
              const selected = tab.action === panel.active
              return (
                <div
                  key={tab.action}
                  className={`group flex h-7 shrink-0 items-center rounded-full transition-colors duration-100 motion-reduce:transition-none ${selected ? 'bg-white/[0.1] text-ink-100' : 'text-ink-400 hover:bg-white/[0.05] hover:text-ink-200'}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => runs.select(worktree, tab.action)}
                    title={`${runTabTitle(tab)} · ${view.label}`}
                    className="flex h-full items-center gap-2 rounded-l-full pr-1 pl-3 text-[12.5px] font-semibold focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
                  >
                    <span className={`size-1.5 rounded-full ${toneDot[view.tone]}`} aria-hidden="true" />
                    {runTabTitle(tab)}
                    <span className="sr-only">, {view.label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => runs.close(worktree, tab)}
                    aria-label={`Close ${runActionLabel[tab.action]}`}
                    title="Close tab (stops it)"
                    className={`mr-1 grid size-5 place-items-center rounded-full text-ink-400 transition-opacity duration-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:opacity-100 focus-visible:outline-none motion-reduce:transition-none ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  >
                    <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </header>
      {active !== null && activeView !== null && (
        <div className="mx-2.5 mb-2 flex shrink-0 items-center gap-1 rounded-[12px] border border-white/[0.06] bg-white/[0.03] py-1 pr-1 pl-2.5">
          <span className="shrink-0 font-mono text-[12px] text-ink-500 select-none" aria-hidden="true">
            $
          </span>
          {/* The command and its state on the left, what to do about it on the right. */}
          <code title={active.command} className="min-w-0 truncate pl-1 font-mono text-[12px] text-ink-300 select-text">
            {active.command}
          </code>
          <CopyButton text={active.command} />
          <span role="status" className={`shrink-0 px-1 text-[11.5px] font-medium ${toneText[activeView.tone]}`}>
            {activeView.label}
          </span>
          <span className="flex-1" />
          <button type="button" onClick={() => runs.restart(worktree, active)} aria-label="Restart" title="Restart" className={ghost}>
            <Icon>
              <path d="M13 8a5 5 0 1 1-1.5-3.6" />
              <path d="M13 2.5v3h-3" />
            </Icon>
          </button>
          {/* Same box and glyph size as Restart; filled red only while there is something to stop. */}
          <button
            type="button"
            onClick={() => runs.stop(worktree, active)}
            disabled={!activeView.live}
            aria-label="Stop"
            title="Stop"
            className={`${ghost} ${activeView.live ? 'bg-bad text-ink-950 hover:bg-bad/85 hover:text-ink-950' : 'ring-1 ring-white/[0.1] ring-inset'}`}
          >
            <Icon>
              <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
            </Icon>
          </button>
        </div>
      )}
      {active !== null && active.conflict !== null && active.status.kind === 'exited' && <PortChoice key={active.generation} worktree={worktree} tab={active} runs={runs} />}
      <div className="flex min-h-0 flex-1 flex-col border-t border-white/[0.06] bg-ink-950">
        {panel.tabs.length === 0 ? (
          <EmptyState onEditCommands={onEditCommands} />
        ) : (
          <Suspense fallback={<TerminalSkeleton label="Starting" />}>
            {panel.tabs.map((tab) => (
              <div key={`${tab.action}:${tab.generation}`} className={tab.action === panel.active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
                <TerminalView connect={connect(tab)} startingLabel={`Starting ${runTabTitle(tab)} in ${name}`} onOutput={(_session, data) => runs.output(worktree, tab, data)} onExit={(code) => runs.exited(worktree, tab, code)} />
              </div>
            ))}
          </Suspense>
        )}
      </div>
    </div>
  )
}
