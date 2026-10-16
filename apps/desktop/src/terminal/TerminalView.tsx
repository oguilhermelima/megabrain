import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { TerminalSession } from '@/api/schema'
import { Button, ErrorNote } from '@/components/ui'
import { onPanelsSettled, panelsMoving } from '@/lib/panel-motion'
import { base64ToBytes } from '@/terminal/terminal-model'
import { TerminalSkeleton } from '@/terminal/TerminalSkeleton'

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

// The app's dark tokens (styles.css @theme); ANSI colours keep xterm's defaults.
function appTheme(): ITheme {
  const background = token('--color-ink-950', '#000000')
  return {
    background,
    foreground: token('--color-ink-200', '#dcdce2'),
    cursor: token('--color-accent', '#8e9cff'),
    cursorAccent: background,
    selectionBackground: 'rgba(142, 156, 255, 0.3)',
  }
}

/**
 * An embedded terminal. `connect` opens or finds the terminal at the size the view fits, then input
 * goes to it, its bytes come back base64, and the view resizes it with the window. Until it opens,
 * the view says what is starting; when opening fails it shows the error with a retry.
 */
export function TerminalView({
  connect,
  onExit,
  onOutput,
  startingLabel,
  onFailed,
  onRetry,
}: {
  connect: (cols: number, rows: number) => Promise<TerminalSession>
  onExit?: (code: number | null) => void
  /** Called after each chunk of output, with the session it came from. */
  onOutput?: (session: TerminalSession) => void
  /** What is starting, shown until the terminal opens: "Starting zsh in canto · main". */
  startingLabel?: string
  onFailed?: (error: unknown) => void
  onRetry?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<unknown>(null)
  const [phase, setPhase] = useState<'starting' | 'open' | 'failed'>('starting')
  // Each retry opens the view again from scratch.
  const [attempt, setAttempt] = useState(0)
  const latest = useRef({ connect, onExit, onOutput, onFailed })
  latest.current = { connect, onExit, onOutput, onFailed }

  useEffect(() => {
    const element = host.current
    if (element === null) return
    let stopped = false
    let unlisten: (() => void) | undefined
    const terminal = new Terminal({ theme: appTheme(), fontFamily: token('--font-mono', 'Menlo, monospace'), fontSize: 12.5, lineHeight: 1.2, cursorBlink: true, allowProposedApi: false })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    fit.fit()

    let terminalId: string | null = null
    let opened = false
    const input = terminal.onData((data) => {
      if (terminalId !== null) void api.writeTerminal(terminalId, data).catch(setError)
    })
    const resized = terminal.onResize(({ cols, rows }) => {
      if (terminalId !== null) void api.resizeTerminal(terminalId, cols, rows).catch(() => {})
    })
    // A hidden view (a terminal no pane shows) measures zero; fitting then would shrink the terminal to
    // nothing. While a side panel slides the size changes every frame, so it fits once when it stops.
    const refit = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit()
    }
    const observer = new ResizeObserver(() => {
      if (!panelsMoving()) refit()
    })
    observer.observe(element)
    const stopSettled = onPanelsSettled(refit)

    latest.current
      .connect(terminal.cols, terminal.rows)
      .then(async (session) => {
        if (stopped) return
        terminalId = session.id
        opened = true
        setPhase('open')
        const stop = await api.onTerminalData(
          session.id,
          (data) => {
            terminal.write(base64ToBytes(data))
            latest.current.onOutput?.(session)
          },
          (code) => latest.current.onExit?.(code),
        )
        if (stopped) stop()
        else unlisten = stop
        terminal.focus()
      })
      .catch((caught: unknown) => {
        if (stopped) return
        setError(caught)
        if (opened) return
        setPhase('failed')
        latest.current.onFailed?.(caught)
      })

    return () => {
      stopped = true
      unlisten?.()
      observer.disconnect()
      stopSettled()
      input.dispose()
      resized.dispose()
      terminal.dispose()
    }
  }, [attempt])

  const retry = () => {
    setError(null)
    setPhase('starting')
    onRetry?.()
    setAttempt((current) => current + 1)
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {error !== null && (
        <div className="mx-6 mt-3 flex flex-col items-start gap-2">
          <ErrorNote error={error} />
          {phase === 'failed' && (
            <Button variant="secondary" className="h-8 px-4 text-[12.5px]" onClick={retry}>
              Retry
            </Button>
          )}
        </div>
      )}
      {phase === 'starting' && (
        <div className="absolute inset-0 flex flex-col bg-ink-950">
          <TerminalSkeleton label={startingLabel} />
        </div>
      )}
      <div ref={host} className={`mx-4 my-3 min-h-0 flex-1 overflow-hidden ${phase === 'failed' ? 'invisible' : ''}`} />
    </div>
  )
}
