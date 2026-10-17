import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { maestroEventSchema, maestroFlowSchema, maestroRunSchema, simulatorListSchema, type MaestroEvent } from '@/api/schema'
import { bootThenRun, sleepNote, defaultDevice, deviceLayout, durationLabel, groupFlows, historyRows, idleRun, isActive, needsInstall, newFlowName, reduceRun, screenSource, sortDevices, stepRows, timeLabel, type RunState } from '@/device/device-model'
import { changesPolicy, planPoll, pollInterval, projectsPolicy, screenPolicy } from '@/lib/poll-model'

const captured = (name: string) => readFileSync(join(import.meta.dir, '..', 'api', 'fixtures', 'captured', name), 'utf8')
const events = (name: string): MaestroEvent[] =>
  captured(name)
    .trim()
    .split('\n')
    .map((line) => maestroEventSchema.parse(JSON.parse(line)))
const UDID = '401F3DA8-E4C1-48B7-9BB9-2C8416115E1A'
const requested = reduceRun(idleRun, { type: 'request', flow: '.maestro/prefs.yaml', device: UDID })
const play = (state: RunState, list: readonly MaestroEvent[]) => list.reduce((current, event) => reduceRun(current, { type: 'event', event }), state)

describe('a run as its JSON lines arrive', () => {
  test('asking for a run queues it until the CLI says it started', () => {
    expect(requested.phase).toBe('queued')
    expect(isActive(requested)).toBe(true)
    expect(stepRows(requested)).toEqual([])
  })

  test('the start line makes it running, with a pending first step', () => {
    const [start] = events('maestro-run-passed.jsonl')
    const running = play(requested, start === undefined ? [] : [start])
    expect(running.phase).toBe('running')
    expect(running.runId).toBe(start?.type === 'start' ? start.runId : null)
    expect(stepRows(running)).toEqual([{ index: 1, command: null, status: 'running', durationMs: null, screenshot: null, error: null }])
  })

  test('each finished step fills in and the next index shows as running', () => {
    const lines = events('maestro-run-passed.jsonl')
    const twoSteps = play(requested, lines.slice(0, 3))
    expect(stepRows(twoSteps).map((row) => [row.index, row.status])).toEqual([
      [1, 'passed'],
      [2, 'passed'],
      [3, 'running'],
    ])
  })

  test('a passed run ends with every step and no pending row', () => {
    const done = play(requested, events('maestro-run-passed.jsonl'))
    expect(done.phase).toBe('passed')
    expect(isActive(done)).toBe(false)
    const rows = stepRows(done)
    expect(rows.map((row) => row.status)).toEqual(['passed', 'passed', 'passed'])
    expect(rows[2]?.screenshot).toContain('prefs-home.png')
    expect(typeof done.durationMs).toBe('number')
  })

  test('a failed step keeps its error and no step shows as running after it', () => {
    const lines = events('maestro-run-failed.jsonl')
    const beforeVerdict = play(requested, lines.slice(0, -1))
    expect(beforeVerdict.phase).toBe('running')
    expect(stepRows(beforeVerdict).map((row) => row.status)).toEqual(['passed', 'failed'])
    const done = play(requested, lines)
    expect(done.phase).toBe('failed')
    expect(stepRows(done)[1]?.error).toContain('Assertion is false')
  })

  test('a step line that repeats an index replaces it instead of adding a row', () => {
    const lines = events('maestro-run-passed.jsonl')
    const step = lines[1]
    const twice = play(requested, step === undefined ? lines : [...lines.slice(0, 2), step])
    expect(stepRows(twice).filter((row) => row.index === 1)).toHaveLength(1)
  })

  test('a stop while running ends as stopped when the stream closes without a verdict', () => {
    const running = play(requested, events('maestro-run-passed.jsonl').slice(0, 2))
    const stopping = reduceRun(running, { type: 'stop' })
    expect(stopping.stopping).toBe(true)
    const ended = reduceRun(stopping, { type: 'end', error: null })
    expect(ended.phase).toBe('stopped')
    expect(ended.error).toBeNull()
  })

  test('a stream that ends early without a stop fails with the CLI error', () => {
    const ended = reduceRun(requested, { type: 'end', error: 'Maestro is not installed; run megabrain install simulator-maestro' })
    expect(ended.phase).toBe('failed')
    expect(ended.error).toContain('not installed')
    expect(needsInstall(ended.error)).toBe(true)
    expect(reduceRun(requested, { type: 'end', error: null }).error).toBe('The run ended without a result.')
  })

  test('the end of a stream after the verdict changes nothing', () => {
    const done = play(requested, events('maestro-run-failed.jsonl'))
    expect(reduceRun(done, { type: 'end', error: '' })).toEqual(done)
  })

  test('only the Maestro-missing error asks for the install', () => {
    expect(needsInstall('no iOS simulator is booted; boot one with xcrun simctl boot <udid>')).toBe(false)
    expect(needsInstall(null)).toBe(false)
  })
})

describe('the screen', () => {
  const done = play(requested, events('maestro-run-passed.jsonl'))
  const rows = stepRows(done)
  test('a chosen step with a screenshot shows it', () => {
    expect(screenSource({ selected: 3, rows, capture: '/state/native/screens/x.png' })).toEqual({ path: rows[2]?.screenshot ?? '', step: 3 })
  })
  test('otherwise the live capture shows, then the latest step screenshot', () => {
    expect(screenSource({ selected: 1, rows, capture: '/live.png' })).toEqual({ path: '/live.png', step: null })
    expect(screenSource({ selected: null, rows, capture: null })).toEqual({ path: rows[2]?.screenshot ?? '', step: 3 })
    expect(screenSource({ selected: null, rows: [], capture: null })).toBeNull()
  })
})

describe('history', () => {
  const runs = maestroRunSchema.array().parse(JSON.parse(captured('maestro-runs.json')))
  test('lists the CLI runs newest first with labels for status, duration and time', () => {
    const now = Date.parse(runs[0]?.startedAt ?? '') + 5 * 60_000
    const rows = historyRows(runs, now)
    expect(rows.map((row) => row.state)).toEqual(['failed', 'passed'])
    expect(rows[0]?.time).toBe('5 min ago')
    expect(rows[0]?.duration).toMatch(/ms$/)
  })
  test('durations read in ms, seconds, then minutes; an unfinished one is a dash', () => {
    expect(durationLabel(850)).toBe('850 ms')
    expect(durationLabel(4_200)).toBe('4.2 s')
    expect(durationLabel(65_000)).toBe('1 m 05 s')
    expect(durationLabel(null)).toBe('—')
  })
  test('times read relative within a day, then as a date', () => {
    const now = Date.parse('2026-10-17T12:00:00Z')
    expect(timeLabel('2026-10-17T11:59:40Z', now)).toBe('just now')
    expect(timeLabel('2026-10-17T09:00:00Z', now)).toBe('3 h ago')
    expect(timeLabel('2026-10-12T09:00:00Z', now)).toMatch(/Oct 12/)
  })
  test('keeps the latest twenty', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...runs[0], runId: `run-${index}` }) as (typeof runs)[number])
    expect(historyRows(many, Date.now())).toHaveLength(20)
  })
})

describe('flows', () => {
  const flows = maestroFlowSchema.array().parse([
    { path: '.maestro/auth/login.yaml', name: 'login', appId: 'com.example.app' },
    { path: '.maestro/prefs.yaml', name: 'Preferences opens', appId: 'com.apple.Preferences' },
    { path: 'maestro/home.yml', name: 'Home', appId: null },
  ])
  test('the captured listing parses', () => {
    expect(maestroFlowSchema.array().parse(JSON.parse(captured('maestro-flows.json')))[0]?.path).toBe('.maestro/prefs.yaml')
  })
  test('group by folder, in path order', () => {
    expect(groupFlows(flows, '').map((group) => [group.folder, group.flows.map((flow) => flow.name)])).toEqual([
      ['.maestro', ['Preferences opens']],
      ['.maestro/auth', ['login']],
      ['maestro', ['Home']],
    ])
  })
  test('search matches the name or the path, ignoring case, and drops empty folders', () => {
    expect(groupFlows(flows, 'PREF').map((group) => group.folder)).toEqual(['.maestro'])
    expect(groupFlows(flows, 'auth/').map((group) => group.flows[0]?.name)).toEqual(['login'])
    expect(groupFlows(flows, 'nothing')).toEqual([])
  })
  test('a new flow name follows the CLI rule', () => {
    expect(newFlowName(' checkout ')).toBe('checkout')
    expect(newFlowName('smoke.yaml')).toBe('smoke')
    expect(newFlowName('a/b')).toBeNull()
    expect(newFlowName('.hidden')).toBeNull()
    expect(newFlowName('')).toBeNull()
  })
})

describe('devices', () => {
  const listed = simulatorListSchema.parse(JSON.parse(captured('native-sim-list.json'))).devices
  const devices = [
    { udid: 'b', name: 'iPhone 17', state: 'Shutdown' },
    { udid: 'a', name: 'iPhone 18 Pro', state: 'Booted' },
    { udid: 'c', name: 'iPad Air', state: 'Shutdown' },
  ]
  test('the captured simulator list parses', () => {
    expect(listed.length).toBeGreaterThan(0)
  })
  test('booted simulators come first, then by name', () => {
    expect(sortDevices(devices).map((device) => device.udid)).toEqual(['a', 'c', 'b'])
  })
  test('the chosen device stays while listed; otherwise the first booted, else the first', () => {
    expect(defaultDevice(devices, 'c')).toBe('c')
    expect(defaultDevice(devices, 'gone')).toBe('a')
    expect(defaultDevice(devices.filter((device) => device.state !== 'Booted'), null)).toBe('c')
    expect(defaultDevice([], null)).toBeNull()
  })
})

describe('layout', () => {
  test('three columns when wide, two in the middle, stacked when narrow', () => {
    expect(deviceLayout(1280)).toBe('columns')
    expect(deviceLayout(1080)).toBe('columns')
    expect(deviceLayout(900)).toBe('split')
    expect(deviceLayout(720)).toBe('split')
    expect(deviceLayout(719)).toBe('stack')
  })
})

describe('a simulator megabrain shut down', () => {
  const phone = (state: string) => ({ udid: UDID, name: 'iPhone', state, runtime: 'iOS 27.0' }) as never
  test('shows as asleep only when megabrain put it to sleep', () => {
    expect(sleepNote(phone('Shutdown'), [UDID])).toBe('Asleep: boots when you run a flow')
    expect(sleepNote(phone('Shutdown'), [])).toBeNull()
    expect(sleepNote(phone('Booted'), [UDID])).toBeNull()
  })

  test('Run boots a shut down simulator before it starts the flow', async () => {
    const order: string[] = []
    await bootThenRun(true, async () => void order.push('boot'), () => void order.push('run'))
    expect(order).toEqual(['boot', 'run'])
  })

  test('Run on a booted simulator does not boot', async () => {
    const order: string[] = []
    await bootThenRun(false, async () => void order.push('boot'), () => void order.push('run'))
    expect(order).toEqual(['run'])
  })

  test('a failed boot never starts the run', async () => {
    const order: string[] = []
    await expect(bootThenRun(true, async () => Promise.reject(new Error('no boot')), () => void order.push('run'))).rejects.toThrow('no boot')
    expect(order).toEqual([])
  })
})

describe('the Device tab polls only while it shows', () => {
  test.each([['changes', changesPolicy], ['devices', projectsPolicy], ['screen', screenPolicy]])('%s waits while the window is hidden', (_name, policy) => {
    expect(pollInterval(policy, false)).toBeNull()
    for (const trigger of ['timer', 'visibility'] as const) expect(planPoll(policy, trigger, { visible: false, now: 10_000_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: null })
  })
})
