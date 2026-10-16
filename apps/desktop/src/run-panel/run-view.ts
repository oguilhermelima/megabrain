import type { RunStatus } from '@/run-panel/run-model'

/** pending: starting; running: live; ok: exited 0; failed: exited with another code; stopped: ended with no code. */
export type RunTone = 'pending' | 'running' | 'ok' | 'failed' | 'stopped'

export interface RunStatusView {
  tone: RunTone
  label: string
  /** Still running or about to: Stop has something to stop. */
  live: boolean
}

/** How a run's tab and header show its status. */
export function runStatusView(status: RunStatus): RunStatusView {
  if (status.kind === 'starting') return { tone: 'pending', label: 'starting', live: true }
  if (status.kind === 'running') return { tone: 'running', label: 'running', live: true }
  if (status.code === null) return { tone: 'stopped', label: 'stopped', live: false }
  if (status.code === 0) return { tone: 'ok', label: 'exited ok', live: false }
  return { tone: 'failed', label: `exited with code ${status.code}`, live: false }
}
