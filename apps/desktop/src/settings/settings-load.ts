import type { SettingsKey } from '@/api/schema'
import type { Section } from '@/settings/settings-nav'

/** The `settings --json` keys each page reads; a page loads only these. */
export const sectionKeys: Record<Section, SettingsKey[]> = {
  usage: ['limits'],
  agents: [],
  shortcuts: [],
  models: ['models'],
  chains: ['chains', 'models', 'limits'],
  summaries: ['models'],
  supervisor: ['supervisor'],
  limits: ['resources'],
  terminal: ['terminalEngine', 'terminal'],
  worktrees: [],
}

export interface LoadEntry {
  status: 'loading' | 'ready' | 'error'
  /** What the last successful load returned; kept while a reload runs or fails, so a page never blanks once it has shown. */
  value: unknown
  error: unknown
}

const loading: LoadEntry = { status: 'loading', value: undefined, error: null }

/**
 * One independent load per page, cached while the window is open. A loader that fails or stalls only
 * changes its own entry; no entry waits on another.
 */
export function createLoads(loaders: Record<string, () => Promise<unknown>>) {
  let entries: Record<string, LoadEntry> = {}
  const listeners = new Set<() => void>()
  const set = (key: string, entry: LoadEntry) => {
    entries = { ...entries, [key]: entry }
    for (const listener of listeners) listener()
  }
  const run = (key: string, previous: LoadEntry | undefined): Promise<void> => {
    const loader = loaders[key]
    if (loader === undefined) return Promise.resolve()
    if (previous === undefined || previous.status === 'error') set(key, loading)
    return loader().then(
      (value) => set(key, { status: 'ready', value, error: null }),
      (error: unknown) => set(key, { status: 'error', value: entries[key]?.value, error }),
    )
  }
  return {
    /** Starts the page's load unless it already has an entry; `reload` re-reads it, keeping the last value meanwhile. */
    load(key: string, reload = false): Promise<void> {
      const previous = entries[key]
      if (previous !== undefined && !reload && previous.status !== 'error') return Promise.resolve()
      return run(key, previous)
    },
    get: (key: string): LoadEntry => entries[key] ?? loading,
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
