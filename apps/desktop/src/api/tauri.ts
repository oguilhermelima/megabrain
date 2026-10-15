import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { z } from 'zod'
import { CliError, type DesktopApi, type InstallExit, type PathLink, type PillGeometry } from '@/api/adapter'
import { chatReadSchema, doctorReportSchema, installEventSchema, installPlanSchema, moduleResultSchema, replyResultSchema, statusSchema, worktreeListSchema } from '@/api/schema'

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
  }
}
