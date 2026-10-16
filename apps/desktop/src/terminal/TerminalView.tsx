import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import type { TerminalSession } from '@/api/schema'
import { Button, ErrorNote } from '@/components/ui'
import { onPanelsSettled, panelsMoving } from '@/lib/panel-motion'
import { keptTerminals, type KeptTerminal } from '@/terminal/kept-terminals'
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

/** What the view showing an xterm wants to hear from it; null while no view shows it. */
interface Sinks {
  output: (session: TerminalSession, data: string) => void
  exit: (code: number | null) => void
  error: (error: unknown) => void
}

/** One xterm and the session it shows. A kept one outlives its view; any other dies with it. */
interface Screen extends KeptTerminal {
  terminal: Terminal
  fit: FitAddon
  /** The GPU renderer while a view shows the screen; null means xterm's DOM renderer draws. */
  gpu: WebglAddon | null
  /** The element xterm draws into, moved into whichever view shows it. */
  mount: HTMLDivElement
  sinks: Sinks | null
  disposed: boolean
  dispose: () => void
}

function createScreen(): Screen {
  const mount = document.createElement('div')
  mount.style.width = '100%'
  mount.style.height = '100%'
  // Line height 1 and no letter spacing keep cells flush, so block and box glyphs meet their neighbours.
  const terminal = new Terminal({
    theme: appTheme(),
    fontFamily: token('--font-mono', "'SF Mono', Menlo, monospace"),
    fontSize: 12.5,
    lineHeight: 1,
    letterSpacing: 0,
    customGlyphs: true,
    cursorBlink: true,
    allowProposedApi: false,
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  const screen: Screen = { terminal, fit, gpu: null, mount, session: null, unlisten: undefined, sinks: null, disposed: false, dispose: () => {} }
  const input = terminal.onData((data) => {
    if (screen.session !== null) void api.writeTerminal(screen.session.id, data).catch((error: unknown) => screen.sinks?.error(error))
  })
  const resized = terminal.onResize(({ cols, rows }) => {
    if (screen.session !== null) void api.resizeTerminal(screen.session.id, cols, rows).catch(() => {})
  })
  screen.dispose = () => {
    screen.disposed = true
    screen.unlisten?.()
    input.dispose()
    resized.dispose()
    terminal.dispose()
  }
  return screen
}

/**
 * Draws the screen on the GPU. The DOM renderer draws block elements, box drawing and powerline glyphs
 * from the font, which leaves seams between cells (pixel art falls apart, rules come out dashed); the
 * WebGL renderer draws them itself to fill their cells. A browser keeps only about 16 WebGL contexts,
 * so only a shown screen holds one: a kept screen gives it back when its view leaves. Without WebGL, or
 * once the context is lost, xterm's DOM renderer draws instead.
 */
function attachGpu(screen: Screen) {
  if (screen.gpu !== null) return
  try {
    const gpu = new WebglAddon()
    gpu.onContextLoss(() => detachGpu(screen))
    screen.terminal.loadAddon(gpu)
    screen.gpu = gpu
  } catch {
    // No WebGL here: the DOM renderer keeps drawing.
  }
}

function detachGpu(screen: Screen) {
  screen.gpu?.dispose()
  screen.gpu = null
}

/** Shows a session on the screen: its bytes go to xterm and to the view that shows it, if any. */
async function listen(screen: Screen, session: TerminalSession) {
  screen.session = session
  const stop = await api.onTerminalData(
    session.id,
    (data) => {
      screen.terminal.write(base64ToBytes(data))
      screen.sinks?.output(session, data)
    },
    (code) => {
      // Only the session on screen ends the screen's session; a late exit of an earlier one does not.
      if (screen.session?.id === session.id) {
        screen.unlisten?.()
        screen.unlisten = undefined
        screen.session = null
      }
      screen.sinks?.exit(code)
    },
  )
  if (screen.disposed || screen.session?.id !== session.id) stop()
  else screen.unlisten = stop
}

/**
 * An embedded terminal. `connect` opens or finds the terminal at the size the view fits, then input
 * goes to it, its bytes come back base64, and the view resizes it with the window. Until it opens,
 * the view says what is starting; when opening fails it shows the error with a retry. With `keep`,
 * the xterm and its session outlive the view: the next view with that key shows them at once.
 */
export function TerminalView({
  connect,
  onExit,
  onOutput,
  onFirstPaint,
  startingLabel,
  awaitOutput = false,
  keep,
  onFailed,
  onRetry,
}: {
  connect: (cols: number, rows: number) => Promise<TerminalSession>
  onExit?: (code: number | null) => void
  /** Called after each chunk of output, with the session it came from and the chunk, base64. */
  onOutput?: (session: TerminalSession, data: string) => void
  /** Called once, when xterm has rendered the first output this view received. */
  onFirstPaint?: () => void
  /** What is starting, shown until the terminal opens: "Starting zsh in canto · main". */
  startingLabel?: string
  /** Keep saying what is starting until the terminal's first output (an agent's TUI paints late), then fade to it. */
  awaitOutput?: boolean
  /** Keeps the xterm under this key when the view leaves, and shows the kept one when a view comes back. */
  keep?: string
  onFailed?: (error: unknown) => void
  onRetry?: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<unknown>(null)
  const [phase, setPhase] = useState<'starting' | 'open' | 'failed'>('starting')
  // Each retry opens the view again from scratch.
  const [attempt, setAttempt] = useState(0)
  const [painted, setPainted] = useState(!awaitOutput)
  const [veilGone, setVeilGone] = useState(!awaitOutput)
  const latest = useRef({ connect, onExit, onOutput, onFirstPaint, onFailed })
  latest.current = { connect, onExit, onOutput, onFirstPaint, onFailed }

  useEffect(() => {
    const element = host.current
    if (element === null) return
    let stopped = false
    let patience: ReturnType<typeof setTimeout> | undefined
    const known = keep === undefined ? undefined : keptTerminals.get(keep)
    const screen = known === undefined ? createScreen() : (known as Screen)
    if (keep !== undefined) keptTerminals.set(keep, screen)
    element.appendChild(screen.mount)
    const { terminal, fit } = screen
    if (terminal.element === undefined) terminal.open(screen.mount)
    attachGpu(screen)
    // A hidden view (a terminal no pane shows) measures zero; fitting then would shrink the terminal to
    // nothing. While a side panel slides the size changes every frame, so it fits once when it stops.
    const refit = () => {
      if (element.clientWidth > 0 && element.clientHeight > 0) fit.fit()
    }
    refit()

    let firstOutput = true
    screen.sinks = {
      output: (session, data) => {
        setPainted(true)
        if (firstOutput) {
          firstOutput = false
          const rendered = terminal.onRender(() => {
            rendered.dispose()
            if (!stopped) latest.current.onFirstPaint?.()
          })
        }
        latest.current.onOutput?.(session, data)
      },
      exit: (code) => latest.current.onExit?.(code),
      error: setError,
    }
    const observer = new ResizeObserver(() => {
      if (!panelsMoving()) refit()
    })
    observer.observe(element)
    const stopSettled = onPanelsSettled(refit)

    if (screen.session !== null) {
      // A kept screen still showing its session: it is already drawn, so there is nothing to wait for.
      void api.resizeTerminal(screen.session.id, terminal.cols, terminal.rows).catch(() => {})
      setPhase('open')
      setPainted(true)
      terminal.focus()
    } else {
      let opened = false
      latest.current
        .connect(terminal.cols, terminal.rows)
        .then(async (session) => {
          if (stopped) return
          opened = true
          setPhase('open')
          // A reattached terminal may stay quiet until something changes: the veil never outlasts a few seconds.
          if (awaitOutput) patience = setTimeout(() => setPainted(true), 3000)
          await listen(screen, session)
          if (!stopped) terminal.focus()
        })
        .catch((caught: unknown) => {
          if (stopped) return
          setError(caught)
          if (opened) return
          setPhase('failed')
          latest.current.onFailed?.(caught)
        })
    }

    return () => {
      stopped = true
      if (patience !== undefined) clearTimeout(patience)
      observer.disconnect()
      stopSettled()
      screen.sinks = null
      if (keep === undefined) screen.dispose()
      else {
        detachGpu(screen)
        screen.mount.remove()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, keep])

  // Once the first output is in, the skeleton fades for a moment and then leaves.
  useEffect(() => {
    if (!painted || veilGone) return
    const timer = setTimeout(() => setVeilGone(true), 220)
    return () => clearTimeout(timer)
  }, [painted, veilGone])

  const retry = () => {
    setError(null)
    setPainted(!awaitOutput)
    setVeilGone(!awaitOutput)
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
      {(phase === 'starting' || !veilGone) && (
        <div className={`absolute inset-0 flex flex-col bg-ink-950 transition-opacity duration-200 motion-reduce:transition-none ${phase !== 'starting' && painted ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
          <TerminalSkeleton label={startingLabel} />
        </div>
      )}
      <div ref={host} className={`mx-4 my-3 min-h-0 flex-1 overflow-hidden ${phase === 'failed' ? 'invisible' : ''}`} />
    </div>
  )
}
