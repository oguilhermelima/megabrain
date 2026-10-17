import { describe, expect, test } from 'bun:test'
import type { InputStatus } from '@/api/schema'
import { createInputSessions, elapsedLabel, failureDetail, inputView, type InputView } from '@/device/input-session'

const UDID = '401F3DA8-E4C1-48B7-9BB9-2C8416115E1A'
const OTHER = '110E1BF2-99F9-4475-916E-32FBA7CED248'
const T0 = Date.parse('2026-10-17T21:00:00Z')

const status = (state: InputStatus['state'], extra: Partial<InputStatus> = {}, udid = UDID): InputStatus => ({ udid, state, phase: null, startedAt: null, error: null, ...extra })

/** A clock and a timer queue the test moves by hand, and a fake CLI whose status answers the test sets. */
function harness() {
  let now = T0
  let timers: { at: number; run: () => void; id: number }[] = []
  let nextId = 0
  const calls: string[] = []
  const answers = new Map<string, InputStatus | Error>()
  const starts = new Map<string, Error>()
  const sessions = createInputSessions(
    {
      start: async (udid) => {
        calls.push(`start ${udid}`)
        const failure = starts.get(udid)
        if (failure !== undefined) throw failure
        return status('starting', {}, udid)
      },
      status: async (udid) => {
        calls.push(`status ${udid}`)
        const answer = answers.get(udid) ?? status('starting', {}, udid)
        if (answer instanceof Error) throw answer
        return answer
      },
      stop: async (udid) => {
        calls.push(`stop ${udid}`)
        return { udid, stopped: true }
      },
      now: () => now,
      later: (run, ms) => {
        const id = (nextId += 1)
        timers.push({ at: now + ms, run, id })
        return () => (timers = timers.filter((timer) => timer.id !== id))
      },
    },
    { pollMs: 1_000, stopDelayMs: 1_500 },
  )
  const settle = async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    const until = now + ms
    for (;;) {
      await settle()
      const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      timers = timers.filter((timer) => timer.id !== due.id)
      now = due.at
      due.run()
    }
    now = until
    await settle()
  }
  const watch = (udid: string) => {
    const views: InputView[] = []
    const release = sessions.watch(udid, (view) => views.push(view))
    return { views, release, last: () => views.at(-1) }
  }
  const count = (call: string) => calls.filter((entry) => entry === call).length
  return { sessions, calls, answers, starts, advance, settle, watch, count, at: (ms: number) => new Date(T0 + ms).toISOString() }
}

describe('a status becomes what the screen shows', () => {
  test('no session is idle', () => {
    expect(inputView(status('none'), T0)).toEqual({ kind: 'idle' })
  })

  test('starting carries the phase and the time since the CLI started it', () => {
    const started = new Date(T0 - 42_000).toISOString()
    expect(inputView(status('starting', { phase: 'Building WebDriverAgent', startedAt: started }), T0)).toEqual({ kind: 'starting', phase: 'Building WebDriverAgent', elapsedMs: 42_000 })
  })

  test('ready is ready', () => {
    expect(inputView(status('ready'), T0)).toEqual({ kind: 'ready' })
  })

  test('failed carries the error', () => {
    expect(inputView(status('failed', { error: 'xcodebuild exited with code 65' }), T0)).toEqual({ kind: 'failed', error: 'xcodebuild exited with code 65' })
  })
})

describe('the elapsed time reads as minutes and seconds', () => {
  test('under a minute, over a minute, and zero', () => {
    expect(elapsedLabel(0)).toBe('0:00')
    expect(elapsedLabel(42_400)).toBe('0:42')
    expect(elapsedLabel(61_000)).toBe('1:01')
  })

  test('a clock running behind the CLI never shows negative time', () => {
    expect(elapsedLabel(-3_000)).toBe('0:00')
  })
})

describe('a failure reads plainly', () => {
  test('the CLI’s instruction to run a command never reaches the person', () => {
    const detail = failureDetail(`no input session for ${UDID}; run native input start ${UDID} first`)
    expect(detail.line).toBe(`no input session for ${UDID}`)
    expect(detail.line).not.toContain('native input start')
  })

  test('the decisive line is the last meaningful one, and a log path in the error becomes the log', () => {
    const detail = failureDetail('Appium session failed\nxcodebuild exited with code 65\nlog: /Users/operator/.megabrain/native/wda-401F3DA8.log\n')
    expect(detail.line).toBe('xcodebuild exited with code 65')
    expect(detail.log).toBe('/Users/operator/.megabrain/native/wda-401F3DA8.log')
  })

  test('a path inside the decisive line is the log too, and no path means no log', () => {
    expect(failureDetail('WebDriverAgent build failed (see /tmp/wda.log)').log).toBe('/tmp/wda.log')
    expect(failureDetail('Appium did not answer').log).toBeNull()
  })
})

describe('the shown device waits for its input session', () => {
  test('showing a device starts its session once and reports starting before any answer', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    await h.settle()
    expect(h.count(`start ${UDID}`)).toBe(1)
    expect(screen.views[0]).toEqual({ kind: 'starting', phase: null, elapsedMs: 0 })
  })

  test('while starting it asks for the status every second and shows the phase and elapsed time', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    h.answers.set(UDID, status('starting', { phase: 'Building WebDriverAgent', startedAt: h.at(0) }))
    await h.advance(1_000)
    expect(screen.last()).toEqual({ kind: 'starting', phase: 'Building WebDriverAgent', elapsedMs: 1_000 })
    await h.advance(41_000)
    expect(screen.last()).toEqual({ kind: 'starting', phase: 'Building WebDriverAgent', elapsedMs: 42_000 })
    expect(h.count(`status ${UDID}`)).toBe(42)
    expect(h.count(`start ${UDID}`)).toBe(1)
  })

  test('ready ends the polling', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    await h.advance(3_000)
    h.answers.set(UDID, status('ready'))
    await h.advance(1_000)
    expect(screen.last()).toEqual({ kind: 'ready' })
    const polls = h.count(`status ${UDID}`)
    await h.advance(10_000)
    expect(h.count(`status ${UDID}`)).toBe(polls)
  })

  test('a failed start shows the CLI’s error and stops polling', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    h.answers.set(UDID, status('failed', { error: 'xcodebuild exited with code 65' }))
    await h.advance(1_000)
    expect(screen.last()).toEqual({ kind: 'failed', error: 'xcodebuild exited with code 65' })
    const polls = h.count(`status ${UDID}`)
    await h.advance(5_000)
    expect(h.count(`status ${UDID}`)).toBe(polls)
  })

  test('a start the CLI refuses is a failure with its message', async () => {
    const h = harness()
    h.starts.set(UDID, new Error(`simulator ${UDID} is being driven by Maestro run run-1`))
    const screen = h.watch(UDID)
    await h.advance(2_000)
    expect(screen.last()).toEqual({ kind: 'failed', error: `simulator ${UDID} is being driven by Maestro run run-1` })
    expect(h.count(`status ${UDID}`)).toBe(0)
  })

  test('a status call that errors is a failure with that message', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    h.answers.set(UDID, new Error('megabrain exited with code 1'))
    await h.advance(1_000)
    expect(screen.last()).toEqual({ kind: 'failed', error: 'megabrain exited with code 1' })
  })

  test('Retry after a failure starts again and shows progress from zero', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    h.answers.set(UDID, status('failed', { error: 'boom' }))
    await h.advance(1_000)
    h.answers.set(UDID, status('starting', { phase: 'Starting Appium', startedAt: h.at(1_000) }))
    h.sessions.retry(UDID)
    await h.settle()
    expect(h.count(`start ${UDID}`)).toBe(2)
    expect(screen.last()).toEqual({ kind: 'starting', phase: null, elapsedMs: 0 })
    await h.advance(1_000)
    expect(screen.last()).toEqual({ kind: 'starting', phase: 'Starting Appium', elapsedMs: 1_000 })
  })

  test('two views of one device share one session', async () => {
    const h = harness()
    h.watch(UDID)
    h.watch(UDID)
    await h.advance(3_000)
    expect(h.count(`start ${UDID}`)).toBe(1)
    expect(h.count(`status ${UDID}`)).toBe(3)
  })
})

describe('switching away while starting', () => {
  test('switching to another device and back does not start a second session, and resumes the progress', async () => {
    const h = harness()
    const first = h.watch(UDID)
    h.answers.set(UDID, status('starting', { phase: 'Building WebDriverAgent', startedAt: h.at(0) }))
    await h.advance(5_000)
    first.release()
    const other = h.watch(OTHER)
    await h.advance(10_000)
    other.release()
    const back = h.watch(UDID)
    expect(back.views[0]).toEqual({ kind: 'starting', phase: 'Building WebDriverAgent', elapsedMs: 15_000 })
    await h.advance(1_000)
    expect(back.last()).toEqual({ kind: 'starting', phase: 'Building WebDriverAgent', elapsedMs: 16_000 })
    expect(h.count(`start ${UDID}`)).toBe(1)
    expect(h.count(`stop ${UDID}`)).toBe(0)
  })

  test('a session left while starting is not stopped mid-start; once ready with nobody watching it stops after the delay', async () => {
    const h = harness()
    const screen = h.watch(UDID)
    await h.advance(2_000)
    screen.release()
    await h.advance(5_000)
    expect(h.count(`stop ${UDID}`)).toBe(0)
    h.answers.set(UDID, status('ready'))
    await h.advance(1_000)
    expect(h.count(`stop ${UDID}`)).toBe(0)
    await h.advance(1_500)
    expect(h.count(`stop ${UDID}`)).toBe(1)
  })

  test('a ready session shown again within the delay is kept, without a new start', async () => {
    const h = harness()
    h.answers.set(UDID, status('ready'))
    const screen = h.watch(UDID)
    await h.advance(1_000)
    screen.release()
    await h.advance(1_000)
    const back = h.watch(UDID)
    expect(back.views[0]).toEqual({ kind: 'ready' })
    await h.advance(5_000)
    expect(h.count(`stop ${UDID}`)).toBe(0)
    expect(h.count(`start ${UDID}`)).toBe(1)
  })

  test('a ready session left past the delay stops, and showing it again starts a new one', async () => {
    const h = harness()
    h.answers.set(UDID, status('ready'))
    const screen = h.watch(UDID)
    await h.advance(1_000)
    screen.release()
    await h.advance(1_500)
    expect(h.count(`stop ${UDID}`)).toBe(1)
    h.answers.set(UDID, status('starting'))
    const back = h.watch(UDID)
    await h.settle()
    expect(back.views[0]).toEqual({ kind: 'starting', phase: null, elapsedMs: 0 })
    expect(h.count(`start ${UDID}`)).toBe(2)
  })
})
