import { invoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import { CliError } from '@/api/adapter'
import { api } from '@/api'
import { standinStreamUrl } from '@/device/frame-stream-standin'
import { native } from '@/lib/surface'

// Stand-ins for `megabrain native input rotate` and `native input stream` until the CLI lane's
// verbs reach api/adapter.ts (reconciled at merge). They answer as the other `native input` verbs
// do: a refusal beside the fields, null on success.

export type Orientation = 'portrait' | 'landscape'

interface CliOutput {
  code: number | null
  stdout: string
  stderr: string
}

const answerSchema = z.looseObject({ refusal: z.looseObject({ message: z.string() }).nullable().optional() })

const lastLine = (text: string): string => text.trim().split('\n').at(-1) ?? ''

const reachable = native || Boolean(import.meta.env.VITE_MEGABRAIN_BRIDGE)

async function nativeJson<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
  const output = await invoke<CliOutput>('run_cli', { args })
  if (output.stdout.trim() === '') throw new CliError(lastLine(output.stderr) || `megabrain ${args.slice(0, 3).join(' ')} exited ${output.code}`, output.code)
  const answer = answerSchema.parse(JSON.parse(output.stdout))
  if (answer.refusal != null) throw new CliError(answer.refusal.message, 1)
  return schema.parse(answer)
}

export async function rotateSimulator(udid: string, orientation: Orientation): Promise<void> {
  if (!reachable) throw new Error('Rotating needs the desktop app')
  await nativeJson(['native', 'input', 'rotate', udid, orientation, '--json'], z.unknown())
}

/** `native input stream <udid> --json`: the input session's MJPEG stream, its pixel size and scale. */
export const simulatorStreamSchema = z.looseObject({ streamUrl: z.string(), width: z.number(), height: z.number(), scale: z.number() })
export type SimulatorStream = z.infer<typeof simulatorStreamSchema>

/**
 * A ready simulator's stream. While the CLI has no `native input stream`, one frame gives the size
 * and scale and the stand-in URL polls the rest (frame-stream-standin).
 */
export async function simulatorStream(udid: string): Promise<SimulatorStream> {
  if (reachable) {
    const stream = await nativeJson(['native', 'input', 'stream', udid, '--json'], simulatorStreamSchema).catch(() => null)
    if (stream !== null) return stream
  }
  const frame = await api.inputFrame(udid)
  return { streamUrl: standinStreamUrl(udid), width: frame.width, height: frame.height, scale: frame.scale }
}
