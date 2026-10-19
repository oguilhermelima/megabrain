import type { ProjectScripts } from '@/api/schema'
import type { ViewportPreset, WebDevice } from '@/device/web-device-standin'

// The Web group of the Device tab: a headless browser viewport (`megabrain web device`), started
// from a URL and one of `web devices list`'s presets, shown and driven in CSS px.

/** The worktree's dev server, when its project has a Run script and the port it binds is known; else empty. */
export function devServerUrl(scripts: ProjectScripts | null): string {
  if (scripts === null || scripts.scripts.run === null) return ''
  const port = scripts.port?.port
  return port === undefined ? '' : `http://localhost:${port}`
}

/** The URL a start form's text opens: http(s) as typed, a bare host given http; null for anything else. */
export function webUrl(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `http://${text}`
  try {
    const url = new URL(withScheme)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/** The start form's presets by category, categories in the order the list first names them. */
export function presetGroups(presets: readonly ViewportPreset[]): { category: string; presets: ViewportPreset[] }[] {
  const groups = new Map<string, ViewportPreset[]>()
  for (const preset of presets) groups.set(preset.category, [...(groups.get(preset.category) ?? []), preset])
  return [...groups.entries()].map(([category, list]) => ({ category, presets: list }))
}

/** A web device's row: its page title, else the URL's host and path. */
export function webDeviceName(device: Pick<WebDevice, 'title' | 'url'>): string {
  if (device.title.trim() !== '') return device.title.trim()
  try {
    const url = new URL(device.url)
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return device.url
  }
}

/** The viewport's CSS size, as the row's trailing text. */
export const viewportLabel = (device: Pick<WebDevice, 'width' | 'height'>) => `${Math.round(device.width)}×${Math.round(device.height)}`
