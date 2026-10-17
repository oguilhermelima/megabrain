// The sidebar's usage readout: the order the person put the providers in and the ones they took off
// the strip, saved through `megabrain settings set usage-order`. The order names providers, so one without a reading today keeps its place for when it
// has one again.

export interface UsageOrder {
  version: 1
  /** Providers in the order the person put them; one it does not name follows, in reading order. */
  order: string[]
  /** Providers the strip leaves out; the popover lists them last. */
  hidden: string[]
}

export const noUsageOrder: UsageOrder = { version: 1, order: [], hidden: [] }

const strings = (value: unknown[]): string[] => value.filter((entry): entry is string => typeof entry === 'string')

/** What `settings get usage-order` printed, keeping what is usable; anything else is nothing saved. */
export function parseUsageOrder(raw: unknown): UsageOrder {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return noUsageOrder
  const { version, order, hidden } = raw as Record<string, unknown>
  if (version !== 1 || !Array.isArray(order) || !Array.isArray(hidden)) return noUsageOrder
  return { version: 1, order: strings(order), hidden: strings(hidden) }
}

export const serialiseUsageOrder = (saved: UsageOrder): string => JSON.stringify(saved)

export const isEmptyUsageOrder = (saved: UsageOrder) => saved.order.length === 0 && saved.hidden.length === 0

/** The providers in the saved order: `strip` without the hidden ones, `listed` with them after. */
export function arrangeUsage<T extends { agent: string }>(usage: T[], saved: UsageOrder): { listed: T[]; strip: T[] } {
  const rank = (agent: string) => {
    const at = saved.order.indexOf(agent)
    return at === -1 ? saved.order.length : at
  }
  // A stable sort keeps reading order among the providers the saved order does not name.
  const ordered = [...usage].sort((a, b) => rank(a.agent) - rank(b.agent))
  const strip = ordered.filter((item) => !saved.hidden.includes(item.agent))
  return { listed: [...strip, ...ordered.filter((item) => saved.hidden.includes(item.agent))], strip }
}

/**
 * The order with `agent` moved to `index` among the providers of its own group, shown or hidden, as
 * the popover lists them. Every provider listed now is written down, then those the order named
 * without a reading now, in their old order.
 */
export function moveUsage(saved: UsageOrder, usage: { agent: string }[], agent: string, index: number): UsageOrder {
  const { listed } = arrangeUsage(usage, saved)
  const agents = listed.map((item) => item.agent)
  if (!agents.includes(agent)) return saved
  const hidden = saved.hidden.includes(agent)
  const group = agents.filter((name) => saved.hidden.includes(name) === hidden && name !== agent)
  group.splice(Math.max(0, Math.min(index, group.length)), 0, agent)
  const others = agents.filter((name) => saved.hidden.includes(name) !== hidden)
  const order = hidden ? [...others, ...group] : [...group, ...others]
  return { ...saved, order: [...order, ...saved.order.filter((name) => !agents.includes(name))] }
}

/** Hides a shown provider from the strip, or shows a hidden one again in the place the order gives it. */
export function toggleUsageHidden(saved: UsageOrder, agent: string): UsageOrder {
  const hidden = saved.hidden.includes(agent) ? saved.hidden.filter((name) => name !== agent) : [...saved.hidden, agent]
  return { ...saved, hidden }
}
