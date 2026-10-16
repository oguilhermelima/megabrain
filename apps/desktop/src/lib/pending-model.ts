// Actions that start something (a chat, a terminal, a worktree) show themselves at once and cannot
// be triggered twice: one entry per trigger, running until it resolves, failed with its error until
// it runs again (the retry) or is dismissed.

export interface PendingEntry {
  /** What is starting, in words: "Starting Claude in canto · main". */
  label: string
  status: 'running' | 'failed'
  error: string | null
}

export type PendingMap = Readonly<Record<string, PendingEntry>>

export function pendingError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function pendingRunning(map: PendingMap, key: string): boolean {
  return map[key]?.status === 'running'
}

/** null while the same trigger still runs: the second click does nothing. A failed one runs again. */
export function beginPending(map: PendingMap, key: string, label: string): PendingMap | null {
  if (pendingRunning(map, key)) return null
  return { ...map, [key]: { label, status: 'running', error: null } }
}

export function failPending(map: PendingMap, key: string, error: unknown): PendingMap {
  const entry = map[key]
  if (entry === undefined) return map
  return { ...map, [key]: { ...entry, status: 'failed', error: pendingError(error) } }
}

/** Resolved or dismissed: the trigger is free again. */
export function settlePending(map: PendingMap, key: string): PendingMap {
  if (!(key in map)) return map
  const { [key]: _settled, ...rest } = map
  return rest
}
