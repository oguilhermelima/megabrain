import { getCurrentWindow } from '@tauri-apps/api/window'

export const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Which window this page renders: the pill over the notch, or the main window. */
export function surface(): 'pill' | 'main' {
  if (native) return getCurrentWindow().label === 'pill' ? 'pill' : 'main'
  return window.location.hash === '#pill' ? 'pill' : 'main'
}
