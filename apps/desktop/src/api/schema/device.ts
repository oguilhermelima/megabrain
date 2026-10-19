import { z } from 'zod'

// `native input stream|rotate --json` and `web device|devices --json` contracts.
export const inputStreamSchema = z.looseObject({ streamUrl: z.string().url(), width: z.number().int().positive(), height: z.number().int().positive(), scale: z.number().positive() })
export const inputRotationSchema = z.looseObject({ ok: z.literal(true), orientation: z.enum(['portrait', 'landscape']), width: z.number().int().positive(), height: z.number().int().positive() })
export type Orientation = z.infer<typeof inputRotationSchema>['orientation']

export const webDeviceSchema = z.looseObject({ id: z.string(), kind: z.literal('web'), url: z.string().url(), title: z.string(), width: z.number().positive(), height: z.number().positive(), scale: z.number().positive(), streamUrl: z.string().url() })
export const webDeviceListSchema = z.looseObject({ devices: z.array(webDeviceSchema) })
export const webDeviceStopSchema = z.looseObject({ id: z.string(), stopped: z.literal(true) })
export const webActionResultSchema = z.looseObject({ ok: z.boolean(), ms: z.number().optional() })
export const viewportPresetSchema = z.looseObject({ slug: z.string(), label: z.string(), category: z.string(), origin: z.string(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), scale: z.number().positive().nullable().optional(), mobile: z.boolean().optional() })
export const viewportPresetListSchema = z.looseObject({ devices: z.array(viewportPresetSchema) })

export const webInputActionSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('tap'), x: z.number(), y: z.number() }),
  z.looseObject({ type: z.literal('swipe'), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), ms: z.number().optional() }),
  z.looseObject({ type: z.literal('scroll'), x: z.number(), y: z.number(), dx: z.number(), dy: z.number() }),
  z.looseObject({ type: z.literal('type'), text: z.string() }),
  z.looseObject({ type: z.literal('key'), name: z.string() }),
  z.looseObject({ type: z.literal('navigate'), url: z.string().url() }),
  z.looseObject({ type: z.literal('back') }),
  z.looseObject({ type: z.literal('forward') }),
  z.looseObject({ type: z.literal('reload') }),
])

export type InputStream = z.infer<typeof inputStreamSchema>
export type InputRotation = z.infer<typeof inputRotationSchema>
export type WebDevice = z.infer<typeof webDeviceSchema>
export type WebDeviceStop = z.infer<typeof webDeviceStopSchema>
export type WebActionResult = z.infer<typeof webActionResultSchema>
export type ViewportPreset = z.infer<typeof viewportPresetSchema>
export type WebInputAction = z.infer<typeof webInputActionSchema>
