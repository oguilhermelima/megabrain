import type { DesktopApi, PathLink } from '@/api/adapter'
import { mockSettings, mockGithubRepositories, mockImported, mockProjects, mockChatRead, mockCodeChanges, mockCodeDiff, mockCodeFiles, mockCodeTree, mockDoctor, mockInstallPlan, mockInstallRun, mockStatus, mockTranscript, mockWorktrees } from '@/api/fixtures/mock'

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
  let settings = mockSettings
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
    transcript: async (target) => ({ ...mockTranscript, dispatchId: 'dispatchId' in target ? target.dispatchId : null, sessionId: 'sessionId' in target ? target.sessionId : mockTranscript.sessionId }),
    settings: async () => settings,
    setPolicy: async (policy) => {
      settings = { ...settings, resources: { ...settings.resources, policy: policy === null ? null : { maxAgents: policy.maxAgents ?? null, minAvailableMib: policy.minAvailableMib ?? null, maxPressure: policy.maxPressure ?? null, maxContainerSuites: policy.maxContainerSuites ?? null } } }
    },
    setResourceHistory: async (enabled) => void (settings = { ...settings, resources: { ...settings.resources, historyEnabled: enabled } }),
    setSupervisor: async (running) => void (settings = { ...settings, supervisor: { running, pid: running ? 21194 : null } }),
    setLimitNotice: async (enabled, intervalSeconds) => void (settings = { ...settings, limits: { ...settings.limits, notice: { enabled, intervalSeconds: intervalSeconds ?? settings.limits.notice.intervalSeconds } } }),
    setLimitProvider: async (provider, enabled) =>
      void (settings = { ...settings, limits: { ...settings.limits, enabledProviders: enabled ? [...new Set([...settings.limits.enabledProviders, provider])] : settings.limits.enabledProviders.filter((item) => item !== provider) } }),
    saveChain: async (chain) => void (settings = { ...settings, chains: [...settings.chains.filter((item) => item.name !== chain.name), chain] }),
    deleteChain: async (name) => void (settings = { ...settings, chains: settings.chains.filter((item) => item.name !== name) }),
    refreshModels: async () => {},
    setTerminalDefault: async (name) => void (settings = { ...settings, terminal: { ...settings.terminal, default: name } }),
    projects: async () => mockProjects,
    importFolder: async (path) => mockImported(path, null),
    importClone: async (url, into) => mockImported(`${into}/${url.split('/').at(-1) ?? 'repo'}`, url),
    githubRepositories: async () => mockGithubRepositories,
    pickFolder: async () => '/Users/operator/Workspaces/new-project',
    codeTree: async () => mockCodeTree,
    codeRead: async (_root, path) => {
      const text = mockCodeFiles[path]
      return { path, text: text ?? `// ${path}`, binary: false, tooLarge: false }
    },
    codeChanges: async () => mockCodeChanges,
    codeDiff: async (_root, path) => ({ ...mockCodeDiff, path }),
  }
}
