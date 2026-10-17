import { CliError, type DesktopApi } from '@/api/adapter'
import type { MaestroFlow, MaestroRun, Simulator } from '@/api/schema'

// Maestro and the simulators for the mock adapter: megabrain's worktrees have flows, the others none
// (the Device tab's empty state). A run queues briefly, then prints a step about every second; a flow
// whose path names "login" fails on its third step.

type MaestroApi = Pick<DesktopApi, 'maestroFlows' | 'maestroRuns' | 'maestroNewFlow' | 'maestroRun' | 'maestroStop' | 'simulators' | 'bootSimulator' | 'simulatorsAsleep' | 'simulatorScreenshot'>

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
export function mockScreen(title: string, line: string, hue = 220): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1206" height="2622" viewBox="0 0 1206 2622"><rect width="1206" height="2622" fill="hsl(${hue} 30% 12%)"/><rect x="0" y="0" width="1206" height="180" fill="hsl(${hue} 30% 16%)"/><text x="80" y="130" font-family="-apple-system,Helvetica" font-size="44" fill="#ddd">9:41</text><text x="80" y="420" font-family="-apple-system,Helvetica" font-size="96" font-weight="700" fill="#fff">${title}</text><text x="80" y="540" font-family="-apple-system,Helvetica" font-size="48" fill="#aab">${line}</text>${[0, 1, 2, 3].map((row) => `<rect x="80" y="${700 + row * 260}" width="1046" height="200" rx="40" fill="hsl(${hue} 25% 20%)"/>`).join('')}<rect x="80" y="2260" width="1046" height="160" rx="80" fill="hsl(${hue} 80% 60%)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

export function createMockMaestroApi(): MaestroApi {
  const flows = new Map<string, MaestroFlow[]>()
  const runs = new Map<string, MaestroRun[]>()
  const live = new Map<string, () => void>()
  const devices: Simulator[] = [
    { udid: 'B50AEA46-5013-445E-A3BB-4FB968ED0B13', name: 'iPhone 18 Pro', state: 'Booted' },
    { udid: 'F9C3EADB-1E0B-499F-A423-EA83499DDF1D', name: 'iPhone 17 Pro', state: 'Shutdown' },
    { udid: 'B86BFEB1-7A65-4459-980C-1C4104CC6FE2', name: 'iPhone 17e', state: 'Shutdown' },
  ]
  // What the booted phone shows: the last step a run reached.
  let screen = mockScreen('Welcome', 'megabrain on the simulator')
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
          screen = mockScreen('Sign in', 'The button is missing', 0)
          onEvent({ type: 'step', index, command, status: 'failed', durationMs: 2_400, screenshot: screen, error: 'Element not found: Text matching regex: Sign in\n\nThe element was not visible within 7000 ms.' })
          timers.push(setTimeout(() => finish('failed'), 400))
          return
        }
        screen = mockScreen(index < 3 ? 'Welcome' : 'Projects', command, 220 + index * 12)
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
    simulators: async () => {
      await wait(200)
      return devices.map((device) => ({ ...device }))
    },
    bootSimulator: async (udid) => {
      await wait(1500)
      const device = devices.find((entry) => entry.udid === udid)
      if (device === undefined) throw new CliError(`no iPhone simulator matches ${udid}`, 1)
      device.state = 'Booted'
    },
    simulatorsAsleep: async () => [],
    simulatorScreenshot: async (udid) => {
      await wait(120)
      if (devices.find((entry) => entry.udid === udid)?.state !== 'Booted') throw new CliError(`could not capture simulator ${udid}; is it booted?`, 1)
      return screen
    },
  }
}
