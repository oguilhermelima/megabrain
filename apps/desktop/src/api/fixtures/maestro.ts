import { CliError, type DesktopApi } from '@/api/adapter'
import type { MaestroFlow, MaestroRun, Simulator, SimulatorKind } from '@/api/schema'

// Maestro and the simulators for the mock adapter: megabrain's worktrees have flows, the others none
// (the Device tab's empty state). A run queues briefly, then prints a step about every second; a flow
// whose path names "login" fails on its third step.

type MaestroApi = Pick<DesktopApi, 'maestroFlows' | 'maestroRuns' | 'maestroNewFlow' | 'maestroRun' | 'maestroStop' | 'simulators' | 'bootSimulator' | 'simClaim' | 'simRelease' | 'simRename' | 'simListBooted' | 'simShutdown' | 'simRestart' | 'simulatorsAsleep' | 'simulatorScreenshot' | 'inputStart' | 'inputStop' | 'inputTap' | 'inputSwipe' | 'inputScroll' | 'inputType' | 'inputKey' | 'inputButton' | 'inputFrame'>

const seedFlows: MaestroFlow[] = [
  { path: '.maestro/smoke.yaml', name: 'Smoke', appId: 'com.megabrain.desktop' },
  { path: '.maestro/onboarding.yaml', name: 'Onboarding', appId: 'com.megabrain.desktop' },
  { path: '.maestro/auth/login.yaml', name: 'Log in', appId: 'com.megabrain.desktop' },
  { path: '.maestro/auth/logout.yaml', name: 'Log out', appId: 'com.megabrain.desktop' },
]

const steps = (flow: string): string[] => [
  'Launch app "com.megabrain.desktop"',
  'Assert that "Welcome" is visible',
  flow.includes('login') ? 'Tap on "Sign in"' : 'Tap on "Continue"',
  'Input text "operator@example.com"',
  `Take screenshot ${flow.split('/').at(-1)?.replace(/\.ya?ml$/, '') ?? 'screen'}`,
  'Assert that "Projects" is visible',
]

/** A phone screen as an SVG data URL, the size of an iPhone's screenshot, so the frame keeps its aspect. */
export function mockScreen(title: string, line: string, hue = 220, overlay = ''): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1206" height="2622" viewBox="0 0 1206 2622"><rect width="1206" height="2622" fill="hsl(${hue} 30% 12%)"/><rect x="0" y="0" width="1206" height="180" fill="hsl(${hue} 30% 16%)"/><text x="80" y="130" font-family="-apple-system,Helvetica" font-size="44" fill="#ddd">9:41</text><text x="80" y="420" font-family="-apple-system,Helvetica" font-size="96" font-weight="700" fill="#fff">${title}</text><text x="80" y="540" font-family="-apple-system,Helvetica" font-size="48" fill="#aab">${line}</text>${[0, 1, 2, 3].map((row) => `<rect x="80" y="${700 + row * 260}" width="1046" height="200" rx="40" fill="hsl(${hue} 25% 20%)"/>`).join('')}<rect x="80" y="2260" width="1046" height="160" rx="80" fill="hsl(${hue} 80% 60%)"/>${overlay}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** An Apple TV home screen, 1920×1080, with the remote's focus on one of eight tiles. */
function mockTvScreen(focus: number, line: string, overlay: string): string {
  const tiles = [0, 1, 2, 3, 4, 5, 6, 7].map((tile) => {
    const x = 160 + (tile % 4) * 410
    const y = 360 + Math.floor(tile / 4) * 300
    const focused = tile === focus
    return `<rect x="${focused ? x - 16 : x}" y="${focused ? y - 10 : y}" width="${focused ? 392 : 360}" height="${focused ? 236 : 216}" rx="24" fill="hsl(${200 + tile * 18} 45% ${focused ? 52 : 28}%)"/>`
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><rect width="1920" height="1080" fill="#0b0d12"/><text x="160" y="220" font-family="-apple-system,Helvetica" font-size="64" font-weight="700" fill="#fff">Apple TV</text><text x="160" y="290" font-family="-apple-system,Helvetica" font-size="32" fill="#8890a0">${line}</text>${tiles.join('')}${overlay}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const escapeXml = (text: string) => text.replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

export function createMockMaestroApi(): MaestroApi {
  const flows = new Map<string, MaestroFlow[]>()
  const runs = new Map<string, MaestroRun[]>()
  const live = new Map<string, () => void>()
  // Booted devices in two projects: one free, one in another megabrain worktree, two in canto's.
  const devices: (Simulator & { kind: SimulatorKind; runtime: string; worktree: string | null; project: string | null })[] = [
    { udid: 'B50AEA46-5013-445E-A3BB-4FB968ED0B13', name: 'iPhone 18 Pro', state: 'Booted', kind: 'phone', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', worktree: null, project: null },
    { udid: 'F9C3EADB-1E0B-499F-A423-EA83499DDF1D', name: 'iPhone 17 Pro', state: 'Shutdown', kind: 'phone', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', worktree: null, project: null },
    { udid: 'B86BFEB1-7A65-4459-980C-1C4104CC6FE2', name: 'iPhone 17e', state: 'Shutdown', kind: 'phone', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', worktree: null, project: null },
    { udid: '110E1BF2-99F9-4475-916E-32FBA7CED248', name: 'iPhone Air', state: 'Booted', kind: 'phone', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5', worktree: '/Users/operator/Workspaces/Worktrees/feat-desktop-panel-columns', project: '/Users/operator/Workspaces/canto' },
    { udid: '7C0D21A4-5B9E-4D1F-9E3A-2F6B8C4A1D05', name: 'Apple TV 4K (3rd generation)', state: 'Booted', kind: 'tv', runtime: 'com.apple.CoreSimulator.SimRuntime.tvOS-27-0', worktree: '/Users/operator/Workspaces/canto', project: '/Users/operator/Workspaces/canto' },
    { udid: '5D2E8C10-3F4A-4B6E-9A7C-1E0F2B3C4D5E', name: 'iPhone 17', state: 'Booted', kind: 'phone', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', worktree: '/Users/operator/Workspaces/Worktrees/fix-player-seek', project: '/Users/operator/Workspaces/canto' },
    { udid: 'E3A9F6B2-0C47-4E8D-B1A5-93D2C7F4E816', name: 'Apple TV', state: 'Shutdown', kind: 'tv', runtime: 'com.apple.CoreSimulator.SimRuntime.tvOS-27-0', worktree: null, project: null },
  ]
  const deviceOf = (udid: string) => {
    const device = devices.find((entry) => entry.udid === udid)
    if (device === undefined) throw new CliError(`no simulator matches ${udid}`, 1)
    return device
  }
  // What the booted phone shows: the last step a run reached.
  let screen = mockScreen('Welcome', 'megabrain on the simulator')
  let face = { title: 'Welcome', line: 'megabrain on the simulator', hue: 220 }
  // What the person's input did: the last action, the last touch and what they typed, per device.
  const touched = new Map<string, { action: string; x: number; y: number; at: number; typed: string; focus: number }>()
  const sessions = new Set<string>()
  const act = async (udid: string, action: string, at?: { x: number; y: number }) => {
    await wait(60)
    if (deviceOf(udid).state !== 'Booted') throw new CliError(`simulator ${udid} is not booted`, 1)
    if (!sessions.has(udid)) throw new CliError(`no input session for ${udid}; start one first`, 1)
    const last = touched.get(udid) ?? { action: '', x: -1, y: -1, at: 0, typed: '', focus: 0 }
    touched.set(udid, { ...last, action, ...(at === undefined ? {} : { ...at, at: Date.now() }) })
    console.info(`[mock input] ${udid.slice(0, 8)} ${action}`)
    return { ok: true, ms: 60 }
  }
  const remoteMoves: Record<string, number> = { left: -1, right: 1, up: -4, down: 4 }
  const flowsOf = (root: string) => {
    if (!flows.has(root)) flows.set(root, root.includes('megabrain') || root.includes('feat-desktop') || root.includes('fix-queue') ? [...seedFlows] : [])
    return flows.get(root) ?? []
  }
  const runsOf = (root: string) => {
    if (!runs.has(root))
      runs.set(
        root,
        flowsOf(root).length === 0
          ? []
          : [
              { runId: 'mock-2', flow: '.maestro/auth/login.yaml', device: devices[0]?.udid ?? '', state: 'failed', startedAt: ago(42), durationMs: 14_200, artifacts: '/tmp/mock' },
              { runId: 'mock-1', flow: '.maestro/smoke.yaml', device: devices[0]?.udid ?? '', state: 'passed', startedAt: ago(60 * 5), durationMs: 38_400, artifacts: '/tmp/mock' },
            ],
      )
    return runs.get(root) ?? []
  }
  const record = (root: string, run: MaestroRun) => runs.set(root, [run, ...runsOf(root).filter((entry) => entry.runId !== run.runId)])

  return {
    maestroFlows: async (root) => {
      await wait(250)
      return flowsOf(root)
    },
    maestroRuns: async (root) => {
      await wait(150)
      return runsOf(root)
    },
    maestroNewFlow: async (root, name) => {
      const path = `.maestro/${name}.yaml`
      if (flowsOf(root).some((flow) => flow.path === path)) throw new CliError(`a flow already exists at ${path}`, 1)
      flows.set(root, [...flowsOf(root), { path, name, appId: 'com.example.app' }])
      return path
    },
    async maestroRun(root, flow, device, onEvent, onEnd) {
      if (devices.find((entry) => entry.udid === device)?.state !== 'Booted') {
        setTimeout(() => onEnd(`no booted iOS simulator is named ${device}; boot it first or pass its udid`), 300)
        return () => {}
      }
      const runId = `mock-${Date.now()}`
      const startedAt = new Date().toISOString()
      const started = Date.now()
      const commands = steps(flow)
      const failAt = flow.includes('login') ? 3 : null
      let cancelled = false
      let index = 0
      const timers: ReturnType<typeof setTimeout>[] = []
      const finish = (state: 'passed' | 'failed' | 'stopped') => {
        const durationMs = Date.now() - started
        record(root, { runId, flow, device, state, startedAt, finishedAt: new Date().toISOString(), durationMs, artifacts: '/tmp/mock' })
        live.delete(root)
        onEvent({ type: 'run', state, runId, flow, device, exitCode: state === 'passed' ? 0 : 1, durationMs, artifacts: '/tmp/mock' })
        onEnd(null)
      }
      const next = () => {
        if (cancelled) return
        index += 1
        const command = commands[index - 1] ?? ''
        if (index === failAt) {
          face = { title: 'Sign in', line: 'The button is missing', hue: 0 }
          screen = mockScreen(face.title, face.line, face.hue)
          onEvent({ type: 'step', index, command, status: 'failed', durationMs: 2_400, screenshot: screen, error: 'Element not found: Text matching regex: Sign in\n\nThe element was not visible within 7000 ms.' })
          timers.push(setTimeout(() => finish('failed'), 400))
          return
        }
        face = { title: index < 3 ? 'Welcome' : 'Projects', line: command, hue: 220 + index * 12 }
        screen = mockScreen(face.title, face.line, face.hue)
        onEvent({ type: 'step', index, command, status: 'passed', durationMs: 600 + index * 130, screenshot: command.startsWith('Take screenshot') ? screen : null, error: null })
        if (index === commands.length) timers.push(setTimeout(() => finish('passed'), 300))
        else timers.push(setTimeout(next, 1100))
      }
      // Queued for a moment (admission and the device check), then the start line.
      timers.push(
        setTimeout(() => {
          if (cancelled) return
          record(root, { runId, flow, device, state: 'running', startedAt, durationMs: null, artifacts: '/tmp/mock' })
          onEvent({ type: 'start', runId, flow, device, artifacts: '/tmp/mock' })
          timers.push(setTimeout(next, 900))
        }, 900),
      )
      live.set(root, () => {
        for (const timer of timers) clearTimeout(timer)
        if (!cancelled && index > 0) finish('stopped')
        cancelled = true
      })
      return () => {
        cancelled = true
        for (const timer of timers) clearTimeout(timer)
      }
    },
    maestroStop: async (root) => {
      const stop = live.get(root)
      if (stop === undefined) throw new CliError('no running maestro run for this worktree', 1)
      stop()
    },
    simulators: async (kind = 'phone') => {
      await wait(200)
      return devices.filter((device) => device.kind === kind).map(({ udid, name, state }) => ({ udid, name, state }))
    },
    bootSimulator: async (udid, _kind, worktree) => {
      await wait(1500)
      const device = deviceOf(udid)
      device.state = 'Booted'
      if (worktree !== undefined) device.worktree = worktree
    },
    simClaim: async (udid, worktree) => {
      await wait(150)
      const device = deviceOf(udid)
      if (device.state !== 'Booted') throw new CliError(`simulator ${udid} must be booted before it can be claimed`, 1)
      device.worktree = worktree
    },
    simRelease: async (udid) => {
      await wait(150)
      deviceOf(udid).worktree = null
    },
    simRename: async (udid, name) => {
      await wait(250)
      if (name.trim() === '' || [...name].length > 64) throw new CliError('simulator name must be 1 to 64 characters', 2)
      deviceOf(udid).name = name
    },
    simListBooted: async () => {
      await wait(150)
      return devices.filter((device) => device.state === 'Booted').map(({ udid, name, runtime, state, kind, worktree, project }) => ({ udid, name, runtime, state, kind, worktree, project }))
    },
    simShutdown: async (udid) => {
      await wait(700)
      const device = deviceOf(udid)
      device.state = 'Shutdown'
      device.worktree = null
    },
    simRestart: async (udid) => {
      const device = deviceOf(udid)
      device.state = 'Shutdown'
      await wait(1800)
      device.state = 'Booted'
    },
    simulatorsAsleep: async () => [],
    simulatorScreenshot: async (udid) => {
      await wait(120)
      if (devices.find((entry) => entry.udid === udid)?.state !== 'Booted') throw new CliError(`could not capture simulator ${udid}; is it booted?`, 1)
      return screen
    },
    inputStart: async (udid) => {
      await wait(400)
      if (deviceOf(udid).state !== 'Booted') throw new CliError(`simulator ${udid} must be booted to take input`, 1)
      sessions.add(udid)
      return { udid, session: `mock-session-${udid.slice(0, 8)}`, port: 8100 }
    },
    inputStop: async (udid) => {
      sessions.delete(udid)
    },
    inputTap: (udid, x, y) => act(udid, `tap ${x},${y}`, { x, y }),
    inputSwipe: (udid, x1, y1, x2, y2, durationMs) => act(udid, `swipe ${x1},${y1} to ${x2},${y2} in ${durationMs} ms`, { x: x2, y: y2 }),
    inputScroll: (udid, x, y, dx, dy) => act(udid, `scroll ${dx},${dy} at ${x},${y}`),
    inputType: async (udid, text) => {
      const done = await act(udid, `type "${text}"`)
      const last = touched.get(udid)
      if (last !== undefined) touched.set(udid, { ...last, typed: (last.typed + text).slice(-28) })
      return done
    },
    inputKey: async (udid, name) => {
      const done = await act(udid, `key ${name}`)
      const last = touched.get(udid)
      if (last !== undefined && name === 'delete') touched.set(udid, { ...last, typed: last.typed.slice(0, -1) })
      return done
    },
    inputButton: async (udid, name) => {
      const done = await act(udid, `button ${name}`)
      const last = touched.get(udid)
      const move = remoteMoves[name]
      if (last !== undefined && move !== undefined) touched.set(udid, { ...last, focus: (last.focus + move + 8) % 8 })
      return done
    },
    inputFrame: async (udid) => {
      await wait(40)
      const device = deviceOf(udid)
      if (device.state !== 'Booted') throw new CliError(`could not capture simulator ${udid}; is it booted?`, 1)
      const last = touched.get(udid)
      const now = Date.now()
      const clock = new Date(now).toLocaleTimeString('en-GB')
      if (device.kind === 'tv') {
        const overlay = `<rect x="${160 + ((now / 20) % 1600)}" y="1000" width="160" height="6" rx="3" fill="#4f7cff"/><text x="1760" y="120" text-anchor="end" font-family="-apple-system,Helvetica" font-size="36" fill="#aab">${clock}</text>`
        return { image: mockTvScreen(last?.focus ?? 0, escapeXml(last?.action ?? 'Use the remote to move the focus'), overlay), width: 1920, height: 1080, scale: 1, ms: 40 }
      }
      const fresh = last !== undefined && last.x >= 0 && now - last.at < 700
      const overlay = [
        `<rect x="${80 + ((now / 4) % 900)}" y="190" width="140" height="10" rx="5" fill="hsl(${face.hue} 80% 60%)"/>`,
        `<text x="1126" y="130" text-anchor="end" font-family="-apple-system,Helvetica" font-size="44" fill="#ddd">${clock}</text>`,
        last === undefined ? '' : `<text x="140" y="815" font-family="-apple-system,Helvetica" font-size="56" fill="#fff">${escapeXml(last.typed === '' ? last.action : last.typed)}</text>`,
        fresh ? `<circle cx="${last.x * 3}" cy="${last.y * 3}" r="70" fill="none" stroke="#fff" stroke-width="8" opacity="0.7"/>` : '',
      ].join('')
      return { image: mockScreen(face.title, face.line, face.hue, overlay), width: 1206, height: 2622, scale: 3, ms: 40 }
    },
  }
}
