import { convertFileSrc } from '@tauri-apps/api/core'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import { api } from '@/api'
import type { OpenDevice } from '@/device/device-model'
import { PanelIcon } from '@/advanced/WikiShell'
import { createInputSessions, elapsedLabel, failureDetail, preparingNote, type InputView } from '@/device/input-session'
import { fitZoom, frameDelay, gestureOf, keyAction, pausedNote, phoneButtons, pointSize, pointsPerPixel, screenPoint, zoomedSize, zoomIn, zoomOut, zoomPercent, type Point, type Zoom } from '@/device/screen-model'
import { onVisibility, windowShows } from '@/lib/app-events'
import { sidePanelButton } from '@/lib/side-panel'
import { native } from '@/lib/surface'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface Frame {
  src: string
  width: number
  height: number
  scale: number
}

/** A frame's image as an img src: a data URL as is, a file through the asset protocol, else base64 PNG. */
function frameSrc(image: string, version: number): string {
  if (image.startsWith('data:')) return image
  if (image.startsWith('/')) return native ? `${convertFileSrc(image)}?v=${version}` : image
  return `data:image/png;base64,${image}`
}

/** The window's focus, with when it was lost, so a short glance elsewhere keeps the screen live. */
function useWindowFocus() {
  const [focus, setFocus] = useState(() => ({ focused: typeof document === 'undefined' || document.hasFocus(), blurredAt: null as number | null }))
  useEffect(() => {
    const onFocus = () => setFocus({ focused: true, blurredAt: null })
    const onBlur = () => setFocus({ focused: false, blurredAt: Date.now() })
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  return focus
}

// The last frame each device showed, so one shown again (or still preparing) starts from it.
const lastFrames = new Map<string, Frame>()

/**
 * The simulator's live screen: a frame about every 250 ms while the tab shows, the window has
 * focus (see screen-model's frameDelay) and the input session is ready, each one swapped in only
 * once it decoded so nothing flickers. `refresh` asks for one now. A failed frame pauses the loop
 * until Retry.
 */
function useLiveFrames(udid: string | null, booted: boolean) {
  const [frame, setFrame] = useState<Frame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [visible, setVisible] = useState(windowShows)
  const { focused, blurredAt } = useWindowFocus()
  const [attempt, setAttempt] = useState(0)
  const now = useRef<() => void>(() => {})
  useEffect(() => onVisibility(() => setVisible(windowShows())), [])

  useEffect(() => {
    setFrame(udid === null ? null : (lastFrames.get(udid) ?? null))
    setError(null)
  }, [udid])

  useEffect(() => {
    if (udid === null) return
    let stopped = false
    let running = false
    let pending = false
    let version = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const due = () => frameDelay({ visible, focused, blurredAt, now: Date.now(), booted })
    const schedule = () => {
      clearTimeout(timer)
      const delay = due()
      if (delay !== null) timer = setTimeout(read, delay)
    }
    const read = () => {
      if (stopped) return
      if (running) {
        pending = true
        return
      }
      running = true
      clearTimeout(timer)
      api
        .inputFrame(udid)
        .then(async (next) => {
          const src = frameSrc(next.image, (version += 1))
          const image = new Image()
          image.src = src
          await image.decode()
          if (stopped) return
          const shown = { src, width: next.width || image.naturalWidth, height: next.height || image.naturalHeight, scale: next.scale }
          lastFrames.set(udid, shown)
          setFrame(shown)
          setError(null)
          running = false
          if (pending) {
            pending = false
            read()
          } else schedule()
        })
        .catch((failure: unknown) => {
          running = false
          if (!stopped) setError(message(failure))
        })
    }
    now.current = () => {
      if (booted && visible) read()
    }
    if (due() !== null) read()
    else if (booted && visible && !focused) schedule()
    return () => {
      stopped = true
      clearTimeout(timer)
      now.current = () => {}
    }
  }, [udid, booted, visible, focused, blurredAt, attempt])

  return { frame, error, refresh: useCallback(() => now.current(), []), retry: () => setAttempt((count) => count + 1) }
}

const inputSessions = createInputSessions({
  start: (udid) => api.inputStart(udid),
  status: (udid) => api.inputStatus(udid),
  stop: (udid) => api.inputStop(udid),
  now: Date.now,
  later: (run, ms) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
})

/** The shown device's input session (see input-session), watched while it is booted and free to take input. */
function useInputSession(udid: string | null, wanted: boolean) {
  const [view, setView] = useState<InputView>({ kind: 'idle' })
  useEffect(() => {
    if (udid === null || !wanted) {
      setView({ kind: 'idle' })
      return
    }
    return inputSessions.watch(udid, setView)
  }, [udid, wanted])
  return {
    view,
    retry: () => {
      if (udid !== null) inputSessions.retry(udid)
    },
  }
}

type Ripple = { id: number; x: number; y: number }

// Each device keeps the zoom it was last shown at while the app runs.
const zooms = new Map<string, Zoom>()

function useDeviceZoom(udid: string | null) {
  const [zoom, setZoom] = useState<Zoom>(() => (udid === null ? 'fit' : (zooms.get(udid) ?? 'fit')))
  useEffect(() => setZoom(udid === null ? 'fit' : (zooms.get(udid) ?? 'fit')), [udid])
  const change = (next: Zoom) => {
    if (udid !== null) zooms.set(udid, next)
    setZoom(next)
  }
  return [zoom, change] as const
}

/** The size of the box the device is drawn in, as it resizes. */
function useBoxSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}

/**
 * The middle of the Device tab: the device centred and scaled to fit, the hidden panels' toggles in
 * its top corners. It shows the chosen step's screenshot when one is pinned, else the live screen,
 * else `still` (the run's latest screenshot). The live screen takes input: a tap or a drag (a swipe
 * with the drag's duration), the wheel, and keys once it has focus (Esc or a click outside lets go),
 * with the hardware buttons under it. Input waits while `paused` (a Maestro run on this device).
 */
export function DeviceScreen({ device, booted, paused, pinned, still, note, showDevices, showFlows }: { device: OpenDevice | null; booted: boolean; paused: boolean; pinned: { src: string; step: number } | null; still: { src: string; step: number | null } | null; note: string | null; showDevices: (() => void) | null; showFlows: (() => void) | null }) {
  const udid = device?.udid ?? null
  // A Maestro run drives the device itself, so the session waits for it to end.
  const session = useInputSession(udid, booted && !paused)
  const ready = booted && session.view.kind === 'ready'
  const live = useLiveFrames(udid, ready)
  const [aspect, setAspect] = useState(1206 / 2622)
  const [zoom, setZoom] = useDeviceZoom(udid)
  const [full, setFull] = useState(false)
  const [stage, stageSize] = useBoxSize()
  const [actionError, setActionError] = useState<string | null>(null)
  const [ripples, setRipples] = useState<Ripple[]>([])
  const image = useRef<HTMLImageElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const down = useRef<{ x: number; y: number; at: number; id: number } | null>(null)
  const wheel = useRef<{ x: number; y: number; dx: number; dy: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  // One action at a time, in the order the person made them.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  useEffect(() => setActionError(null), [udid])

  // While a run drives the device its latest screenshot beats the last live frame, which no longer moves.
  const liveFrame = pinned !== null || (paused && still !== null) ? null : live.frame
  const shown = pinned ?? (liveFrame === null ? still : { src: liveFrame.src, step: null })
  const step = shown?.step ?? null
  const frameAspect = liveFrame === null ? null : liveFrame.width / liveFrame.height
  const ratio = frameAspect ?? aspect
  const frame = liveFrame
  // The frame's border and padding around the screen, on each axis.
  const chrome = ratio > 1 ? 18 : 22
  // Zoom needs the device's points, known once a live frame came; until then the screen fits.
  const points = live.frame === null ? null : pointSize(live.frame)
  const fit = points === null ? 0 : fitZoom({ width: stageSize.width - chrome, height: stageSize.height - chrome }, points)
  const zoomed = points !== null && zoom !== 'fit' ? zoomedSize(points, zoom) : null
  const takesInput = ready && !paused && frame !== null && udid !== null
  // A screen that stops taking input (a run starts, the device sleeps) lets go of the keyboard too.
  useEffect(() => {
    if (!takesInput && surface.current !== null && surface.current === document.activeElement) surface.current.blur()
  }, [takesInput])
  // Before the session is ready the screen itself says why; after, a frame or an action that fails says so under it.
  const preparing = booted && pinned === null ? session.view : null
  const covered = preparing?.kind === 'starting' || preparing?.kind === 'failed'
  const problemText = !ready || pinned !== null ? null : (live.error ?? actionError)
  const problem = problemText === null ? null : failureDetail(problemText).line
  const retry = () => {
    setActionError(null)
    if (live.error !== null) {
      // A frame that fails may mean the session ended; starting it again is a no-op when it did not.
      session.retry()
      live.retry()
    }
  }

  useEffect(() => {
    if (!full) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const send = (action: (target: string) => Promise<unknown>) => {
    if (!takesInput || udid === null) return
    queue.current = queue.current
      .then(() => action(udid))
      .then(
        () => {
          setActionError(null)
          live.refresh()
        },
        (error: unknown) => setActionError(message(error)),
      )
  }
  const pointAt = (clientX: number, clientY: number, clamp = false): Point | null => {
    const element = image.current
    if (element === null || frame === null) return null
    const rect = element.getBoundingClientRect()
    const x = clamp ? Math.min(Math.max(clientX, rect.left), rect.right) : clientX
    const y = clamp ? Math.min(Math.max(clientY, rect.top), rect.bottom) : clientY
    return screenPoint({ x, y }, rect, frame, frame.scale)
  }
  const ripple = (clientX: number, clientY: number) => {
    const element = image.current
    if (element === null) return
    const rect = element.getBoundingClientRect()
    const id = Date.now() + Math.random()
    setRipples((current) => [...current, { id, x: clientX - rect.left, y: clientY - rect.top }])
    setTimeout(() => setRipples((current) => current.filter((entry) => entry.id !== id)), 500)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!takesInput || event.button !== 0) return
    // Focusing must not scroll a zoomed screen, or the press would land somewhere else.
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    down.current = { x: event.clientX, y: event.clientY, at: event.timeStamp, id: event.pointerId }
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = down.current
    down.current = null
    if (start === null || start.id !== event.pointerId) return
    const from = pointAt(start.x, start.y)
    if (from === null) return
    const gesture = gestureOf(start, { x: event.clientX, y: event.clientY, at: event.timeStamp })
    if (gesture.kind === 'tap') {
      ripple(start.x, start.y)
      send((target) => api.inputTap(target, from.x, from.y))
      return
    }
    const to = pointAt(event.clientX, event.clientY, true)
    if (to !== null) send((target) => api.inputSwipe(target, from.x, from.y, to.x, to.y, gesture.durationMs))
  }
  // Wheel deltas gather for a moment, so a trackpad's stream of small ones is one scroll.
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    const element = image.current
    if (!takesInput || element === null || frame === null) return
    const at = pointAt(event.clientX, event.clientY)
    if (at === null) return
    const ratio = pointsPerPixel(element.getBoundingClientRect(), frame, frame.scale)
    const pending = wheel.current
    if (pending !== null) clearTimeout(pending.timer)
    const next = { x: pending?.x ?? at.x, y: pending?.y ?? at.y, dx: (pending?.dx ?? 0) + event.deltaX * ratio, dy: (pending?.dy ?? 0) + event.deltaY * ratio }
    wheel.current = {
      ...next,
      timer: setTimeout(() => {
        wheel.current = null
        send((target) => api.inputScroll(target, next.x, next.y, Math.round(next.dx), Math.round(next.dy)))
      }, 80),
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const action = keyAction(event)
    if (action === null) return
    event.preventDefault()
    if (action.type === 'release') {
      event.currentTarget.blur()
      return
    }
    // The TV has no keyboard: its arrows and Enter are the remote's.
    if (device?.kind === 'tv') {
      const remote = action.type === 'key' ? ({ up: 'up', down: 'down', left: 'left', right: 'right', return: 'select' } as Record<string, string>)[action.name] : undefined
      if (remote !== undefined) send((target) => api.inputButton(target, remote))
      return
    }
    if (action.type === 'text') send((target) => api.inputType(target, action.text))
    else send((target) => api.inputKey(target, action.name))
  }
  const press = (name: string) => send((target) => api.inputButton(target, name))

  const status = paused && booted && pinned === null ? pausedNote : null

  return (
    <div className={`flex min-h-0 flex-1 flex-col bg-ink-950 ${full ? 'fixed inset-0 z-[100]' : 'relative'}`}>
      {showDevices !== null && !full && (
        <button type="button" onClick={showDevices} aria-label="Show devices" title="Show devices" className={`${sidePanelButton} absolute top-3 left-3 z-10`}>
          <PanelIcon />
        </button>
      )}
      {showFlows !== null && !full && (
        <button type="button" onClick={showFlows} aria-label="Show flows" title="Show flows" className={`${sidePanelButton} absolute top-3 right-3 z-10`}>
          <PanelIcon />
        </button>
      )}
      {step !== null && <span className="absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11.5px] text-ink-300 tabular-nums">Step {step}</span>}
      {/* A size container, so at fit the frame takes the largest box of the screen's aspect that fits; zoomed, it scrolls. */}
      <div ref={stage} style={{ containerType: 'size' }} className={`mx-12 mt-12 mb-4 flex min-h-0 flex-1 ${zoomed === null ? 'items-center justify-center' : 'overflow-auto'}`}>
        <div
          data-device-frame=""
          style={zoomed === null ? { aspectRatio: String(ratio), width: `min(100cqw, calc(100cqh * ${ratio}))` } : { width: zoomed.width + chrome, height: zoomed.height + chrome }}
          className={`border border-white/[0.14] bg-black shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] ${zoomed === null ? '' : 'm-auto shrink-0'} ${ratio > 1 ? 'rounded-[20px] p-[8px]' : 'rounded-[44px] p-[10px]'}`}
        >
          <div
            ref={surface}
            data-device-screen=""
            tabIndex={takesInput ? 0 : -1}
            role={takesInput ? 'application' : undefined}
            aria-label={takesInput ? `${device?.name ?? 'Device'} screen: click to use, Esc to let go` : undefined}
            onPointerDown={onPointerDown}
            onMouseDown={(event) => !takesInput && event.preventDefault()}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (down.current = null)}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onDragStart={(event) => event.preventDefault()}
            className={`relative flex h-full w-full touch-none items-center justify-center overflow-hidden bg-ink-900 outline-none select-none ${takesInput ? 'cursor-pointer focus:ring-2 focus:ring-accent/80 focus:ring-offset-2 focus:ring-offset-black' : ''} ${ratio > 1 ? 'rounded-[12px]' : 'rounded-[34px]'}`}
          >
            {shown !== null ? (
              <img
                ref={image}
                src={shown.src}
                alt={step === null ? 'The simulator’s screen' : `The screen at step ${step}`}
                draggable={false}
                onLoad={(event) => {
                  const loaded = event.currentTarget
                  if (loaded.naturalWidth > 0 && loaded.naturalHeight > 0) setAspect(loaded.naturalWidth / loaded.naturalHeight)
                }}
                className={`pointer-events-none h-full w-full object-contain transition-opacity duration-200 select-none motion-reduce:transition-none ${covered ? 'opacity-35' : ''}`}
              />
            ) : (
              !covered && <p className="px-6 text-center text-[12px] leading-5 text-ink-500">{note ?? (device === null ? 'Open a device with + to see its screen' : 'Waiting for the screen…')}</p>
            )}
            {preparing?.kind === 'starting' && <Preparing phase={preparing.phase} elapsedMs={preparing.elapsedMs} />}
            {preparing?.kind === 'failed' && <Failed error={preparing.error} onRetry={session.retry} />}
            {ripples.map((entry) => (
              <span
                key={entry.id}
                aria-hidden="true"
                ref={(element) => {
                  element?.animate([{ transform: 'translate(-50%, -50%) scale(0.3)', opacity: 0.7 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 0 }], { duration: 450, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' })
                }}
                style={{ left: entry.x, top: entry.y }}
                className="pointer-events-none absolute size-12 rounded-full border-2 border-white/80 bg-white/25"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="mb-4 flex flex-col items-center gap-1.5 px-4">
        {device !== null && booted && pinned === null && <HardwareButtons kind={device.kind} disabled={!takesInput} onPress={press} />}
        {/* Always one line tall, so a note coming and going never resizes the device. */}
        <p role="status" className="flex min-h-6 items-center gap-2 text-center text-[12px] leading-5 text-ink-400">
          <span className={problem !== null ? 'text-bad-soft' : ''}>{problem ?? status ?? (shown !== null ? note : null)}</span>
          {problem !== null && (
            <button type="button" onClick={retry} className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[11.5px] text-ink-200 hover:bg-white/[0.12]">
              Retry
            </button>
          )}
        </p>
      </div>
      {device !== null && <ViewControls zoom={zoom} fit={fit} canZoom={points !== null && fit > 0} full={full} onZoom={setZoom} onFull={setFull} />}
    </div>
  )
}

/** Zoom out, the zoom shown, zoom in, fit and 100 percent, and full screen, in the screen's corner. */
function ViewControls({ zoom, fit, canZoom, full, onZoom, onFull }: { zoom: Zoom; fit: number; canZoom: boolean; full: boolean; onZoom: (zoom: Zoom) => void; onFull: (full: boolean) => void }) {
  const text = 'px-2 text-[11.5px]'
  return (
    <div role="toolbar" aria-label="View" className="absolute right-4 bottom-4 z-10 flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-1 py-0.5">
      <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!canZoom} onClick={() => onZoom(zoomOut(zoom, fit))} className={toolButton}>
        {glyphs['zoom-out']}
      </button>
      <span className="min-w-10 text-center text-[11.5px] text-ink-300 tabular-nums">{canZoom ? `${zoomPercent(zoom, fit)}%` : 'Fit'}</span>
      <button type="button" aria-label="Zoom in" title="Zoom in" disabled={!canZoom} onClick={() => onZoom(zoomIn(zoom, fit))} className={toolButton}>
        {glyphs['zoom-in']}
      </button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/[0.08]" />
      <button type="button" aria-pressed={zoom === 'fit'} title="Largest size that fits" disabled={!canZoom} onClick={() => onZoom('fit')} className={`${toolButton} ${text} ${zoom === 'fit' ? 'text-ink-100' : ''}`}>
        Fit
      </button>
      <button type="button" aria-pressed={zoom === 1} title="One device point per pixel" disabled={!canZoom} onClick={() => onZoom(1)} className={`${toolButton} ${text} ${zoom === 1 ? 'text-ink-100' : ''}`}>
        100%
      </button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-white/[0.08]" />
      <button type="button" aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (Esc)' : 'Full screen'} aria-pressed={full} onClick={() => onFull(!full)} className={toolButton}>
        {glyphs[full ? 'exit-full' : 'full']}
      </button>
    </div>
  )
}

/** Over the dimmed screen while the input session starts: what it is doing and for how long. */
function Preparing({ phase, elapsedMs }: { phase: string | null; elapsedMs: number }) {
  return (
    <div role="status" className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
      <span aria-hidden="true" className="mb-2 size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
      <p className="text-[12.5px] leading-5 text-ink-100">Preparing the device for input</p>
      <p className="text-[11.5px] leading-5 text-ink-300 tabular-nums">
        {phase ?? 'Starting'}
        <span aria-hidden="true"> · {elapsedLabel(elapsedMs)}</span>
      </p>
      <p className="mt-1 text-[11.5px] leading-4 text-ink-400">{preparingNote}</p>
    </div>
  )
}

/** Over the dimmed screen when the input session could not start: a plain sentence, the CLI's line, Retry and the log. */
function Failed({ error, onRetry }: { error: string; onRetry: () => void }) {
  const detail = failureDetail(error)
  const log = detail.log
  return (
    <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
      <p className="text-[12.5px] leading-5 text-bad-soft">Couldn’t connect to the device</p>
      <p title={detail.line} className="line-clamp-3 text-[11.5px] leading-4 break-words text-ink-400">
        {detail.line}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={onRetry} className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[11.5px] text-ink-200 hover:bg-white/[0.12]">
          Retry
        </button>
        {log !== null && (
          <button type="button" title={log} onClick={() => void api.revealPath(log)} className="rounded-full px-2 py-0.5 text-[11.5px] text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline">
            Show log
          </button>
        )}
      </div>
    </div>
  )
}

const toolButton = 'grid h-7 min-w-7 place-items-center rounded-full px-1.5 text-ink-300 transition-colors duration-100 hover:bg-white/[0.1] hover:text-ink-100 focus-visible:ring-1 focus-visible:ring-white/25 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

const glyph = (path: string) => (
  <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
)
const glyphs: Record<string, ReturnType<typeof glyph>> = {
  home: glyph('M3 7.5 8 3l5 4.5V13H3z'),
  lock: glyph('M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2'),
  'volume-down': glyph('M3 6.5h2l3-2.5v8l-3-2.5H3zM11 8h3'),
  'volume-up': glyph('M3 6.5h2l3-2.5v8l-3-2.5H3zM11 8h3M12.5 6.5v3'),
  up: glyph('M4 10l4-4 4 4'),
  down: glyph('M4 6l4 4 4-4'),
  left: glyph('M10 4 6 8l4 4'),
  right: glyph('M6 4l4 4-4 4'),
  menu: glyph('M3 5h10M3 8h10M3 11h10'),
  'play-pause': glyph('M3.5 4v8l5-4zM10.5 4v8M13 4v8'),
  'zoom-out': glyph('M4 8h8'),
  'zoom-in': glyph('M4 8h8M8 4v8'),
  full: glyph('M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3'),
  'exit-full': glyph('M6 3v3H3M13 6h-3V3M10 13v-3h3M3 10h3v3'),
}

/** The device's hardware: a phone's side buttons, or an Apple TV remote's pad and keys. */
function HardwareButtons({ kind, disabled, onPress }: { kind: OpenDevice['kind']; disabled: boolean; onPress: (name: string) => void }) {
  const button = (name: string, label: string, extra = '') => (
    <button key={name} type="button" aria-label={label} title={label} disabled={disabled} onClick={() => onPress(name)} className={`${toolButton} ${extra}`}>
      {glyphs[name] ?? <span className="text-[11px]">{label}</span>}
    </button>
  )
  if (kind === 'tv')
    return (
      <div role="toolbar" aria-label="Remote" className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-1">
        <div className="grid grid-cols-3 grid-rows-3 place-items-center">
          <span />
          {button('up', 'Up')}
          <span />
          {button('left', 'Left')}
          <button type="button" aria-label="Select" title="Select" disabled={disabled} onClick={() => onPress('select')} className={`${toolButton} border border-white/[0.14]`}>
            <span className="size-2 rounded-full bg-current" />
          </button>
          {button('right', 'Right')}
          <span />
          {button('down', 'Down')}
          <span />
        </div>
        <div className="flex flex-col gap-1">
          {button('menu', 'Menu')}
          {button('play-pause', 'Play/Pause')}
          {button('home', 'Home')}
        </div>
      </div>
    )
  return (
    <div role="toolbar" aria-label="Device buttons" className="flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-1 py-0.5">
      {phoneButtons.map((entry) => button(entry.name, entry.label))}
    </div>
  )
}
