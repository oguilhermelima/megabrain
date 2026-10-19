import { describe, expect, test } from 'bun:test'
import { idleRun, reduceRun } from '@/device/device-model'
import { blurGraceMs, deviceFrame, fitZoom, frameScale, frameDelay, frameMs, gestureOf, inputPaused, keyAction, pausedNote, pointSize, screenPoint, tapSlop, tvAspect, zoomedSize, zoomIn, zoomLabel, zoomOut, zoomPercent, zoomSteps } from '@/device/screen-model'

const UDID = '401F3DA8-E4C1-48B7-9BB9-2C8416115E1A'
const OTHER = '110E1BF2-99F9-4475-916E-32FBA7CED248'

// An iPhone screenshot: 1206×2622 pixels at 3 pixels per point, so 402×874 points.
const phone = { width: 1206, height: 2622 }

describe('a point on the rendered screen maps to the device', () => {
  test('a box of the image’s own aspect maps corner to corner, in points', () => {
    const box = { left: 100, top: 50, width: 402, height: 874 }
    expect(screenPoint({ x: 100, y: 50 }, box, phone, 3)).toEqual({ x: 0, y: 0 })
    expect(screenPoint({ x: 100 + 201, y: 50 + 437 }, box, phone, 3)).toEqual({ x: 201, y: 437 })
    expect(screenPoint({ x: 100 + 402, y: 50 + 874 }, box, phone, 3)).toEqual({ x: 402, y: 874 })
  })

  test('the device scale divides the pixels: the same box at scale 2 reads 1.5 times the points', () => {
    const box = { left: 0, top: 0, width: 402, height: 874 }
    expect(screenPoint({ x: 201, y: 437 }, box, phone, 2)).toEqual({ x: 302, y: 656 })
  })

  test('a box wider than the image letterboxes left and right, and the bars map to nothing', () => {
    // 874 tall fits the image at 1/3 scale: 402 wide, centred in 802, so 200 px bars at each side.
    const box = { left: 0, top: 0, width: 802, height: 874 }
    expect(screenPoint({ x: 200, y: 0 }, box, phone, 3)).toEqual({ x: 0, y: 0 })
    expect(screenPoint({ x: 401, y: 437 }, box, phone, 3)).toEqual({ x: 201, y: 437 })
    expect(screenPoint({ x: 602, y: 874 }, box, phone, 3)).toEqual({ x: 402, y: 874 })
    expect(screenPoint({ x: 199, y: 437 }, box, phone, 3)).toBeNull()
    expect(screenPoint({ x: 603, y: 437 }, box, phone, 3)).toBeNull()
  })

  test('a box taller than the image letterboxes top and bottom', () => {
    // A 1920×1080 TV frame at scale 1 in a 960×740 box: 960×540 drawn, 100 px bars above and below.
    const tv = { width: 1920, height: 1080 }
    const box = { left: 10, top: 20, width: 960, height: 740 }
    expect(screenPoint({ x: 10, y: 120 }, box, tv, 1)).toEqual({ x: 0, y: 0 })
    expect(screenPoint({ x: 10 + 480, y: 20 + 370 }, box, tv, 1)).toEqual({ x: 960, y: 540 })
    expect(screenPoint({ x: 10 + 480, y: 119 }, box, tv, 1)).toBeNull()
    expect(screenPoint({ x: 10 + 480, y: 20 + 641 }, box, tv, 1)).toBeNull()
  })

  test('an image not decoded yet, or a box with no size, maps nothing', () => {
    expect(screenPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, phone, 3)).toBeNull()
    expect(screenPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 400, height: 800 }, { width: 0, height: 0 }, 3)).toBeNull()
  })

  test('a missing or nonsense scale counts as 1', () => {
    const box = { left: 0, top: 0, width: 402, height: 874 }
    expect(screenPoint({ x: 201, y: 437 }, box, phone, 0)).toEqual({ x: 603, y: 1311 })
  })
})

describe('a pointer gesture is a tap or a swipe', () => {
  test('down and up within the slop is a tap, however long it took', () => {
    expect(gestureOf({ x: 50, y: 50, at: 0 }, { x: 50, y: 50, at: 80 })).toEqual({ kind: 'tap' })
    expect(gestureOf({ x: 50, y: 50, at: 0 }, { x: 50 + tapSlop - 1, y: 50, at: 900 })).toEqual({ kind: 'tap' })
  })

  test('moving past the slop is a swipe that keeps the gesture’s duration', () => {
    expect(gestureOf({ x: 50, y: 50, at: 1000 }, { x: 50, y: 50 + tapSlop + 1, at: 1320 })).toEqual({ kind: 'swipe', durationMs: 320 })
  })

  test('the slop is a distance, so a diagonal counts both axes', () => {
    const leg = Math.ceil(tapSlop / Math.SQRT2) + 1
    expect(gestureOf({ x: 0, y: 0, at: 0 }, { x: leg, y: leg, at: 200 }).kind).toBe('swipe')
  })

  test('a flick faster than the device can swipe still takes a minimal duration', () => {
    const swipe = gestureOf({ x: 0, y: 0, at: 0 }, { x: 0, y: 300, at: 5 })
    expect(swipe.kind).toBe('swipe')
    expect(swipe.kind === 'swipe' && swipe.durationMs).toBeGreaterThanOrEqual(50)
  })
})

describe('input pauses while Maestro drives the device', () => {
  const running = reduceRun(idleRun, { type: 'request', flow: '.maestro/smoke.yaml', device: UDID })

  test('a run on this device pauses input, and says so', () => {
    expect(inputPaused(running, UDID)).toBe(true)
    expect(pausedNote).toBe('Maestro is running: input paused')
  })

  test('a run on another device leaves this one free', () => {
    expect(inputPaused(running, OTHER)).toBe(false)
  })

  test('input comes back once the run ends, however it ended', () => {
    expect(inputPaused(idleRun, UDID)).toBe(false)
    expect(inputPaused(reduceRun(running, { type: 'end', error: 'boom' }), UDID)).toBe(false)
    const stopping = reduceRun(running, { type: 'stop' })
    expect(inputPaused(stopping, UDID)).toBe(true)
    expect(inputPaused(reduceRun(stopping, { type: 'end', error: null }), UDID)).toBe(false)
  })

  test('no device selected is never paused', () => {
    expect(inputPaused(running, null)).toBe(false)
  })
})

describe('the live screen refreshes only while someone can watch it', () => {
  const watching = { visible: true, focused: true, blurredAt: null, now: 10_000, booted: true }

  test('a visible, focused tab on a booted device refreshes about four times a second', () => {
    expect(frameMs).toBe(250)
    expect(frameDelay(watching)).toBe(frameMs)
  })

  test('a hidden tab pauses', () => {
    expect(frameDelay({ ...watching, visible: false })).toBeNull()
  })

  test('a device asleep, shut down or busy pauses', () => {
    expect(frameDelay({ ...watching, booted: false })).toBeNull()
  })

  test('the window losing focus keeps refreshing for a few seconds, then pauses', () => {
    expect(blurGraceMs).toBeGreaterThanOrEqual(2_000)
    expect(blurGraceMs).toBeLessThanOrEqual(10_000)
    const blurred = { ...watching, focused: false, blurredAt: 10_000 }
    expect(frameDelay({ ...blurred, now: 10_000 + blurGraceMs - 1 })).toBe(frameMs)
    expect(frameDelay({ ...blurred, now: 10_000 + blurGraceMs })).toBeNull()
  })

  test('unfocused with no blur time known pauses rather than guessing', () => {
    expect(frameDelay({ ...watching, focused: false, blurredAt: null })).toBeNull()
  })
})

describe('keys typed on the focused screen', () => {
  const key = (value: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => keyAction({ key: value, metaKey: false, ctrlKey: false, altKey: false, ...mods })

  test('a printable character is text', () => {
    expect(key('a')).toEqual({ type: 'text', text: 'a' })
    expect(key('É')).toEqual({ type: 'text', text: 'É' })
    expect(key(' ')).toEqual({ type: 'text', text: ' ' })
  })

  test('editing and arrow keys are named keys', () => {
    expect(key('Enter')).toEqual({ type: 'key', name: 'return' })
    expect(key('Backspace')).toEqual({ type: 'key', name: 'delete' })
    expect(key('Tab')).toEqual({ type: 'key', name: 'tab' })
    expect(key('ArrowUp')).toEqual({ type: 'key', name: 'up' })
    expect(key('ArrowLeft')).toEqual({ type: 'key', name: 'left' })
  })

  test('Esc releases the screen instead of reaching the device', () => {
    expect(key('Escape')).toEqual({ type: 'release' })
  })

  test('app shortcuts and lone modifiers stay with the app', () => {
    expect(key('w', { metaKey: true })).toBeNull()
    expect(key('c', { ctrlKey: true })).toBeNull()
    expect(key('Shift')).toBeNull()
    expect(key('F5')).toBeNull()
  })
})

describe('zooming the device screen', () => {
  const points = pointSize({ width: 1206, height: 2622, scale: 3 })

  test('a device’s size in points is its frame’s pixels over its scale', () => {
    expect(points).toEqual({ width: 402, height: 874 })
    expect(pointSize({ width: 1920, height: 1080, scale: 1 })).toEqual({ width: 1920, height: 1080 })
  })

  test('fit is the largest zoom whose box fits, limited by the tighter side', () => {
    expect(fitZoom({ width: 402, height: 874 }, points)).toBe(1)
    expect(fitZoom({ width: 804, height: 874 }, points)).toBe(1)
    expect(fitZoom({ width: 201, height: 1000 }, points)).toBe(0.5)
    expect(fitZoom({ width: 0, height: 874 }, points)).toBe(0)
  })

  test('100 percent is one device point per CSS pixel', () => {
    expect(zoomedSize(points, 1)).toEqual({ width: 402, height: 874 })
    expect(zoomedSize(points, 2)).toEqual({ width: 804, height: 1748 })
  })

  test('zoom in and out step from where the screen is, fit included', () => {
    expect(zoomIn('fit', 0.6)).toBe(0.75)
    expect(zoomOut('fit', 0.6)).toBe(0.5)
    expect(zoomIn('fit', 1)).toBe(1.25)
    expect(zoomOut('fit', 1)).toBe(0.75)
    expect(zoomIn(1, 0.6)).toBe(1.25)
    expect(zoomOut(1, 0.6)).toBe(0.75)
  })

  test('zoom stops at its ends', () => {
    expect(zoomIn(zoomSteps.at(-1) ?? 0, 0.6)).toBe(zoomSteps.at(-1) ?? -1)
    expect(zoomOut(zoomSteps[0], 0.6)).toBe(zoomSteps[0])
    expect(zoomOut('fit', 0.1)).toBe(zoomSteps[0])
    expect(zoomIn('fit', 9)).toBe(zoomSteps.at(-1) ?? -1)
  })

  test('the label is the percentage the screen shows, fit included', () => {
    expect(zoomPercent('fit', 0.6123)).toBe(61)
    expect(zoomPercent(1, 0.6)).toBe(100)
    expect(zoomPercent(1.25, 0.6)).toBe(125)
  })

  test('a point maps to the device at any zoom: at 100 percent a CSS pixel is a point, at 200 percent two are', () => {
    const at100 = { left: 40, top: 30, ...zoomedSize(points, 1) }
    expect(screenPoint({ x: 40 + 10, y: 30 + 20 }, at100, phone, 3)).toEqual({ x: 10, y: 20 })
    const at200 = { left: -300, top: -500, ...zoomedSize(points, 2) }
    expect(screenPoint({ x: -300 + 402, y: -500 + 874 }, at200, phone, 3)).toEqual({ x: 201, y: 437 })
    expect(screenPoint({ x: -300 + 20, y: -500 + 40 }, at200, phone, 3)).toEqual({ x: 10, y: 20 })
  })
})

describe('the frame follows the device kind', () => {
  test('a TV is a 16:9 screen, even before its first frame or with a phone-shaped image', () => {
    expect(deviceFrame('tv', 1206 / 2622)).toEqual({ shape: 'tv', ratio: tvAspect })
    expect(deviceFrame('tv', 1920 / 1080)).toEqual({ shape: 'tv', ratio: 16 / 9 })
  })

  test('a phone or tablet keeps its screen’s aspect: upright is portrait, on its side landscape', () => {
    expect(deviceFrame('phone', 1206 / 2622)).toEqual({ shape: 'portrait', ratio: 1206 / 2622 })
    expect(deviceFrame('phone', 2732 / 2048)).toEqual({ shape: 'landscape', ratio: 2732 / 2048 })
  })

  test('no device yet frames like a phone', () => {
    expect(deviceFrame(null, 1206 / 2622).shape).toBe('portrait')
  })
})

describe('the zoom bar says Fit once', () => {
  test('the readout is the percent once the size is known, at fit or a step', () => {
    expect(zoomLabel('fit', 0.5)).toBe('50%')
    expect(zoomLabel(1.25, 0.5)).toBe('125%')
  })

  test('before the size is known it is a dash, never a second Fit', () => {
    expect(zoomLabel('fit', 0)).toBe('–')
    expect(zoomLabel(1, 0)).not.toBe('Fit')
  })
})

describe('web viewport sizing', () => {
  test('a browser is drawn at its CSS size’s aspect, whatever its stream sends', () => {
    expect(deviceFrame('web', 402 / 874)).toEqual({ shape: 'browser', ratio: 402 / 874 })
    expect(deviceFrame('web', 1920 / 1080)).toEqual({ shape: 'browser', ratio: 1920 / 1080 })
    expect(deviceFrame('web', Number.NaN).shape).toBe('browser')
    expect(deviceFrame('web', 0).ratio).toBeGreaterThan(0)
  })

  test('a browser frame maps to CSS px: its width over the CSS width, else the device scale', () => {
    expect(frameScale(1206, { width: 402, scale: 3 }, 1)).toBe(3)
    // A stream sent downscaled still maps a click to the right CSS px.
    expect(frameScale(603, { width: 402, scale: 3 }, 1)).toBe(1.5)
    expect(frameScale(0, { width: 402, scale: 3 }, 1)).toBe(3)
    expect(frameScale(0, { width: 402, scale: 0 }, 1)).toBe(1)
  })

  test('a simulator frame keeps the simulator’s scale', () => {
    expect(frameScale(1206, null, 3)).toBe(3)
    expect(frameScale(1206, null, 0)).toBe(1)
  })

  test('a tap on a downscaled browser frame lands in CSS px', () => {
    const scale = frameScale(603, { width: 402, scale: 3 }, 1)
    expect(screenPoint({ x: 201, y: 437 }, { left: 0, top: 0, width: 402, height: 874 }, { width: 603, height: 1311 }, scale)).toEqual({ x: 201, y: 437 })
    expect(pointSize({ width: 603, height: 1311, scale })).toEqual({ width: 402, height: 874 })
  })
})
