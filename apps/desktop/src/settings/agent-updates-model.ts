// The Updates block on the Agents page: each agent CLI's installed and latest version, how it was
// installed, and whether megabrain updates it on its own. The policy is stored by the CLI
// (`settings get|set agents-update`) as { enabled, perAgent }; a per-agent entry exists only where
// it differs from the main switch. The report comes from the CLI's agent update check.

import { AGENT_IDS, agentNames } from '@/settings/agents-model'
import type { AgentUpdateEntry } from '@/api/schema'

export type { AgentUpdateEntry }

export interface UpdatePolicy {
  enabled: boolean
  perAgent: Record<string, boolean>
}

export const defaultUpdatePolicy: UpdatePolicy = { enabled: true, perAgent: {} }

const known = (value: string) => (AGENT_IDS as readonly string[]).includes(value)

/** Reads what `settings get agents-update` printed; anything unusable falls back field by field. */
export function parseUpdatePolicy(value: unknown): UpdatePolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return defaultUpdatePolicy
  const record = value as Record<string, unknown>
  const perAgent: Record<string, boolean> = {}
  if (typeof record.perAgent === 'object' && record.perAgent !== null && !Array.isArray(record.perAgent)) {
    for (const [agent, on] of Object.entries(record.perAgent as Record<string, unknown>)) if (known(agent) && typeof on === 'boolean') perAgent[agent] = on
  }
  return { enabled: typeof record.enabled === 'boolean' ? record.enabled : true, perAgent }
}

export function serialiseUpdatePolicy(policy: UpdatePolicy): string {
  return JSON.stringify({ enabled: policy.enabled, perAgent: policy.perAgent })
}

/** The main switch decides for every agent again. */
export function withAutoUpdate(_policy: UpdatePolicy, enabled: boolean): UpdatePolicy {
  return { enabled, perAgent: {} }
}

export function withAgentAutoUpdate(policy: UpdatePolicy, agent: string, enabled: boolean): UpdatePolicy {
  const { [agent]: _previous, ...rest } = policy.perAgent
  return { enabled: policy.enabled, perAgent: enabled === policy.enabled ? rest : { ...rest, [agent]: enabled } }
}

export type InstallKind = 'standalone' | 'npm' | 'brew' | 'native' | 'unknown'
const kinds: readonly string[] = ['standalone', 'npm', 'brew', 'native', 'unknown']

export const kindLabels: Record<InstallKind, string> = { standalone: 'Standalone installer', npm: 'npm', brew: 'Homebrew', native: 'Native installer', unknown: 'Unknown install' }

export type UpdateState = 'up-to-date' | 'available' | 'updating' | 'failed' | 'unknown' | 'not-installed'

export interface UpdateRow {
  agent: string
  label: string
  state: UpdateState
  installed: string | null
  latest: string | null
  kind: InstallKind
  checkedAt: string | null
  /** The line of the failed attempt that says why; null unless the state is failed. */
  error: string | null
  /** Whether megabrain updates this agent on its own. */
  auto: boolean
  /** Whether Update now is offered. */
  canUpdate: boolean
}

/** The last line with text in an installer's output, the one that usually says why it stopped. */
export function decisiveLine(output: string | null | undefined): string | null {
  const lines = (output ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.at(-1) ?? null
}

/**
 * One row per agent in a fixed order. `updating` holds the agents this window is updating;
 * `failures` the output of an Update now that failed here, which wins over the report's last attempt.
 */
export function updateRows(report: readonly AgentUpdateEntry[] | null, policy: UpdatePolicy, updating: ReadonlySet<string>, failures: Readonly<Record<string, string>>): UpdateRow[] {
  return AGENT_IDS.map((agent) => {
    const entry = report?.find((item) => item.agent === agent)
    const installed = entry?.installed ?? null
    const latest = entry?.latest ?? null
    const current = entry?.status === 'up-to-date' || entry?.status === 'updated'
    const failure = failures[agent] ?? (entry?.lastAttempt?.ok === false && !current ? (entry.lastAttempt.error ?? 'The last update failed') : undefined)
    const state: UpdateState =
      installed === null ? 'not-installed' : updating.has(agent) || entry?.status === 'updating' ? 'updating' : failure !== undefined ? 'failed' : current ? 'up-to-date' : entry?.status === 'update-available' ? 'available' : 'unknown'
    return {
      agent,
      label: agentNames[agent] ?? agent,
      state,
      installed,
      latest,
      kind: entry !== undefined && kinds.includes(entry.installKind) ? (entry.installKind as InstallKind) : 'unknown',
      checkedAt: entry?.checkedAt ?? null,
      error: state === 'failed' ? decisiveLine(failure) : null,
      auto: policy.perAgent[agent] ?? policy.enabled,
      canUpdate: state === 'available' || state === 'failed',
    }
  })
}

/** Updates waiting on agents megabrain does not update on its own: the count on the Agents entry. */
export function pendingBadge(rows: readonly UpdateRow[]): number {
  return rows.filter((row) => row.canUpdate && !row.auto).length
}

export function checkedLabel(checkedAt: string | null, now: number): string {
  const at = checkedAt === null ? Number.NaN : Date.parse(checkedAt)
  if (Number.isNaN(at)) return 'Never checked'
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'Checked just now'
  if (minutes < 60) return `Checked ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Checked ${hours} h ago`
  return `Checked ${Math.floor(hours / 24)} d ago`
}
