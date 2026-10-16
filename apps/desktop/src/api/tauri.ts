import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { z } from 'zod'
import { projectsArgs } from '@/api/projects-origin'
import { CliError, type DesktopApi, type InstallExit, type PathLink, type PillGeometry } from '@/api/adapter'
import { agentCommandSchema, sessionHistorySchema, chatEventLineSchema, nativeChatSchema, terminalSessionSchema, githubDetailSchema, githubIssueListSchema, githubPullRequestListSchema, queuedMessageSchema, slashCommandSchema, codeServerSchema, sendResultSchema, settingsSchema, githubRepositorySchema, projectScriptsSchema, projectsSchema, repositorySchema, chatReadSchema, codeChangeSchema, codeDiffSchema, codeEntrySchema, codeFileSchema, dispatchMessagesSchema, doctorReportSchema, transcriptSchema, installEventSchema, installPlanSchema, moduleResultSchema, replyResultSchema, statusSchema, worktreeListSchema } from '@/api/schema'

interface CliOutput {
  code: number | null
  stdout: string
  stderr: string
}

const firstLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

// Some verbs report a problem through their exit code and still print the JSON (doctor exits 1 when a
// module is unhealthy), so the JSON wins whenever there is some.
async function cliJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const output = await invoke<CliOutput>('run_cli', { args })
  if (output.stdout.trim() === '') throw new CliError(firstLine(output.stderr) || `megabrain ${args[0]} exited ${output.code}`, output.code)
  const parsed = schema.safeParse(JSON.parse(output.stdout))
  if (!parsed.success) throw new CliError(`megabrain ${args.join(' ')} answered in an unexpected shape: ${parsed.error.message}`, output.code)
  return parsed.data
}

// A write verb: success is exit 0; its output is not parsed.
async function cliText(args: string[]): Promise<string> {
  const output = await invoke<CliOutput>('run_cli', { args })
  if (output.code !== 0) throw new CliError(firstLine(output.stderr) || firstLine(output.stdout) || `megabrain ${args[0]} exited ${output.code}`, output.code)
  return output.stdout
}

// A long-lived CLI process whose stdout lines arrive as they are printed (native command
// cli_stream, owned by src-tauri); the returned function kills it.
async function cliStream(args: string[], onLine: (line: string) => void): Promise<() => void> {
  const channel = new Channel<string>()
  channel.onmessage = onLine
  const streamId = await invoke<string>('cli_stream', { args, onLine: channel })
  return () => void invoke('cli_stream_stop', { streamId })
}

const appTerminalSchema = z.looseObject({ id: z.string(), sessionName: z.string(), cwd: z.string(), title: z.string(), command: z.string(), alive: z.boolean(), createdAt: z.string() })

// Terminal bytes come base64 over a channel; exit arrives once with the code.
async function terminalListen(terminalId: string, onData: (base64: string) => void, onExit: (code: number | null) => void): Promise<() => void> {
  const channel = new Channel<{ data?: string; exit?: number | null }>()
  channel.onmessage = (message) => {
    if (message.data !== undefined) onData(message.data)
    if ('exit' in message) onExit(message.exit ?? null)
  }
  await invoke('terminal_listen', { terminalId, onEvent: channel })
  return () => void invoke('terminal_unlisten', { terminalId })
}

let streams = 0

export function createTauriApi(): DesktopApi {
  return {
    kind: 'tauri',
    status: () => cliJson(['status', '--json'], statusSchema),
    installPlan: () => cliJson(['install', '--plan', '--json'], installPlanSchema),
    doctor: () => cliJson(['doctor', '--json'], doctorReportSchema),
    installModule: (args) => cliJson(args, moduleResultSchema),
    async install(args, onEvent) {
      const id = `install-${++streams}`
      const unlisten = await listen<{ id: string; line: string }>('cli-line', ({ payload }) => {
        if (payload.id !== id || payload.line.trim() === '') return
        try {
          const parsed = installEventSchema.safeParse(JSON.parse(payload.line))
          onEvent(parsed.success ? parsed.data : { type: 'warn', message: payload.line })
        } catch {
          onEvent({ type: 'warn', message: payload.line })
        }
      })
      try {
        const output = await invoke<CliOutput>('stream_cli', { id, args })
        return { code: output.code, stderr: output.stderr } satisfies InstallExit
      } finally {
        unlisten()
      }
    },
    pathLink: () => invoke<PathLink>('path_link_state'),
    linkCli: (replace) => invoke<PathLink>('link_cli', { replace }),
    setTraySummary: (findings, lines) => invoke('set_tray_summary', { findings, lines }),
    windowVisible: () => getCurrentWindow().isVisible(),
    worktrees: () => cliJson(['worktree', 'list', '--json'], worktreeListSchema),
    readChat: (dispatchId, lines) => cliJson(['orchestrate', 'read', dispatchId, '--lines', String(lines), '--operator', '--json'], chatReadSchema),
    reply: (dispatchId, text) => cliJson(['orchestrate', 'reply', dispatchId, '--text', text, '--operator', '--json'], replyResultSchema),
    readDispatchMessage: async (dispatchId) => {
      const record = await cliJson(['db', 'show', dispatchId, '--json'], dispatchMessagesSchema)
      return record.messages.filter((message) => message.from === 'child').at(-1)?.text ?? null
    },
    pillGeometry: () => invoke<PillGeometry>('pill_geometry'),
    setPillExpanded: (expanded) => invoke('set_pill_expanded', { expanded }),
    onPillExpanded(listener) {
      let stop: (() => void) | undefined
      let cancelled = false
      void listen<boolean>('pill-expanded', ({ payload }) => listener(payload)).then((unlisten) => {
        if (cancelled) unlisten()
        else stop = unlisten
      })
      return () => {
        cancelled = true
        stop?.()
      }
    },
    openMain: () => invoke('open_main'),
    transcript: (target, since) =>
      cliJson(
        ['orchestrate', 'transcript', ...('dispatchId' in target ? [target.dispatchId] : ['--session', target.sessionId]), ...(since === undefined ? [] : ['--since', since]), '--operator', '--json'],
        transcriptSchema,
      ),
    setHidden: async (target, hidden) =>
      void (await cliText('project' in target ? ['repo', hidden ? 'hide' : 'unhide', target.project] : ['worktree', hidden ? 'hide' : 'unhide', target.worktree])),
    removeProject: async (path) => void (await cliText(['repo', 'remove', path])),
    removeWorktree: async (path) => void (await cliText(['worktree', 'finish', path, '--delete-branch'])),
    slashCommands: (agent, cwd) => cliJson(['commands', '--agent', agent, '--cwd', cwd, '--json'], slashCommandSchema.array()),
    queued: (dispatchId) => cliJson(['orchestrate', 'queue', dispatchId, '--operator', '--json'], queuedMessageSchema.array()),
    unqueue: async (itemId) => {
      const result = await cliJson(['orchestrate', 'queue', 'cancel', itemId, '--operator', '--json'], queuedMessageSchema)
      return result.text
    },
    saveAttachment: (base64, extension) => invoke<string>('save_attachment', { base64, extension }),
    sendToSession: (sessionId, text) => cliJson(['send', '--session', sessionId, '--text', text, '--operator', '--json'], sendResultSchema),
    releaseSession: async (sessionId) => void (await cliText(['session', 'release', sessionId, '--json'])),
    openCodeServer: (root) => cliJson(['code', 'open', root, '--json'], codeServerSchema),
    stopCodeServer: async (root) => void (await cliText(['code', 'stop', root])),
    openInCode: (root, path, line) =>
      cliJson(['code', 'goto', root, path, ...(line === undefined ? [] : ['--line', String(line)]), '--json'], codeServerSchema),
    settings: () => cliJson(['settings', '--json'], settingsSchema),
    setPolicy: async (policy) => {
      if (policy === null) return void (await cliText(['resources', 'policy', 'off']))
      const args = ['resources', 'policy', 'set']
      if (policy.maxAgents !== undefined) args.push('--max-agents', String(policy.maxAgents))
      if (policy.minAvailableMib !== undefined) args.push('--min-available-mib', String(policy.minAvailableMib))
      if (policy.maxPressure !== undefined) args.push('--max-pressure', policy.maxPressure)
      if (policy.maxContainerSuites !== undefined) args.push('--max-container-suites', String(policy.maxContainerSuites))
      await cliText(args)
    },
    setResourceHistory: async (enabled) => void (await cliText(['resources', enabled ? 'enable' : 'disable'])),
    setSupervisor: async (running) => void (await cliText(running ? ['supervise'] : ['supervise', '--stop'])),
    setLimitNotice: async (enabled, intervalSeconds) =>
      void (await cliText(['chain', 'limits', enabled ? '--notice-on' : '--notice-off', ...(intervalSeconds === undefined ? [] : ['--notice-interval', String(intervalSeconds)])])),
    setLimitProvider: async (provider, enabled) => void (await cliText(['chain', 'limits', enabled ? '--enable' : '--disable', provider])),
    saveChain: async (chain) => void (await cliText(['chain', 'save', chain.name, '--when', JSON.stringify(chain.when), '--steps', JSON.stringify(chain.steps), '--json'])),
    deleteChain: async (name) => void (await cliText(['chain', 'delete', name, '--json'])),
    refreshModels: async (agent) => void (await cliText(['model', 'refresh', agent])),
    setTerminalDefault: async (name) => void (await cliText(['terminal', 'default', name ?? '--clear'])),
    projects: (origin) => cliJson(projectsArgs(origin), projectsSchema),
    projectScripts: (root) => cliJson(['repo', 'scripts', root, '--json'], projectScriptsSchema),
    setProjectScripts: (root, scripts) =>
      cliJson(['repo', 'scripts', root, ...Object.entries(scripts).flatMap(([name, command]) => [`--${name}`, command]), '--json'], projectScriptsSchema),
    importFolder: (path) => cliJson(['repo', 'add', path, '--json'], repositorySchema),
    importClone: (url, into) => cliJson(['repo', 'clone', url, '--into', into, '--json'], repositorySchema),
    githubRepositories: () => cliJson(['repo', 'github', '--json'], githubRepositorySchema.array()),
    githubPullRequests: (root, state, limit, after) => cliJson(['github', 'prs', root, '--state', state, '--limit', String(limit), ...(after === null ? [] : ['--after', after]), '--json'], githubPullRequestListSchema),
    githubIssues: (root, state, limit, after) => cliJson(['github', 'issues', root, '--state', state, '--limit', String(limit), ...(after === null ? [] : ['--after', after]), '--json'], githubIssueListSchema),
    githubPullRequest: (root, number) => cliJson(['github', 'pr', root, String(number), '--json'], githubDetailSchema),
    githubIssue: (root, number) => cliJson(['github', 'issue', root, String(number), '--json'], githubDetailSchema),
    pickFolder: async () => {
      const selected = await open({ directory: true, multiple: false })
      return selected ?? null
    },
    codeTree: async (root) => codeEntrySchema.array().parse(await invoke('code_tree', { root })),
    codeRead: async (root, path) => codeFileSchema.parse(await invoke('code_read', { root, path })),
    codeChanges: async (root) => codeChangeSchema.array().parse(await invoke('code_changes', { root })),
    codeDiff: async (root, path) => codeDiffSchema.parse(await invoke('code_diff', { root, path })),
    chats: () => cliJson(['chat', 'list', '--json'], nativeChatSchema.array()),
    startChat: ({ agent, model, cwd, parts }) =>
      cliJson(['chat', 'start', '--agent', agent, ...(model === undefined ? [] : ['--model', model]), '--cwd', cwd, ...(parts === undefined ? [] : ['--parts', JSON.stringify(parts)]), '--json'], nativeChatSchema),
    sendChat: async (chatId, parts) => void (await cliText(['chat', 'send', chatId, '--parts', JSON.stringify(parts)])),
    interruptChat: async (chatId) => void (await cliText(['chat', 'interrupt', chatId])),
    answerApproval: async (chatId, approvalId, decision) => void (await cliText(['chat', 'approve', chatId, approvalId, '--decision', decision])),
    stopChat: async (chatId) => void (await cliText(['chat', 'stop', chatId])),
    removeChat: async (chatId) => void (await cliText(['chat', 'remove', chatId, '--json'])),
    setChatModel: async (chatId, model, effort) => void (await cliText(['chat', 'model', chatId, model, ...(effort === undefined ? [] : ['--effort', effort])])),
    setChatMode: (chatId, mode) =>
      cliJson(['chat', 'mode', chatId, mode, '--json'], z.looseObject({ chat: nativeChatSchema, terminal: terminalSessionSchema.nullable() })),
    chatTerminalCommand: (chatId) => cliJson(['chat', 'terminal-command', chatId, '--json'], z.array(z.string())),
    agentCommand: async (agent, options = {}) =>
      (await cliJson(['agent', 'command', agent, ...(options.resume === undefined ? [] : ['--resume', options.resume]), ...(options.model === undefined ? [] : ['--model', options.model]), ...(options.effort === undefined ? [] : ['--effort', options.effort]), '--json'], agentCommandSchema)).argv,
    sessionHistory: (cwd, agent) => cliJson(['sessions', 'history', '--cwd', cwd, ...(agent === undefined ? [] : ['--agent', agent]), '--json'], sessionHistorySchema),
    followChat: (chatId, since, onLine) =>
      cliStream(['chat', 'events', chatId, ...(since === null ? [] : ['--since', since]), '--follow', '--json'], (line) => onLine(chatEventLineSchema.parse(JSON.parse(line)))),
    openTerminal: async (options) => terminalSessionSchema.parse(await invoke('terminal_open', { options })),
    writeTerminal: async (terminalId, data) => void (await invoke('terminal_write', { terminalId, data })),
    resizeTerminal: async (terminalId, cols, rows) => void (await invoke('terminal_resize', { terminalId, cols, rows })),
    closeTerminal: async (terminalId, options) => void (await invoke('terminal_close', { terminalId, kill: options?.kill ?? false })),
    listAppTerminals: () => cliJson(['terminal', 'list', '--app', '--json'], z.array(appTerminalSchema)),
    onTerminalData: (terminalId, onData, onExit) => terminalListen(terminalId, onData, onExit),
    setTerminalEngine: async (engine) => void (await cliText(['settings', 'set', 'terminal-engine', engine])),
    sidebarFolders: () => cliJson(['settings', 'get', 'sidebar-folders'], z.unknown()),
    setSidebarFolders: async (json) => void (await cliText(['settings', 'set', 'sidebar-folders', json])),
  }
}
