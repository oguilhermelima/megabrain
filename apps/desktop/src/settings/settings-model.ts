import type { AdmissionPolicy, Chain, ChainStep, Settings, UsageReading } from '@/api/schema'

export type ModelInfo = Settings['models'][number]

export type UsageLevel = 'normal' | 'amber' | 'red' | 'unknown'

export function usageLevel(usedPercent: number | null): UsageLevel {
  if (usedPercent === null) return 'unknown'
  if (usedPercent > 90) return 'red'
  if (usedPercent >= 70) return 'amber'
  return 'normal'
}

/** "resets in 2h 14m" from a Unix-seconds string, or null when there is nothing to reset. */
export function resetsIn(resetsAt: string | null, now: Date = new Date()): string | null {
  if (resetsAt === null) return null
  const seconds = Math.max(0, Number(resetsAt) - Math.floor(now.getTime() / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `resets in ${hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`}`
}

export interface ProviderReadings {
  provider: string
  fiveHour: UsageReading | null
  weekly: UsageReading | null
}

/** Groups usage readings by provider, keeping the order providers first appear in. */
export function groupReadingsByProvider(readings: UsageReading[]): ProviderReadings[] {
  const order: string[] = []
  const byProvider = new Map<string, ProviderReadings>()
  for (const reading of readings) {
    let group = byProvider.get(reading.provider)
    if (group === undefined) {
      group = { provider: reading.provider, fiveHour: null, weekly: null }
      byProvider.set(reading.provider, group)
      order.push(reading.provider)
    }
    if (reading.window === '5h') group.fiveHour = reading
    else if (reading.window === 'weekly') group.weekly = reading
  }
  return order.map((provider) => byProvider.get(provider) as ProviderReadings)
}

/** Reads a chain's `when` condition in plain language. Only `parentAgent` is known; anything else falls back to its JSON. */
export function conditionText(when: Record<string, unknown>): string {
  const keys = Object.keys(when)
  if (keys.length === 0) return 'always'
  if (keys.length === 1 && keys[0] === 'parentAgent' && typeof when.parentAgent === 'string') return `when the parent is ${when.parentAgent}`
  return JSON.stringify(when)
}

export function stepText(step: ChainStep): string {
  const parts = [step.agent, step.model]
  if (step.effort !== undefined) parts.push(step.effort)
  const text = parts.join(' · ')
  if (step.until === undefined) return text
  return `${text} · until ${step.until.window} at ${step.until.usedPercent}%`
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1))
}

/** Swaps the step at `index` with its neighbour at `index + offset`; a move past either end is a no-op (same array). */
export function moveStep(steps: ChainStep[], index: number, offset: number): ChainStep[] {
  const target = index + offset
  if (target < 0 || target >= steps.length) return steps
  const next = [...steps]
  const [moved] = next.splice(index, 1)
  next.splice(clamp(target, steps.length), 0, moved as ChainStep)
  return next
}

export function withStep(steps: ChainStep[], step: ChainStep): ChainStep[] {
  return [...steps, step]
}

export function withoutStep(steps: ChainStep[], index: number): ChainStep[] {
  return steps.filter((_, position) => position !== index)
}

export interface PolicyForm {
  maxAgents: string
  minAvailableMib: string
  maxPressure: '' | 'normal' | 'elevated'
  maxContainerSuites: string
}

function parseNumberField(name: string, value: string): number | undefined {
  if (value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`)
  return parsed
}

/** Builds an AdmissionPolicy from form fields, omitting empty ones. Throws on a non-numeric field. */
export function policyFromForm(form: PolicyForm): AdmissionPolicy {
  const policy: AdmissionPolicy = {}
  const maxAgents = parseNumberField('max agents', form.maxAgents)
  if (maxAgents !== undefined) policy.maxAgents = maxAgents
  const minAvailableMib = parseNumberField('min free memory', form.minAvailableMib)
  if (minAvailableMib !== undefined) policy.minAvailableMib = minAvailableMib
  if (form.maxPressure !== '') policy.maxPressure = form.maxPressure
  const maxContainerSuites = parseNumberField('max container suites', form.maxContainerSuites)
  if (maxContainerSuites !== undefined) policy.maxContainerSuites = maxContainerSuites
  return policy
}

export function policyToForm(policy: { maxAgents: number | null; minAvailableMib: number | null; maxPressure: 'normal' | 'elevated' | null; maxContainerSuites: number | null } | null): PolicyForm {
  return {
    maxAgents: policy?.maxAgents?.toString() ?? '',
    minAvailableMib: policy?.minAvailableMib?.toString() ?? '',
    maxPressure: policy?.maxPressure ?? '',
    maxContainerSuites: policy?.maxContainerSuites?.toString() ?? '',
  }
}

export function emptyChain(name: string, parentAgent: string): Chain {
  return { name, when: parentAgent === '' ? {} : { parentAgent }, steps: [] }
}
