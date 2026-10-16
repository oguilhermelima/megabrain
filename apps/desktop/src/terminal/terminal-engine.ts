import { api } from '@/api'
import type { TerminalEngine } from '@/api/schema'

// The engine the settings choose for terminals the app opens. Read once and kept, so opening a
// terminal does not wait on a settings read each time; changing it in Settings replaces it.
let engine: Promise<TerminalEngine> | null = null

export function terminalEngine(): Promise<TerminalEngine> {
  engine ??= api.settings().then(
    (settings) => settings.terminalEngine ?? 'native',
    () => {
      engine = null
      return 'native' as const
    },
  )
  return engine
}

export function setKnownTerminalEngine(next: TerminalEngine) {
  engine = Promise.resolve(next)
}
