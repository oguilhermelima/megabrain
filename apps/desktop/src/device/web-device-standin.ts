import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { CliError } from '@/api/adapter'
import { native } from '@/lib/surface'

// Stand-in for the web device calls until the CLI lane's verbs reach api/adapter.ts (reconciled at
// merge). Every call runs `megabrain web device …` through run_cli, as the rest of the desktop API
// does; the browser preview without a bridge answers an empty list and refuses the rest.

/** `megabrain web device start|list --json`: one headless browser viewport, its size in CSS px. */
export const webDeviceSchema = z.looseObject({
  id: z.string(),
  kind: z.literal('web'),
  url: z.string(),
  title: z.string(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
  streamUrl: z.string(),
})
export type WebDevice = z.infer<typeof webDeviceSchema>

export const webDeviceListSchema = z.looseObject({ devices: z.array(webDeviceSchema) })

export const webInputSchema = z.looseObject({ ok: z.boolean(), ms: z.number() })
export type WebInput = z.infer<typeof webInputSchema>

/** One preset of `megabrain web devices list --json`, its viewport in CSS px. */
export const viewportPresetSchema = z.looseObject({
  slug: z.string(),
  label: z.string(),
  category: z.string(),
  origin: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  scale: z.number().nullable().optional(),
  mobile: z.boolean().optional(),
})
export type ViewportPreset = z.infer<typeof viewportPresetSchema>

export const viewportPresetListSchema = z.looseObject({ devices: z.array(viewportPresetSchema) })

/** `web device input <id> viewport`: the new size, the id unchanged. */
export const webViewportSchema = z.looseObject({ ok: z.boolean(), width: z.number(), height: z.number() })

/** What a web device takes: a point in CSS px of its viewport, or a browser action. */
export type WebAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number; ms?: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; name: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'viewport'; preset: string; landscape: boolean }

/** What `web device input` takes besides a viewport change, which answers with the new size. */
export type WebInputAction = Exclude<WebAction, { type: 'viewport' }>

/** The arguments after `web device input <id>`. */
export function webInputArgs(action: WebAction): string[] {
  switch (action.type) {
    case 'tap':
      return ['tap', String(action.x), String(action.y)]
    case 'swipe':
      return ['swipe', String(action.x1), String(action.y1), String(action.x2), String(action.y2), ...(action.ms === undefined ? [] : ['--ms', String(action.ms)])]
    case 'scroll':
      return ['scroll', String(action.x), String(action.y), String(action.dx), String(action.dy)]
    case 'type':
      return ['type', action.text]
    case 'key':
      return ['key', action.name]
    case 'navigate':
      return ['navigate', action.url]
    case 'viewport':
      return ['viewport', action.preset, ...(action.landscape ? ['--landscape'] : [])]
    default:
      return [action.type]
  }
}

/** `web device start`'s arguments for a URL, an optional preset and the worktree it is for. */
export function webStartArgs(url: string, preset: string | null, worktree: string | null): string[] {
  return ['web', 'device', 'start', '--url', url, ...(preset === null ? [] : ['--device', preset]), ...(worktree === null ? [] : ['--worktree', worktree]), '--json']
}

interface CliOutput {
  code: number | null
  stdout: string
  stderr: string
}

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

async function cli(args: string[]): Promise<string> {
  const output = await invoke<CliOutput>('run_cli', { args })
  if (output.code !== 0) throw new CliError(lastLine(output.stderr) || lastLine(output.stdout) || `megabrain ${args.slice(0, 3).join(' ')} exited ${output.code}`, output.code)
  return output.stdout
}

async function cliJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(JSON.parse(await cli(args)))
  if (!parsed.success) throw new CliError(`megabrain ${args.slice(0, 3).join(' ')} answered in an unexpected shape: ${parsed.error.message}`, 1)
  return parsed.data
}

const reachable = native || Boolean(import.meta.env.VITE_MEGABRAIN_BRIDGE)
const unavailable = () => Promise.reject(new Error('Web devices need the desktop app'))

export const webDevices = {
  list: async (): Promise<WebDevice[]> => (reachable ? (await cliJson(['web', 'device', 'list', '--json'], webDeviceListSchema)).devices : []),
  start: (url: string, preset: string | null, worktree: string | null): Promise<WebDevice> => (reachable ? cliJson(webStartArgs(url, preset, worktree), webDeviceSchema) : unavailable()),
  stop: async (id: string): Promise<void> => (reachable ? void (await cli(['web', 'device', 'stop', id, '--json'])) : unavailable()),
  input: (id: string, action: WebInputAction): Promise<WebInput> => (reachable ? cliJson(['web', 'device', 'input', id, ...webInputArgs(action), '--json'], webInputSchema) : unavailable()),
  viewport: (id: string, preset: string, landscape: boolean) => (reachable ? cliJson(['web', 'device', 'input', id, ...webInputArgs({ type: 'viewport', preset, landscape }), '--json'], webViewportSchema) : unavailable()),
  presets: async (): Promise<ViewportPreset[]> => (reachable ? (await cliJson(['web', 'devices', 'list', '--json'], viewportPresetListSchema)).devices : []),
}
