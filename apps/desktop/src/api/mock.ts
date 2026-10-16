import { answerMockApproval, followMockChat, interruptMockChat, mockNativeChat, sendMockChat } from '@/api/fixtures/chat'
import { CliError, type DesktopApi, type PathLink } from '@/api/adapter'
import { sessionsOfOrigin } from '@/api/projects-origin'
import type { GithubDetail, Project, ProjectScripts } from '@/api/schema'
import { mockSettings, mockGithubDetail, mockPullRequestFiles, mockGithubIssues, mockGithubPullRequests, mockGithubRepositories, mockPage, mockImported, mockProjects, mockChatRead, mockCodeChanges, mockCodeDiff, mockCodeFiles, mockCodeTree, mockDoctor, mockInstallPlan, mockInstallRun, mockStatus, mockTranscript, mockWorktrees, mockDispatchReport, mockSessionHistory } from '@/api/fixtures/mock'

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
  let sidebarFolders: unknown = { version: 1, folders: [], order: [] }
  // What the GitHub writes changed: added comments and new states, by kind and number.
  const githubComments = new Map<string, GithubDetail['comments']>()
  const githubStates = new Map<string, string>()
  const githubComment = (kind: 'pr' | 'issue', number: number, body: string) => {
    const key = `${kind}:${number}`
    const added = { author: { login: 'operator', name: 'Operator', isBot: false }, body, createdAt: new Date().toISOString(), url: `https://github.com/operator/megabrain/issues/${number}#mock-${Date.now()}` }
    githubComments.set(key, [...(githubComments.get(key) ?? []), added])
  }
  const githubEdited = (kind: 'pr' | 'issue', detail: GithubDetail): GithubDetail => {
    const key = `${kind}:${detail.number}`
    return { ...detail, state: githubStates.get(key) ?? detail.state, comments: [...detail.comments, ...(githubComments.get(key) ?? [])] }
  }
  // Sessions released from megabrain's tmux server (`session release`).
  const released = new Set<string>()
  const withOwnership = (projects: Project[]): Project[] =>
    projects.map((project) => ({
      ...project,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        sessions: worktree.sessions.map((session) => (released.has(session.sessionId) ? { ...session, owner: 'external' as const, tmuxServer: null, tmuxSession: null } : session)),
      })),
    }))
  const ownedSession = (sessionId: string) =>
    withOwnership(mockProjects).some((project) => project.worktrees.some((worktree) => worktree.sessions.some((session) => session.sessionId === sessionId && session.owner === 'megabrain')))
  // Saved commands per repository; anything unsaved falls back to what a package.json would give.
  const savedScripts = new Map<string, Partial<Record<'run' | 'build' | 'install', string>>>()
  const detectedScripts = { run: 'bun run dev', build: 'bun run build', install: null }
  const scriptsFor = (root: string): ProjectScripts => {
    const repo = mockProjects.find((project) => project.path === root || project.worktrees.some((worktree) => worktree.path === root))?.path ?? root
    const saved = savedScripts.get(repo) ?? {}
    const pick = (name: 'run' | 'build' | 'install') => {
      const command = saved[name]
      if (command !== undefined) return { command, source: 'saved' as const }
      const detected = detectedScripts[name]
      return detected === null ? null : { command: detected, source: 'detected' as const }
    }
    return { repo, scripts: { run: pick('run'), build: pick('build'), install: pick('install') } }
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
    readDispatchMessage: async () => {
      await wait(200)
      return mockDispatchReport
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
    setHidden: async () => {},
    removeProject: async () => {},
    removeWorktree: async () => {},
    stackShow: async (repo, branch) => {
      await wait(400)
      const worktrees = mockProjects.find((project) => project.path === repo)?.worktrees ?? []
      const byBranch = new Map(worktrees.flatMap((worktree) => (worktree.branch === null ? [] : [[worktree.branch, worktree] as const])))
      const line: string[] = []
      for (let current = byBranch.get(branch); current !== undefined && current.branch !== null && !current.primary && !line.includes(current.branch); current = current.parent === null ? undefined : byBranch.get(current.parent)) line.unshift(current.branch)
      // The preview's tip is two commits behind its parent, with its checks failing.
      return {
        branches: line.map((name, index) => ({
          branch: name,
          behindParent: index === line.length - 1 && index > 0 ? 2 : 0,
          pullRequest: byBranch.get(name)?.pullRequest === null ? null : { number: byBranch.get(name)?.pullRequest?.number ?? 0, reviewDecision: index === 0 ? 'APPROVED' : null, statusCheckRollup: [{ conclusion: index === line.length - 1 && index > 0 ? 'FAILURE' : 'SUCCESS' }] },
        })),
      }
    },
    stackRun: async () => {
      await wait(1200)
    },
    slashCommands: async (agent) =>
      agent === 'codex'
        ? [{ name: 'model', description: 'Choose the model and reasoning effort', source: 'builtin' }, { name: 'review', description: 'Review my current changes', source: 'builtin' }, { name: 'ship', description: 'Ship the current branch', source: 'user', argumentHint: '[pr]' }]
        : [{ name: 'compact', description: 'Clear history but keep a summary in context', source: 'builtin', argumentHint: '[instructions]' }, { name: 'model', description: 'Set the AI model', source: 'builtin' }, { name: 'review', description: 'Review a pull request', source: 'builtin' }, { name: 'megabrain', description: 'Delegate work to other coding agents', source: 'skill' }, { name: 'deploy', description: 'Deploy this project', source: 'project', argumentHint: '<env>' }],
    queued: async (dispatchId) => [{ id: 'delivery-mock-1', dispatch: dispatchId, type: 'reply', createdAt: new Date().toISOString(), state: 'outstanding', text: 'Use the new scrubber, and keep the old bar behind a flag.' }],
    unqueue: async () => 'Use the new scrubber, and keep the old bar behind a flag.',
    saveAttachment: async (_base64, extension) => `/Users/operator/.megabrain/attachments/mock.${extension}`,
    sendToSession: async (sessionId) => ({ delivered: true, channel: ownedSession(sessionId) ? 'tmux' : 'claude-peer' }),
    releaseSession: async (sessionId) => void released.add(sessionId),
    openCodeServer: async (root) => ({ root, url: 'about:blank', port: 0, pid: 0 }),
    stopCodeServer: async () => {},
    openInCode: async (root) => ({ root, url: 'about:blank', port: 0, pid: 0 }),
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
    projects: async (origin) => sessionsOfOrigin(withOwnership(mockProjects), origin),
    projectScripts: async (root) => scriptsFor(root),
    portWho: async (port) => ({ port, listeners: [] }),
    portFree: async (from) => from,
    portKill: async () => {},
    async setProjectScripts(root, scripts) {
      const repo = scriptsFor(root).repo
      const saved = { ...savedScripts.get(repo) }
      for (const [name, command] of Object.entries(scripts) as ['run' | 'build' | 'install', string][]) {
        if (command === '') delete saved[name]
        else saved[name] = command
      }
      savedScripts.set(repo, saved)
      return scriptsFor(root)
    },
    importFolder: async (path) => mockImported(path, null),
    importClone: async (url, into) => mockImported(`${into}/${url.split('/').at(-1) ?? 'repo'}`, url),
    githubRepositories: async () => mockGithubRepositories,
    githubPullRequests: async (_root, state, limit, after) => {
      await wait(450)
      return { ...mockGithubPullRequests, ...mockPage(mockGithubPullRequests.items, state, limit, after) }
    },
    githubIssues: async (_root, state, limit, after) => {
      await wait(400)
      return { ...mockGithubIssues, ...mockPage(mockGithubIssues.items, state, limit, after) }
    },
    githubPullRequest: async (_root, number) => {
      await wait(300)
      return githubEdited('pr', mockGithubDetail('pr', number))
    },
    githubIssue: async (_root, number) => {
      await wait(300)
      return githubEdited('issue', mockGithubDetail('issue', number))
    },
    prFiles: async (_root, number) => {
      await wait(350)
      return mockPullRequestFiles(number)
    },
    submitReview: async (_root, number, review) => {
      await wait(500)
      if (number === 109) throw new CliError('gh: Can not approve your own pull request (HTTP 422)', 1)
      const comments = review.comments ?? []
      const verdict = review.event === 'approve' ? 'Approved' : review.event === 'request-changes' ? 'Requested changes' : 'Reviewed'
      const lines = comments.map((comment) => `- ${comment.path}:${comment.line} — ${comment.body}`)
      githubComment('pr', number, [`**${verdict}**`, review.body, ...lines].filter((line) => line !== '').join('\n\n'))
    },
    addComment: async (_root, number, body) => {
      await wait(400)
      // A number is a pull request or an issue; GitHub shares one sequence between them.
      githubComment(mockGithubPullRequests.items.some((item) => item.number === number) ? 'pr' : 'issue', number, body)
    },
    setIssueState: async (_root, number, state) => {
      await wait(400)
      githubStates.set(`issue:${number}`, state)
    },
    setPrState: async (_root, number, action) => {
      await wait(600)
      if (action === 'merge' && number === 111) throw new CliError('gh: Pull request is not mergeable: the base branch policy prohibits the merge.', 1)
      githubStates.set(`pr:${number}`, action === 'merge' ? 'merged' : action === 'close' ? 'closed' : 'open')
    },
    pickFolder: async () => '/Users/operator/Workspaces/new-project',
    codeTree: async () => mockCodeTree,
    codeRead: async (_root, path) => {
      const text = mockCodeFiles[path]
      return { path, text: text ?? `// ${path}`, binary: false, tooLarge: false }
    },
    codeChanges: async () => mockCodeChanges,
    codeDiff: async (_root, path) => ({ ...mockCodeDiff, path }),
    chats: async () => [mockNativeChat],
    startChat: async ({ agent, model, cwd }) => ({ ...mockNativeChat, id: `chat-${Date.now()}`, agent, model: model ?? null, cwd, title: null, state: 'starting' }),
    sendChat: async (chatId, parts) => {
      await wait(250)
      sendMockChat(chatId, parts)
    },
    interruptChat: async (chatId) => interruptMockChat(chatId),
    answerApproval: async (chatId, _approvalId, decision) => answerMockApproval(chatId, decision),
    stopChat: async () => {},
    removeChat: async () => {},
    setChatModel: async () => {},
    setChatMode: async (chatId, mode) => ({
      chat: { ...mockNativeChat, id: chatId, mode },
      terminal: mode === 'terminal' ? { id: 'term-mock', engine: 'native', cwd: mockNativeChat.cwd, title: 'claude', tmuxSession: null } : null,
      command: mode === 'terminal' ? ['claude', '--resume', mockNativeChat.agentSessionId ?? ''] : null,
    }),
    chatTerminalCommand: async () => ['claude', '--resume', mockNativeChat.agentSessionId ?? ''],
    agentCommand: async (agent, options = {}) => {
      if (!mockInstallPlan.agents.some((entry) => entry.agent === agent && entry.installed)) throw new CliError(`${agent} is not installed`, 1)
      const resume = options.resume === undefined ? [] : agent === 'codex' ? ['resume', options.resume] : ['--resume', options.resume]
      return [agent, ...resume, ...(options.model === undefined ? [] : ['--model', options.model]), ...(options.effort === undefined ? [] : ['--effort', options.effort])]
    },
    sessionHistory: async (_cwd, agent) => {
      await wait(500)
      return mockSessionHistory.filter((session) => agent === undefined || session.agent === agent)
    },
    followChat: async (chatId, since, onLine) => followMockChat(chatId, since, onLine),
    openTerminal: async ({ engine, cwd, tmuxSession }) => ({ id: `term-${Date.now()}`, engine, cwd, title: 'zsh', tmuxSession: tmuxSession ?? null }),
    writeTerminal: async () => {},
    resizeTerminal: async () => {},
    closeTerminal: async () => {},
    listAppTerminals: async () => [],
    onTerminalData: async (_terminalId, onData) => {
      onData(btoa('mock terminal\r\n$ '))
      return () => {}
    },
    setTerminalEngine: async () => {},
    sidebarFolders: async () => sidebarFolders,
    setSidebarFolders: async (json) => void (sidebarFolders = JSON.parse(json) as unknown),
  }
}
