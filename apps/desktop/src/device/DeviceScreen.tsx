import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MutableRefObject, type PointerEvent, type WheelEvent } from 'react'
import { api } from '@/api'
import type { OpenDevice } from '@/device/device-model'
import { useFrameStream } from '@/device/frame-stream-standin'
import { useSimulatorStream } from '@/device/input-hooks'
import { viewportLabel, webDeviceName } from '@/device/web-device-model'
import { webDevices, type WebDevice, type WebInputAction } from '@/device/web-device-standin'
import { PanelIcon } from '@/advanced/WikiShell'
import { glyphs } from '@/device/glyphs'
import { elapsedLabel, failureDetail, preparingNote, type InputView } from '@/device/input-session'
import { deviceFrame, fitZoom, frameScale, gestureOf, keyAction, pausedNote, pointSize, pointsPerPixel, screenPoint, zoomedSize, zoomIn, zoomLabel, zoomOut, type Point, type Zoom } from '@/device/screen-model'
import { sidePanelButton } from '@/lib/side-panel'

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
 * The middle of the Device tab: the selected device alone, centred and as big as fits (an Apple TV
 * 16:9, a phone or tablet in its handset frame, a browser as a viewport of its CSS size), the hidden
 * panels' toggles in its top corners. It shows the chosen step's screenshot when one is pinned, else the live screen,
 * else `still` (the run's latest screenshot). The live screen takes input: a tap or a drag (a swipe
 * with the drag's duration), the wheel, and keys once it has focus (Esc or a click outside lets go),
 * the hardware controls being the Devices panel's (DeviceControls). Input waits while `paused` (a
 * Maestro run on this device).
 */
export function DeviceScreen({ device, browser, booted, paused, session, keyboard, pinned, still, note, showDevices, showFlows }: { device: OpenDevice | null; browser: WebDevice | null; booted: boolean; paused: boolean; session: { view: InputView; retry: () => void }; keyboard: MutableRefObject<(() => void) | null>; pinned: { src: string; step: number } | null; still: { src: string; step: number | null } | null; note: string | null; showDevices: (() => void) | null; showFlows: (() => void) | null }) {
  const udid = browser?.id ?? device?.udid ?? null
  // A browser is up while it is listed; a simulator once its input session is ready.
  const ready = browser !== null || (booted && session.view.kind === 'ready')
  const simulator = useSimulatorStream(browser === null ? (device?.udid ?? null) : null, ready)
  const streamUrl = browser?.streamUrl ?? simulator.stream?.streamUrl ?? null
  // While a run drives the device or a step is pinned, its screenshots are shown and the stream rests.
  const resting = pinned !== null || (paused && still !== null)
  const live = useFrameStream(streamUrl, { paused: !ready || resting })
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
  const scale = frameScale(live.width, browser, simulator.stream?.scale ?? 1)
  const frame = resting || live.src === null || live.width <= 0 || live.height <= 0 ? null : { src: live.src, width: live.width, height: live.height, scale }
  const shown = pinned ?? (frame === null ? still : { src: frame.src, step: null })
  const step = shown?.step ?? null
  const { shape, ratio } = deviceFrame(browser !== null ? 'web' : (device?.kind ?? null), browser !== null ? browser.width / browser.height : frame === null ? aspect : frame.width / frame.height)
  const look = frameLooks[shape]
  const chrome = look.chrome
  // Zoom needs the device's points (a browser's CSS px), known once a frame came; until then the screen fits.
  const points = browser !== null ? { width: browser.width, height: browser.height } : frame === null ? null : pointSize(frame)
  const fit = points === null ? 0 : fitZoom({ width: stageSize.width - chrome, height: stageSize.height - chrome }, points)
  const zoomed = points !== null && zoom !== 'fit' ? zoomedSize(points, zoom) : null
  const takesInput = ready && !paused && frame !== null && udid !== null
  // A screen that stops taking input (a run starts, the device sleeps) lets go of the keyboard too.
  useEffect(() => {
    if (!takesInput && surface.current !== null && surface.current === document.activeElement) surface.current.blur()
  }, [takesInput])
  // The controls' keyboard button hands the keys to the screen.
  useEffect(() => {
    keyboard.current = takesInput ? () => surface.current?.focus({ preventScroll: true }) : null
    return () => {
      keyboard.current = null
    }
  }, [keyboard, takesInput])
  // Before the session is ready the screen itself says why; after, a frame or an action that fails says so under it.
  const preparing = browser === null && booted && pinned === null ? session.view : null
  const covered = preparing?.kind === 'starting' || preparing?.kind === 'failed'
  // The stream reconnects on its own, so a failing one is said under the screen until it does.
  const problemText = !ready || pinned !== null ? null : (simulator.error ?? live.error ?? actionError ?? (live.stalled ? 'The screen stopped updating' : null))
  const problem = problemText === null ? null : failureDetail(problemText).line
  const retry = () => {
    setActionError(null)
    // A stream that fails may mean the session ended; starting it again is a no-op when it did not.
    if (browser === null && (live.error !== null || simulator.error !== null)) {
      session.retry()
      simulator.retry()
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

  // A simulator takes `native input`, a browser `web device input`, in the same points.
  const send = (simulatorAction: (target: string) => Promise<unknown>, webAction: WebInputAction | null) => {
    if (!takesInput || udid === null) return
    const run = browser !== null ? (webAction === null ? null : () => webDevices.input(browser.id, webAction)) : () => simulatorAction(udid)
    if (run === null) return
    queue.current = queue.current.then(run).then(
      () => setActionError(null),
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
      send((target) => api.inputTap(target, from.x, from.y), { type: 'tap', x: from.x, y: from.y })
      return
    }
    const to = pointAt(event.clientX, event.clientY, true)
    if (to !== null) send((target) => api.inputSwipe(target, from.x, from.y, to.x, to.y, gesture.durationMs), { type: 'swipe', x1: from.x, y1: from.y, x2: to.x, y2: to.y, ms: gesture.durationMs })
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
        send((target) => api.inputScroll(target, next.x, next.y, Math.round(next.dx), Math.round(next.dy)), { type: 'scroll', x: next.x, y: next.y, dx: Math.round(next.dx), dy: Math.round(next.dy) })
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
      if (remote !== undefined) send((target) => api.inputButton(target, remote), null)
      return
    }
    if (action.type === 'text') send((target) => api.inputType(target, action.text), { type: 'type', text: action.text })
    else send((target) => api.inputKey(target, action.name), { type: 'key', name: action.name })
  }

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
      {/* Above the screen: the pinned step, else a browser's CSS size, which its frame is drawn at. */}
      {(step !== null || browser !== null) && (
        <span title={step === null && browser !== null ? browser.url : undefined} className="absolute top-4 left-1/2 z-10 max-w-[60%] -translate-x-1/2 truncate rounded-full bg-white/[0.06] px-2 py-0.5 text-[11.5px] text-ink-300 tabular-nums">
          {step !== null ? `Step ${step}` : browser !== null ? `${webDeviceName(browser)} · ${viewportLabel(browser)}` : null}
        </span>
      )}
      {/* A size container, so at fit the frame takes the largest box of the screen's aspect that fits; zoomed, it scrolls. */}
      <div ref={stage} style={{ containerType: 'size' }} className={`mx-6 mt-12 mb-2 flex min-h-0 flex-1 ${zoomed === null ? 'items-center justify-center' : 'overflow-auto'}`}>
        <div
          data-device-frame=""
          style={zoomed === null ? { aspectRatio: String(ratio), width: `min(100cqw, calc(100cqh * ${ratio}))` } : { width: zoomed.width + chrome, height: zoomed.height + chrome }}
          className={`border border-white/[0.14] bg-black shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] ${zoomed === null ? '' : 'm-auto shrink-0'} ${look.frame}`}
        >
          <div
            ref={surface}
            data-device-screen=""
            tabIndex={takesInput ? 0 : -1}
            role={takesInput ? 'application' : undefined}
            aria-label={takesInput ? `${browser === null ? (device?.name ?? 'Device') : webDeviceName(browser)} screen: click to use, Esc to let go` : undefined}
            onPointerDown={onPointerDown}
            onMouseDown={(event) => !takesInput && event.preventDefault()}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (down.current = null)}
            onWheel={onWheel}
            onKeyDown={onKeyDown}
            onDragStart={(event) => event.preventDefault()}
            className={`relative flex h-full w-full touch-none items-center justify-center overflow-hidden bg-ink-900 outline-none select-none ${takesInput ? 'cursor-pointer focus:ring-2 focus:ring-accent/80 focus:ring-offset-2 focus:ring-offset-black' : ''} ${look.screen}`}
          >
            {shown !== null ? (
              <img
                ref={image}
                src={shown.src}
                alt={step === null ? (browser === null ? 'The simulator’s screen' : 'The browser’s viewport') : `The screen at step ${step}`}
                draggable={false}
                onLoad={(event) => {
                  const loaded = event.currentTarget
                  if (loaded.naturalWidth > 0 && loaded.naturalHeight > 0) setAspect(loaded.naturalWidth / loaded.naturalHeight)
                }}
                className={`pointer-events-none h-full w-full object-contain transition-opacity duration-200 select-none motion-reduce:transition-none ${covered ? 'opacity-35' : ''}`}
              />
            ) : (
              !covered && <p className="px-6 text-center text-[12px] leading-5 text-ink-500">{note ?? (device === null && browser === null ? 'Open a device with + to see its screen' : 'Waiting for the screen…')}</p>
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
      <div className="mb-3 flex flex-col items-center gap-1.5 px-4">
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
      {(device !== null || browser !== null) && <ViewControls zoom={zoom} fit={fit} canZoom={points !== null && fit > 0} full={full} onZoom={setZoom} onFull={setFull} />}
    </div>
  )
}

// Each frame shape's bezel and the screen's corners; chrome is the bezel's border and padding on each axis.
const frameLooks = {
  tv: { frame: 'rounded-[14px] p-[6px]', screen: 'rounded-[8px]', chrome: 14 },
  browser: { frame: 'rounded-[10px] p-[4px]', screen: 'rounded-[6px]', chrome: 10 },
  landscape: { frame: 'rounded-[20px] p-[8px]', screen: 'rounded-[12px]', chrome: 18 },
  portrait: { frame: 'rounded-[44px] p-[10px]', screen: 'rounded-[34px]', chrome: 22 },
} as const

/** Zoom out, the zoom shown, zoom in, fit and 100 percent, and full screen, in the screen's corner. */
function ViewControls({ zoom, fit, canZoom, full, onZoom, onFull }: { zoom: Zoom; fit: number; canZoom: boolean; full: boolean; onZoom: (zoom: Zoom) => void; onFull: (full: boolean) => void }) {
  const text = 'px-2 text-[11.5px]'
  return (
    <div role="toolbar" aria-label="View" className="absolute right-4 bottom-4 z-10 flex items-center gap-0.5 rounded-full border border-white/[0.08] bg-white/[0.03] px-1 py-0.5">
      <button type="button" aria-label="Zoom out" title="Zoom out" disabled={!canZoom} onClick={() => onZoom(zoomOut(zoom, fit))} className={toolButton}>
        {glyphs['zoom-out']}
      </button>
      <span className="min-w-10 text-center text-[11.5px] text-ink-300 tabular-nums">{zoomLabel(zoom, canZoom ? fit : 0)}</span>
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
