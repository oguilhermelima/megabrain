import { lazy, Suspense, useRef, useState } from 'react'
import { api } from '@/api'
import type { TerminalSession } from '@/api/schema'
import { ChatHeader } from '@/chat/ChatHeader'
import { bracketedPaste } from '@/launcher/launch-model'
import { terminalEngine } from '@/terminal/terminal-engine'
import { restoredGone, terminalLabel, type AppTerminal } from '@/terminal/terminal-list'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'

const TerminalView = lazy(() => import('@/terminal/TerminalView').then((module) => ({ default: module.TerminalView })))

// Each terminal's session, kept for the app run so mounting its view again reattaches instead of opening another.
const opened = new Map<string, TerminalSession>()
// Terminals whose first input is already in them.
const pasted = new Set<string>()

/** The app let go of this terminal; a view mounted for it later opens a new one. */
export function forgetTerminal(id: string) {
  opened.delete(id)
  pasted.delete(id)
}

// The TUI is taken as ready once its output has been quiet this long; then the first input is pasted.
const quietMs = 1200

/** What a terminal shows while it starts: "Starting the shell in canto · main". */
export function startingLabel(terminal: AppTerminal, place: string | null): string {
  const what = terminal.launch.kind === 'agent-terminal' ? terminal.launch.title.split(' · ')[0] : 'the shell'
  return `Starting ${what}${place === null ? '' : ` in ${place}`}`
}

/** A terminal or an agent's own TUI the app opened in a worktree; typed text waits in it unsent. */
export function LaunchedTerminal({
  terminal,
  place,
  onStarted,
  onExit,
  onFailed,
  onRetry,
}: {
  terminal: AppTerminal
  /** The worktree it opens in, as the sidebar names it; null when no project lists it. */
  place: string | null
  onStarted: (session: TerminalSession) => void
  onExit: (code: number | null) => void
  onFailed: (error: unknown) => void
  onRetry: () => void
}) {
  const { launch } = terminal
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [waiting, setWaiting] = useState(launch.firstInput !== null && !pasted.has(launch.id))

  const connect = async (cols: number, rows: number): Promise<TerminalSession> => {
    const known = opened.get(launch.id)
    if (known !== undefined) {
      await api.resizeTerminal(known.id, cols, rows).catch(() => {})
      return known
    }
    // A tmux terminal a past run left attaches to its session instead of opening a new one.
    if (terminal.appTerminalId !== null && terminal.tmuxSession !== null) {
      const session = await api.openTerminal({ engine: 'tmux', cwd: launch.cwd, tmuxSession: terminal.tmuxSession, cols, rows })
      opened.set(launch.id, session)
      onStarted(session)
      return session
    }
    const command = launch.kind === 'agent-terminal' ? await api.agentCommand(launch.agent, { ...(launch.resume === undefined ? {} : { resume: launch.resume }), ...(launch.model === null ? {} : { model: launch.model }), ...(launch.effort === null ? {} : { effort: launch.effort }) }) : undefined
    const engine = launch.engine ?? (await terminalEngine())
    const session = await api.openTerminal({ engine, cwd: launch.cwd, ...(command === undefined ? {} : { command }), cols, rows })
    opened.set(launch.id, session)
    onStarted(session)
    return session
  }

  // Every chunk of output restarts the quiet timer; when it fires the first input goes in once, without Enter.
  const onOutput = (session: TerminalSession) => {
    const text = launch.firstInput
    if (text === null || pasted.has(launch.id)) return
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (pasted.has(launch.id)) return
      pasted.add(launch.id)
      setWaiting(false)
      void api.writeTerminal(session.id, bracketedPaste(text)).catch(() => {})
    }, quietMs)
  }

  const agent = launch.kind === 'agent-terminal' ? launch.agent : 'terminal'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatHeader agent={agent} title={terminalLabel(terminal)} />
      {launch.firstInput !== null && terminal.status !== 'exited' && (
        <p className="mx-8 mt-3 text-[13px] text-ink-400">{waiting ? 'Your message goes into the terminal once it is ready.' : 'Your message is typed in the terminal. Press Enter there to send it.'}</p>
      )}
      {terminal.status === 'exited' && <p className="mx-8 mt-3 text-[13px] text-ink-400">The terminal exited{terminal.exitCode === null ? '' : ` with code ${terminal.exitCode}`}.</p>}
      {!restoredGone(terminal) && (
        <Suspense fallback={<TerminalSkeleton label={startingLabel(terminal, place)} />}>
          <TerminalView key={launch.id} connect={connect} onOutput={onOutput} onExit={onExit} startingLabel={startingLabel(terminal, place)} onFailed={onFailed} onRetry={onRetry} />
        </Suspense>
      )}
    </div>
  )
}
