import type { AgentUsage, UsageMeter, UsagePool } from '@/advanced/usage-limits'

// Which providers, and which of a provider's pools, the usage popover folds to one row. The choice is
// this viewer's, kept in local storage: a provider or pool the person never folded or opened follows
// the default, collapsed when it has more than two windows.

/** Folded (true) or opened (false) by the person, by provider, or by `provider/pool` for a pool. */
export type UsageCollapse = Record<string, boolean>

export const usageCollapseKey = 'megabrain.usage.collapsed'

const version = 1

/** A pool's key beside its provider's, so a pool name another provider shares never collides. */
export const poolKey = (agent: string, bucket: string) => `${agent}/${bucket}`

/** What this viewer's storage kept, keeping what is usable; anything else is nothing chosen. */
export function parseUsageCollapse(raw: string | null): UsageCollapse {
  if (raw === null) return {}
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const { version: saved, collapsed } = value as Record<string, unknown>
  if (saved !== version || typeof collapsed !== 'object' || collapsed === null || Array.isArray(collapsed)) return {}
  return Object.fromEntries(Object.entries(collapsed).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'))
}

export const serialiseUsageCollapse = (collapsed: UsageCollapse): string => JSON.stringify({ version, collapsed })

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function readUsageCollapse(storage: Store): UsageCollapse {
  try {
    return parseUsageCollapse(storage.getItem(usageCollapseKey))
  } catch {
    return {}
  }
}

export function writeUsageCollapse(storage: Store, collapsed: UsageCollapse) {
  try {
    storage.setItem(usageCollapseKey, serialiseUsageCollapse(collapsed))
  } catch {
    // Remembering the fold is a convenience; the default comes back next time.
  }
}

/** Folded by default: a provider or pool with more than two windows. */
export const collapsedByDefault = (meters: number) => meters > 2

const windowCount = (usage: AgentUsage) => usage.pools.reduce((count, pool) => count + pool.meters.length, 0)

export const isProviderCollapsed = (collapsed: UsageCollapse, usage: AgentUsage) => collapsed[usage.agent] ?? collapsedByDefault(windowCount(usage))

export const isPoolCollapsed = (collapsed: UsageCollapse, agent: string, pool: UsagePool) =>
  pool.bucket === null ? false : (collapsed[poolKey(agent, pool.bucket)] ?? collapsedByDefault(pool.meters.length))

/** The window a folded row shows: the most used, the first on a tie. */
export const mostUsed = (meters: UsageMeter[]): UsageMeter | null => meters.reduce<UsageMeter | null>((highest, meter) => (highest === null || meter.usedPercent > highest.usedPercent ? meter : highest), null)

/** Every provider folded, or every provider and pool opened. */
export function collapseAll(collapsed: UsageCollapse, usage: AgentUsage[], fold: boolean): UsageCollapse {
  const next = { ...collapsed }
  for (const item of usage) {
    next[item.agent] = fold
    if (!fold) for (const pool of item.pools) if (pool.bucket !== null) next[poolKey(item.agent, pool.bucket)] = false
  }
  return next
}
