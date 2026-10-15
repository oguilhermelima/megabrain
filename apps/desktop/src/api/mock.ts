import type { DesktopApi, PathLink } from '@/api/adapter'
import { mockChatRead, mockDoctor, mockInstallPlan, mockInstallRun, mockStatus, mockWorktrees } from '@/api/fixtures/mock'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const pillListeners = new Set<(expanded: boolean) => void>()

// Runs the UI in a plain browser (`bun run dev`) with fixed data and believable timing.
export function createMockApi(): DesktopApi {
  let link: PathLink = {
    linkPath: '/Users/operator/.local/bin/megabrain',
    kind: 'other-link',
    pointsTo: '/Users/operator/Workspaces/megabrain/.build/megabrain',
    bundled: '/Applications/megabrain.app/Contents/MacOS/megabrain-cli',
    dirOnPath: true,
    resolvesTo: '/Users/operator/Workspaces/megabrain/.build/megabrain',
  }
  return {
    kind: 'mock',
    status: async () => {
      await wait(120)
      return { ...mockStatus, generatedAt: new Date().toISOString() }
    },
    installPlan: async () => {
      await wait(300)
      return mockInstallPlan
    },
    doctor: async () => {
      await wait(600)
      return mockDoctor
    },
    async install(_args, onEvent) {
      for (const event of mockInstallRun) {
        await wait(event.type === 'step' && event.state === 'start' ? 700 : 150)
        onEvent(event)
      }
      return { code: 1, stderr: '' }
    },
    installModule: async (args) => {
      await wait(900)
      return { module: args[1] ?? '', action: 'install', ok: true, message: `${args[1]} is set up` }
    },
    pathLink: async () => link,
    linkCli: async (replace) => {
      if (link.kind === 'other-link' && !replace) throw new Error(`${link.linkPath} already points to ${link.pointsTo}; choose to replace it`)
      link = { ...link, kind: 'ours', pointsTo: link.bundled, resolvesTo: link.bundled }
      return link
    },
    setTraySummary: async () => {},
    windowVisible: async () => document.visibilityState === 'visible',
    worktrees: async () => mockWorktrees,
    readChat: async (dispatchId) => ({ ...mockChatRead, dispatchId }),
    reply: async (dispatchId) => {
      await wait(300)
      return { dispatchId, status: 'queued', nudge: 'typed' }
    },
    pillGeometry: async () => ({ notchWidth: 200, barHeight: 37 }),
    setPillExpanded: async (expanded) => {
      for (const listener of pillListeners) listener(expanded)
    },
    onPillExpanded(listener) {
      pillListeners.add(listener)
      return () => pillListeners.delete(listener)
    },
    openMain: async () => {},
  }
}
