import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { maestroEventSchema, maestroFlowSchema, maestroRunSchema, simulatorListSchema, type MaestroEvent } from '@/api/schema'
import { groupDevices, groupOf, afterRename, afterRestart, afterShutdown, bootThenRun, devicePanels, deviceSections, deviceWidths, elsewhereLabel, panelPlaces, renameCommit, sleepNote, durationLabel, groupFlows, historyRows, idleRun, isActive, needsInstall, newFlowName, openDevices, pickerChoices, reduceRun, screenSource, selectDevice, staleDeviceNote, stepRows, timeLabel, type DeviceChoice, type OpenDevice, type RunState } from '@/device/device-model'
import { changesPolicy, devicesPolicy, planPoll, pollInterval, projectsPolicy, screenPolicy } from '@/lib/poll-model'

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
    expect(open[0]).toEqual({ udid: 'p1', name: 'iPhone 17', runtime: 'iOS 27.0', kind: 'phone', state: 'Booted', worktree: null, project: null })
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

describe('devices belong to a project', () => {
  const ROOT = '/w/megabrain-feat-a'
  const projects = [
    { name: 'megabrain', path: '/w/megabrain', worktrees: [{ path: '/w/megabrain', branch: 'main' }, { path: ROOT, branch: 'feat/a' }, { path: '/w/megabrain-fix-b', branch: 'fix/b' }] },
    { name: 'canto', path: '/w/canto', worktrees: [{ path: '/w/canto', branch: 'main' }] },
  ]
  const row = (udid: string, name: string, worktree: string | null, kind: 'phone' | 'tv' = 'phone', project?: string | null) => ({ udid, name, runtime: 'iOS 27.0', state: 'Booted', kind, worktree, ...(project === undefined ? {} : { project }) })
  const booted = [
    row('mine', 'iPhone 17', ROOT),
    row('mine-slash', 'iPhone 16', `${ROOT}/`),
    row('sibling', 'iPhone 18 Pro', '/w/megabrain-fix-b'),
    row('main-checkout', 'iPad Air', '/w/megabrain'),
    row('free', 'iPhone Air', null),
    row('tv-free', 'Apple TV', null, 'tv'),
    row('canto', 'iPhone 17e', '/w/canto'),
    row('canto-tv', 'Apple TV 4K', '/w/canto', 'tv'),
    row('reported', 'iPhone 15', null, 'phone', '/w/canto'),
    row('reported-name', 'iPhone 14', '/w/somewhere', 'phone', 'canto'),
    row('lost', 'iPhone SE', '/w/gone-project'),
  ]
  const open = openDevices(booted, [], [])
  const sections = deviceSections(open, ROOT, projects)

  test('a booted row carries its worktree and project, and an older CLI without them reads as unowned', () => {
    expect(open.find((device) => device.udid === 'sibling')?.worktree).toBe('/w/megabrain-fix-b')
    expect(open.find((device) => device.udid === 'reported')?.project).toBe('/w/canto')
    const old = openDevices([{ udid: 'old', name: 'iPhone', runtime: 'iOS 27.0', state: 'Booted', kind: 'phone' }], [], [])[0]
    expect([old?.worktree, old?.project]).toEqual([null, null])
  })

  test('the list keeps only the devices of this project, from any of its worktrees, a trailing slash ignored', () => {
    expect(sections.mine.map((device) => device.udid)).toEqual(['main-checkout', 'mine-slash', 'mine', 'sibling'])
  })

  test('an unowned device is never listed as this project\'s', () => {
    expect(sections.mine.some((device) => device.worktree === null && device.project === null)).toBe(false)
  })

  test('the project the CLI reports wins over the worktree, by path or by name', () => {
    const canto = sections.elsewhere.find((group) => group.title === 'canto')
    expect(canto?.devices.map((entry) => entry.device.udid)).toEqual(['reported-name', 'reported', 'canto', 'canto-tv'])
  })

  test('devices elsewhere are grouped by project, projects by name, Not assigned last', () => {
    expect(sections.elsewhere.map((group) => [group.title, group.assigned, group.devices.map((entry) => entry.device.udid)])).toEqual([
      ['canto', true, ['reported-name', 'reported', 'canto', 'canto-tv']],
      ['gone-project', true, ['lost']],
      ['Not assigned', false, ['free', 'tv-free']],
    ])
  })

  test('each device elsewhere names the branch it is on when its worktree is known', () => {
    const canto = sections.elsewhere.find((group) => group.title === 'canto')
    expect(canto?.devices.map((entry) => [entry.device.udid, entry.branch])).toEqual([
      ['reported-name', null],
      ['reported', null],
      ['canto', 'main'],
      ['canto-tv', 'main'],
    ])
  })

  test('the indicator counts every device elsewhere, Not assigned included', () => {
    expect(sections.elsewhereCount).toBe(7)
    expect(elsewhereLabel(sections.elsewhereCount)).toBe('7 elsewhere')
    expect(elsewhereLabel(1)).toBe('1 elsewhere')
    expect(elsewhereLabel(0)).toBeNull()
  })

  test('a device asleep with no owner known is Not assigned, not this project\'s', () => {
    const asleep = deviceSections(openDevices([], [{ udid: 'zz', name: 'iPhone 15', state: 'Shutdown', kind: 'phone' }], ['zz']), ROOT, projects)
    expect(asleep.mine).toEqual([])
    expect(asleep.elsewhere.map((group) => [group.title, group.assigned, group.devices.map((entry) => [entry.device.udid, entry.device.state])])).toEqual([['Not assigned', false, [['zz', 'Asleep']]]])
  })

  test('a worktree no project lists keeps only the devices it owns itself', () => {
    const loose = deviceSections(openDevices([row('here', 'iPhone 17', '/w/loose'), row('free', 'iPhone Air', null)], [], []), '/w/loose', projects)
    expect(loose.mine.map((device) => device.udid)).toEqual(['here'])
    expect(loose.elsewhere.map((group) => group.title)).toEqual(['Not assigned'])
  })

  test('a project the list does not know is titled by its folder', () => {
    const unknown = deviceSections(openDevices([row('x', 'iPhone 17', null, 'phone', '/w/other-repo')], [], []), ROOT, projects)
    expect(unknown.elsewhere.map((group) => group.title)).toEqual(['other-repo'])
  })

  test('nothing elsewhere leaves no groups', () => {
    const alone = deviceSections(openDevices([row('mine', 'iPhone 17', ROOT)], [], []), ROOT, projects)
    expect(alone.elsewhere).toEqual([])
    expect(alone.elsewhereCount).toBe(0)
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

describe('the panels never merge', () => {
  const both = { devices: true, flows: true }
  const { devices: D, flows: F, screen: S } = deviceWidths

  test('each panel remembers its own open state', () => {
    expect(devicePanels.devices).not.toBe(devicePanels.flows)
  })

  test('wide enough for both and the screen, both sit beside it', () => {
    expect(panelPlaces(D + F + S, both, null)).toEqual({ devices: 'side', flows: 'side' })
    expect(panelPlaces(1600, both, null)).toEqual({ devices: 'side', flows: 'side' })
  })

  test('too narrow for both, the flows collapse first', () => {
    expect(panelPlaces(D + F + S - 1, both, null)).toEqual({ devices: 'side', flows: 'hidden' })
    expect(panelPlaces(D + S, both, null)).toEqual({ devices: 'side', flows: 'hidden' })
  })

  test('too narrow for the devices too, both collapse', () => {
    expect(panelPlaces(D + S - 1, both, null)).toEqual({ devices: 'hidden', flows: 'hidden' })
  })

  test('a panel the person closed stays closed, and leaves its room to the other', () => {
    expect(panelPlaces(1600, { devices: false, flows: true }, null)).toEqual({ devices: 'hidden', flows: 'side' })
    expect(panelPlaces(F + S, { devices: false, flows: true }, null)).toEqual({ devices: 'hidden', flows: 'side' })
    expect(panelPlaces(F + S - 1, { devices: false, flows: true }, null)).toEqual({ devices: 'hidden', flows: 'hidden' })
  })

  test('a collapsed panel reopened overlays the screen, the other keeping its place', () => {
    expect(panelPlaces(D + S, both, 'flows')).toEqual({ devices: 'side', flows: 'overlay' })
    expect(panelPlaces(D + S - 1, both, 'devices')).toEqual({ devices: 'overlay', flows: 'hidden' })
    expect(panelPlaces(D + S - 1, both, 'flows')).toEqual({ devices: 'hidden', flows: 'overlay' })
  })

  test('a reopened panel that fits sits beside the screen', () => {
    expect(panelPlaces(1600, both, 'flows')).toEqual({ devices: 'side', flows: 'side' })
  })

  test('at any width every panel is beside, over or hidden, and at most one overlays', () => {
    for (let width = 200; width <= 2000; width += 10)
      for (const peek of [null, 'devices', 'flows'] as const) {
        const places = panelPlaces(width, both, peek)
        expect(['side', 'overlay', 'hidden']).toContain(places.devices)
        expect(['side', 'overlay', 'hidden']).toContain(places.flows)
        expect(Number(places.devices === 'overlay') + Number(places.flows === 'overlay')).toBeLessThanOrEqual(1)
        // What sits beside the screen always leaves it its room.
        expect((places.devices === 'side' ? D : 0) + (places.flows === 'side' ? F : 0) + S).toBeLessThanOrEqual(Math.max(width, S))
      }
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

describe('a shut down device leaves the list', () => {
  test('the Device tab reads its devices every 5 s while the window shows, at once after an action or focus, and not while hidden', () => {
    expect(devicesPolicy).toEqual({ visibleMs: 5_000, hiddenMs: null, refreshOn: { action: true, focus: true } })
    expect(planPoll(devicesPolicy, 'timer', { visible: true, now: 5_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 5_000 })
    expect(planPoll(devicesPolicy, 'timer', { visible: true, now: 3_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: 2_000 })
    expect(planPoll(devicesPolicy, 'action', { visible: true, now: 1_000, lastRunAt: 0 })).toEqual({ run: true, nextInMs: 5_000 })
    expect(planPoll(devicesPolicy, 'timer', { visible: false, now: 60_000, lastRunAt: 0 })).toEqual({ run: false, nextInMs: null })
  })

  test('a device shut down by hand is gone from the next read, mine or elsewhere; one megabrain put to sleep stays', () => {
    const before = openDevices(
      [
        { udid: 'p1', name: 'iPhone 17', runtime: 'iOS 27.0', state: 'Booted', kind: 'phone', worktree: null, project: null },
        { udid: 'tv', name: 'Apple TV 4K', runtime: 'tvOS 27.0', state: 'Booted', kind: 'tv', worktree: null, project: null },
      ],
      [],
      [],
    )
    expect(before.map((device) => device.udid)).toEqual(['p1', 'tv'])
    const choices: DeviceChoice[] = [
      { udid: 'p1', name: 'iPhone 17', state: 'Shutdown', kind: 'phone' },
      { udid: 'p2', name: 'iPhone Air', state: 'Shutdown', kind: 'phone' },
      { udid: 'tv', name: 'Apple TV 4K', state: 'Booted', kind: 'tv' },
    ]
    const after = openDevices([{ udid: 'tv', name: 'Apple TV 4K', runtime: 'tvOS 27.0', state: 'Booted', kind: 'tv', worktree: null, project: null }], choices, ['p2'])
    expect(after.map((device) => [device.udid, device.state])).toEqual([
      ['p2', 'Asleep'],
      ['tv', 'Booted'],
    ])
    expect(deviceSections(after, '/w/here', []).elsewhere.flatMap((group) => group.devices.map((entry) => entry.device.udid))).toEqual(['p2', 'tv'])
  })
})

describe('device groups', () => {
  const sim = (name: string, kind: 'phone' | 'tv') => ({ name, kind })
  test('an iPad from the phone list is a tablet; TVs and browsers keep their kind', () => {
    expect(groupOf(sim('iPhone 17 Pro', 'phone'))).toBe('phone')
    expect(groupOf(sim('iPad Pro 13-inch (M5)', 'phone'))).toBe('tablet')
    expect(groupOf(sim('iPad mini (A17 Pro)', 'phone'))).toBe('tablet')
    expect(groupOf(sim('Apple TV 4K (3rd generation)', 'tv'))).toBe('tv')
    expect(groupOf({ name: 'localhost:3000', kind: 'web' })).toBe('web')
  })

  test('a name merely containing ipad is not a tablet', () => {
    expect(groupOf(sim('Notipad test phone', 'phone'))).toBe('phone')
  })

  test('groups come Phones, Tablets, TVs, Web, each keeping its order, empty ones left out', () => {
    const devices = [{ name: 'Apple TV', kind: 'tv' as const }, { name: 'iPad Air', kind: 'phone' as const }, { name: 'iPhone 17', kind: 'phone' as const }, { name: 'iPhone 16e', kind: 'phone' as const }]
    expect(groupDevices(devices).map(({ group, devices: list }) => [group, list.map((device) => device.name)])).toEqual([
      ['phone', ['iPhone 17', 'iPhone 16e']],
      ['tablet', ['iPad Air']],
      ['tv', ['Apple TV']],
    ])
    expect(groupDevices([])).toEqual([])
  })

  test('selection reaches a web device by its id', () => {
    expect(selectDevice([{ udid: 'sim-1' }, { udid: 'web-1' }], 'web-1')).toBe('web-1')
    expect(selectDevice([{ udid: 'sim-1' }], 'web-gone')).toBe('sim-1')
  })
})

describe('stale Device inventory', () => {
  test('says nothing while every read answered', () => {
    expect(staleDeviceNote([])).toBeNull()
  })

  test('names each read that failed and says the last list stays', () => {
    expect(staleDeviceNote(['phones'])).toBe('Could not refresh the phone simulators; showing the last list.')
    expect(staleDeviceNote(['phones', 'tvs', 'asleep'])).toBe('Could not refresh the phone simulators, the TV simulators and the sleeping simulators; showing the last list.')
  })
})

describe('the Device project catalog', () => {
  test('a failed project list read is named with the other stale reads', () => {
    expect(staleDeviceNote(['projects'])).toBe('Could not refresh the project list; showing the last list.')
  })
})
