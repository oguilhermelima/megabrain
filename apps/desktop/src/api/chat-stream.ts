import { z } from 'zod'
import { chatEventLineSchema, type ChatEventLine } from '@/api/schema'

// What the stream itself says, besides the CLI's lines: why the CLI failed, and that it ended.
export const streamMarkerSchema = z.looseObject({ cursor: z.literal(''), error: z.string().optional(), end: z.literal(true).optional() }).refine((value) => value.error !== undefined || value.end === true)

/**
 * Reads the lines of megabrain chat events --follow --json. It never throws: a Tauri channel whose
 * handler throws holds back every message after that one, so one bad line would freeze the follow
 * while its process stays alive. A line that fails is reported and the next one is read.
 */
export function chatStreamReader(onLine: (line: ChatEventLine) => void, onEnd?: (error: string | null) => void, onFailure: (caught: unknown) => void = console.error): (text: string) => void {
  // The stream's last lines may be an error and an end marker; they are not chat events.
  let error: string | null = null
  return (text) => {
    try {
      const value: unknown = JSON.parse(text)
      const marker = streamMarkerSchema.safeParse(value)
      if (marker.success && marker.data.end === true) return onEnd?.(error)
      if (marker.success && marker.data.error !== undefined) {
        error = marker.data.error
        return
      }
      onLine(chatEventLineSchema.parse(value))
    } catch (caught) {
      onFailure(caught)
    }
  }
}
