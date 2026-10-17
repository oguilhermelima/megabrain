import type { Chain, ChainExplain, ChainExplainInput, Condition, Rule, UsageReading } from '@/api/schema'

// The mock's stand-in for `chain explain`: the same selection the CLI makes (every matching chain is a
// candidate, highest priority wins, ties go to the more specific rule, then the name), close enough
// for the window to be tried in a plain browser. The CLI is the real authority.

interface Match {
  matched: boolean
  specificity: number
  reasons: string[]
}

const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const list = (value: string | string[] | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const glob = (pattern: string, value: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(value)

const inputFields = ['parentAgent', 'parentModel', 'parentEffort', 'repo', 'branch', 'label'] as const

function condition(rule: Condition, input: ChainExplainInput, readings: UsageReading[], now: Date): Match {
  const reasons: string[] = []
  let specificity = 0
  for (const field of inputFields) {
    const wanted = list(rule[field])
    if (wanted.length === 0) continue
    specificity += 1
    const value = input[field]
    const exact = field === 'parentAgent' || field === 'parentModel' || field === 'parentEffort'
    const ok = value !== undefined && wanted.some((pattern) => (exact ? pattern === value : glob(pattern, value)))
    reasons.push(`${field} ${ok ? 'is' : 'is not'} ${wanted.join(' or ')}${value === undefined ? ' (not given)' : ` (got ${value})`}`)
    if (!ok) return { matched: false, specificity, reasons }
  }
  if (rule.usage !== undefined) {
    specificity += 1
    const { provider, window, below, above } = rule.usage
    const used = readings.filter((reading) => reading.provider === provider && reading.window === window).reduce<number | null>((highest, reading) => reading.usedPercent === null ? highest : highest === null ? reading.usedPercent : Math.max(highest, reading.usedPercent), null)
    const ok = used !== null && (below === undefined || used < below) && (above === undefined || used > above)
    reasons.push(`${provider} ${window} usage ${used === null ? 'is unknown' : `is ${used}%`}`)
    if (!ok) return { matched: false, specificity, reasons }
  }
  if (rule.time !== undefined) {
    specificity += 1
    const day = days[now.getDay()] ?? ''
    const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const { days: on, from, to } = rule.time
    const ok = (on === undefined || on.includes(day)) && (from === undefined || clock >= from) && (to === undefined || clock < to)
    reasons.push(`it is ${day} ${clock}${ok ? '' : ', outside the time window'}`)
    if (!ok) return { matched: false, specificity, reasons }
  }
  return { matched: true, specificity, reasons: reasons.length === 0 ? ['no condition, always matches'] : reasons }
}

function match(rule: Rule, input: ChainExplainInput, readings: UsageReading[], now: Date): Match {
  if ('not' in rule) {
    const inner = match(rule.not, input, readings, now)
    return { matched: !inner.matched, specificity: inner.specificity, reasons: [`not (${inner.reasons.join('; ')})`] }
  }
  if ('any' in rule) {
    const results = rule.any.map((item) => match(item, input, readings, now))
    const best = results.filter((result) => result.matched).sort((left, right) => right.specificity - left.specificity)[0]
    return best ?? { matched: false, specificity: 0, reasons: results.flatMap((result) => result.reasons) }
  }
  if ('all' in rule) {
    const results = rule.all.map((item) => match(item, input, readings, now))
    return { matched: results.every((result) => result.matched), specificity: results.reduce((sum, result) => sum + result.specificity, 0), reasons: results.flatMap((result) => result.reasons) }
  }
  return condition(rule, input, readings, now)
}

export function explainChains(chains: Chain[], input: ChainExplainInput, readings: UsageReading[], now = new Date()): ChainExplain {
  const candidates = chains.map((chain) => ({ name: chain.name, priority: chain.priority ?? 0, ...match(chain.when, input, readings, now) }))
  const chosen =
    candidates
      .filter((candidate) => candidate.matched)
      .sort((left, right) => right.priority - left.priority || right.specificity - left.specificity || left.name.localeCompare(right.name))[0]?.name ?? null
  const chain = chains.find((item) => item.name === chosen)
  const steps = (chain?.steps ?? []).map((step, index) => {
    if (step.when === undefined) return { index, step, skipped: false, reason: null }
    const result = match(step.when, input, readings, now)
    return { index, step, skipped: !result.matched, reason: result.reasons.join('; ') }
  })
  return { candidates, chosen, steps }
}
