import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { z } from 'zod'
import { CliError, type DesktopApi, type InstallExit, type PathLink, type PillGeometry } from '@/api/adapter'
import { settingsSchema, githubRepositorySchema, projectsSchema, repositorySchema, chatReadSchema, codeChangeSchema, codeDiffSchema, codeEntrySchema, codeFileSchema, doctorReportSchema, transcriptSchema, installEventSchema, installPlanSchema, moduleResultSchema, replyResultSchema, statusSchema, worktreeListSchema } from '@/api/schema'

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
    projects: () => cliJson(['projects', '--json'], projectsSchema),
    importFolder: (path) => cliJson(['repo', 'add', path, '--json'], repositorySchema),
    importClone: (url, into) => cliJson(['repo', 'clone', url, '--into', into, '--json'], repositorySchema),
    githubRepositories: () => cliJson(['repo', 'github', '--json'], githubRepositorySchema.array()),
    // Placeholder until the dialog plugin is wired (the import lane replaces this).
    pickFolder: async () => null,
    codeTree: async (root) => codeEntrySchema.array().parse(await invoke('code_tree', { root })),
    codeRead: async (root, path) => codeFileSchema.parse(await invoke('code_read', { root, path })),
    codeChanges: async (root) => codeChangeSchema.array().parse(await invoke('code_changes', { root })),
    codeDiff: async (root, path) => codeDiffSchema.parse(await invoke('code_diff', { root, path })),
  }
}
