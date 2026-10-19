import type { WebInputAction } from '@/api/schema'

export type WebDeviceAction = WebInputAction | { type: 'viewport'; preset: string; landscape: boolean }

export function webStartArgs(url: string, preset: string | null, worktree: string | null): string[] {
  return ['web', 'device', 'start', '--url', url, ...(preset === null ? [] : ['--device', preset]), ...(worktree === null ? [] : ['--worktree', worktree]), '--json']
}

export function webInputArgs(action: WebDeviceAction): string[] {
  switch (action.type) {
    case 'tap': return ['tap', String(action.x), String(action.y)]
    case 'swipe': return ['swipe', String(action.x1), String(action.y1), String(action.x2), String(action.y2), ...(action.ms === undefined ? [] : ['--ms', String(action.ms)])]
    case 'scroll': return ['scroll', String(action.x), String(action.y), String(action.dx), String(action.dy)]
    case 'type': return ['type', action.text]
    case 'key': return ['key', action.name]
    case 'navigate': return ['navigate', action.url]
    case 'viewport': return ['viewport', action.preset, ...(action.landscape ? ['--landscape'] : [])]
    default: return [action.type]
  }
}
