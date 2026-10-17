import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { maestroEventSchema, maestroFlowSchema, maestroRunSchema, simulatorListSchema, type MaestroEvent } from '@/api/schema'
import { afterRename, afterRestart, afterShutdown, bootThenRun, devicePanels, deviceSections, othersLabel, panelsShown, renameCommit, sleepNote, deviceLayout, durationLabel, groupFlows, historyRows, idleRun, isActive, needsInstall, newFlowName, openDevices, pickerChoices, reduceRun, screenSource, selectDevice, stepRows, timeLabel, type DeviceChoice, type OpenDevice, type RunState } from '@/device/device-model'
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
  const booted = [
    { udid: 'tv', name: 'Apple TV 4K', runtime: 'tvOS 27.0', state: 'Booted', kind: 'tv' as const },
    { udid: 'p2', name: 'iPhone 18 Pro', runtime: 'iOS 27.0', state: 'Booted', kind: 'phone' as const },
    { udid: 'p1', name: 'iPhone 17', runtime: 'iOS 27.0', state: 'Booted', kind: 'phone' as const },
  ]
  const available: DeviceChoice[] = [
    { udid: 'p1', name: 'iPhone 17', state: 'Booted', kind: 'phone' },
    { udid: 'p2', name: 'iPhone 18 Pro', state: 'Booted', kind: 'phone' },
    { udid: 'p3', name: 'iPhone Air', state: 'Shutdown', kind: 'phone' },
    { udid: 'p0', name: 'iPad mini', state: 'Shutdown', kind: 'phone' },
    { udid: 'tv', name: 'Apple TV 4K', state: 'Booted', kind: 'tv' },
    { udid: 'tv2', name: 'Apple TV', state: 'Shutdown', kind: 'tv' },
  ]
  const open = openDevices(booted, available, [])

  test('the captured simulator list parses', () => {
    expect(listed.length).toBeGreaterThan(0)
  })

  test('the open devices are the booted ones, phones first, then by name', () => {
    expect(open.map((device) => device.udid)).toEqual(['p1', 'p2', 'tv'])
    expect(open[0]).toEqual({ udid: 'p1', name: 'iPhone 17', runtime: 'iOS 27.0', kind: 'phone', state: 'Booted', worktree: null })
  })

  test('a row that is not booted is not open', () => {
    expect(openDevices([{ ...booted[1], state: 'Shutdown' } as (typeof booted)[number]], available, []).map((device) => device.udid)).toEqual([])
  })

  test('a simulator megabrain put to sleep stays open as asleep', () => {
    const withSleeper = openDevices(booted, available, ['p3'])
    expect(withSleeper.map((device) => [device.udid, device.state])).toEqual([
      ['p1', 'Booted'],
      ['p2', 'Booted'],
      ['p3', 'Asleep'],
      ['tv', 'Booted'],
    ])
    expect(withSleeper.find((device) => device.udid === 'p3')?.runtime).toBeNull()
  })

  test('the chosen device stays selected while open; otherwise the first; none when nothing is open', () => {
    expect(selectDevice(open, 'tv')).toBe('tv')
    expect(selectDevice(open, 'gone')).toBe('p1')
    expect(selectDevice(open, null)).toBe('p1')
    expect(selectDevice([], 'tv')).toBeNull()
  })

  test('the picker offers every available device that is not open, phones first, then by name', () => {
    expect(pickerChoices(available, open).map((device) => device.udid)).toEqual(['p0', 'p3', 'tv2'])
  })

  test('a device that is asleep is open, so the picker leaves it out', () => {
    expect(pickerChoices(available, openDevices(booted, available, ['p3'])).map((device) => device.udid)).toEqual(['p0', 'tv2'])
  })

  test('shutting down removes the device and moves the selection to the first left', () => {
    const shut = afterShutdown(open, 'p1', 'p1')
    expect(shut.open.map((device) => device.udid)).toEqual(['p2', 'tv'])
    expect(shut.selected).toBe('p2')
  })

  test('shutting down another device keeps the selection', () => {
    expect(afterShutdown(open, 'p1', 'tv')).toEqual({ open: open.filter((device) => device.udid !== 'tv'), selected: 'p1' })
  })

  test('shutting down the last device leaves nothing selected', () => {
    const only: OpenDevice[] = open.slice(0, 1)
    expect(afterShutdown(only, 'p1', 'p1')).toEqual({ open: [], selected: null })
  })

  test('restarting keeps the device and the selection, and marks it booted', () => {
    const sleeping = openDevices(booted, available, ['p3'])
    const restarted = afterRestart(sleeping, 'p3', 'p3')
    expect(restarted.selected).toBe('p3')
    expect(restarted.open.map((device) => device.udid)).toEqual(['p1', 'p2', 'p3', 'tv'])
    expect(restarted.open.find((device) => device.udid === 'p3')?.state).toBe('Booted')
    expect(afterRestart(open, 'p2', 'tv').selected).toBe('p2')
  })
})

describe('devices belong to a worktree', () => {
  const ROOT = '/w/megabrain-feat-a'
  const projects = [
    { name: 'megabrain', worktrees: [{ path: '/w/megabrain', branch: 'main' }, { path: ROOT, branch: 'feat/a' }, { path: '/w/megabrain-fix-b', branch: 'fix/b' }] },
    { name: 'canto', worktrees: [{ path: '/w/canto', branch: 'main' }] },
  ]
  const row = (udid: string, name: string, worktree: string | null, kind: 'phone' | 'tv' = 'phone') => ({ udid, name, runtime: 'iOS 27.0', state: 'Booted', kind, worktree })
  const booted = [
    row('mine', 'iPhone 17', ROOT),
    row('mine-slash', 'iPhone 16', `${ROOT}/`),
    row('free', 'iPhone Air', null),
    row('tv-free', 'Apple TV', null, 'tv'),
    row('fix', 'iPhone 18 Pro', '/w/megabrain-fix-b'),
    row('canto', 'iPhone 17e', '/w/canto'),
    row('canto-tv', 'Apple TV 4K', '/w/canto', 'tv'),
    row('lost', 'iPhone SE', '/w/gone-project'),
  ]
  const open = openDevices(booted, [], [])
  const sections = deviceSections(open, ROOT, projects)

  test('a booted row carries its worktree, and an older CLI without one reads as unowned', () => {
    expect(open.find((device) => device.udid === 'fix')?.worktree).toBe('/w/megabrain-fix-b')
    expect(openDevices([{ udid: 'old', name: 'iPhone', runtime: 'iOS 27.0', state: 'Booted', kind: 'phone' }], [], [])[0]?.worktree).toBeNull()
  })

  test('the list keeps the devices this worktree owns and the unowned ones, a trailing slash ignored', () => {
    expect(sections.mine.map((device) => device.udid)).toEqual(['mine-slash', 'mine', 'free', 'tv-free'])
  })

  test('an unowned device shows as available; an owned one does not', () => {
    expect(sections.available).toEqual(['free', 'tv-free'])
  })

  test('a device asleep has no owner known, so it is available here', () => {
    const asleep = deviceSections(openDevices([], [{ udid: 'zz', name: 'iPhone 15', state: 'Shutdown', kind: 'phone' }], ['zz']), ROOT, projects)
    expect(asleep.mine.map((device) => device.udid)).toEqual(['zz'])
    expect(asleep.available).toEqual(['zz'])
  })

  test('devices owned elsewhere are grouped by project and branch, projects by name', () => {
    expect(sections.others.map((group) => [group.project, group.branch, group.root, group.devices.map((device) => device.udid)])).toEqual([
      ['canto', 'main', '/w/canto', ['canto', 'canto-tv']],
      ['gone-project', null, '/w/gone-project', ['lost']],
      ['megabrain', 'fix/b', '/w/megabrain-fix-b', ['fix']],
    ])
  })

  test('the count is every device owned by another worktree', () => {
    expect(sections.othersCount).toBe(4)
    expect(othersLabel(sections.othersCount)).toBe('4 running in other projects')
    expect(othersLabel(1)).toBe('1 running in another project')
    expect(othersLabel(0)).toBeNull()
  })

  test('nothing elsewhere leaves no groups', () => {
    const alone = deviceSections(openDevices([row('mine', 'iPhone 17', ROOT)], [], []), ROOT, projects)
    expect(alone.others).toEqual([])
    expect(alone.othersCount).toBe(0)
  })
})

describe('renaming a device', () => {
  const device: OpenDevice = { udid: 'p1', name: 'iPhone 17', runtime: 'iOS 27.0', kind: 'phone', state: 'Booted', worktree: null }

  test('a new name is saved trimmed', () => {
    expect(renameCommit({ udid: 'p1', text: '  QA phone ' }, device)).toEqual({ udid: 'p1', name: 'QA phone' })
  })

  test('an empty, unchanged or over-long name saves nothing', () => {
    expect(renameCommit({ udid: 'p1', text: '   ' }, device)).toBeNull()
    expect(renameCommit({ udid: 'p1', text: 'iPhone 17 ' }, device)).toBeNull()
    expect(renameCommit({ udid: 'p1', text: 'x'.repeat(256) }, device)).toBeNull()
    expect(renameCommit({ udid: 'p1', text: 'x'.repeat(255) }, device)).toEqual({ udid: 'p1', name: 'x'.repeat(255) })
  })

  test('no draft, or a draft for another device, saves nothing', () => {
    expect(renameCommit(null, device)).toBeNull()
    expect(renameCommit({ udid: 'p2', text: 'QA phone' }, device)).toBeNull()
  })

  test('a saved name shows at once, keeping the order by name', () => {
    const open: OpenDevice[] = [device, { ...device, udid: 'p2', name: 'iPhone 18' }]
    expect(afterRename(open, 'p1', 'Zed phone').map((entry) => [entry.udid, entry.name])).toEqual([
      ['p2', 'iPhone 18'],
      ['p1', 'Zed phone'],
    ])
  })
})

describe('collapsing the panels', () => {
  test('each panel remembers its own open state', () => {
    expect(devicePanels.devices).not.toBe(devicePanels.flows)
  })

  test('side by side, each panel shows only while open', () => {
    expect(panelsShown('columns', { devices: true, flows: true })).toEqual({ devices: true, flows: true })
    expect(panelsShown('columns', { devices: false, flows: true })).toEqual({ devices: false, flows: true })
    expect(panelsShown('columns', { devices: false, flows: false })).toEqual({ devices: false, flows: false })
  })

  test('in the middle layout the devices sit over the flows, so closing the flows closes the column', () => {
    expect(panelsShown('split', { devices: false, flows: true })).toEqual({ devices: false, flows: true })
    expect(panelsShown('split', { devices: true, flows: false })).toEqual({ devices: false, flows: false })
  })

  test('stacked, nothing collapses', () => {
    expect(panelsShown('stack', { devices: false, flows: false })).toEqual({ devices: true, flows: true })
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
