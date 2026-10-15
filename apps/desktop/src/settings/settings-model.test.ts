import { describe, expect, test } from 'bun:test'
import type { AdmissionPolicy, Chain, ChainStep, UsageReading } from '@/api/schema'
import {
  conditionText,
  groupReadingsByProvider,
  moveStep,
  policyFromForm,
  resetsIn,
  stepText,
  usageLevel,
  withoutStep,
  withStep,
} from '@/settings/settings-model'

describe('usageLevel', () => {
  test('under 70 is normal', () => {
    expect(usageLevel(0)).toBe('normal')
    expect(usageLevel(69)).toBe('normal')
  })
  test('70 to 90 is amber', () => {
    expect(usageLevel(70)).toBe('amber')
    expect(usageLevel(90)).toBe('amber')
  })
  test('over 90 is red', () => {
    expect(usageLevel(91)).toBe('red')
    expect(usageLevel(100)).toBe('red')
  })
  test('null reading has no level', () => {
    expect(usageLevel(null)).toBe('unknown')
  })
})

describe('resetsIn', () => {
  const now = new Date('2026-10-15T14:00:00.000Z')
  test('formats hours and minutes from Unix seconds', () => {
    const resetsAt = String(Math.floor(now.getTime() / 1000) + 2 * 3600 + 14 * 60)
    expect(resetsIn(resetsAt, now)).toBe('resets in 2h 14m')
  })
  test('formats minutes only under an hour', () => {
    const resetsAt = String(Math.floor(now.getTime() / 1000) + 45 * 60)
    expect(resetsIn(resetsAt, now)).toBe('resets in 45m')
  })
  test('a past reset still reads as 0m, never negative', () => {
    const resetsAt = String(Math.floor(now.getTime() / 1000) - 600)
    expect(resetsIn(resetsAt, now)).toBe('resets in 0m')
  })
  test('null resetsAt has no text', () => {
    expect(resetsIn(null, now)).toBe(null)
  })
})

describe('groupReadingsByProvider', () => {
  const readings: UsageReading[] = [
    { provider: 'claude', window: '5h', status: 'current', usedPercent: 4, resetsAt: '1', fetchedAt: 1, reason: 'a' },
    { provider: 'claude', window: 'weekly', status: 'current', usedPercent: 88, resetsAt: '2', fetchedAt: 1, reason: 'b' },
    { provider: 'codex', window: '5h', status: 'current', usedPercent: 17, resetsAt: '3', fetchedAt: 1, reason: 'c' },
  ]
  test('groups the 5h and weekly readings under each provider, in appearance order', () => {
    const grouped = groupReadingsByProvider(readings)
    expect(grouped.map((group) => group.provider)).toEqual(['claude', 'codex'])
    expect(grouped[0]?.fiveHour?.usedPercent).toBe(4)
    expect(grouped[0]?.weekly?.usedPercent).toBe(88)
    expect(grouped[1]?.fiveHour?.usedPercent).toBe(17)
    expect(grouped[1]?.weekly).toBe(null)
  })
  test('no readings is an empty list', () => {
    expect(groupReadingsByProvider([])).toEqual([])
  })
})

describe('conditionText', () => {
  test('reads a parentAgent condition in plain language', () => {
    expect(conditionText({ parentAgent: 'claude' })).toBe('when the parent is claude')
  })
  test('an empty condition always applies', () => {
    expect(conditionText({})).toBe('always')
  })
  test('an unrecognised condition falls back to its JSON', () => {
    expect(conditionText({ foo: 'bar' })).toBe('{"foo":"bar"}')
  })
})

describe('stepText', () => {
  test('names agent, model and effort', () => {
    const step: ChainStep = { agent: 'codex', model: 'gpt-6-luna', effort: 'high' }
    expect(stepText(step)).toBe('codex · gpt-6-luna · high')
  })
  test('omits effort when absent', () => {
    const step: ChainStep = { agent: 'agy', model: 'gemini-3.1-pro-high' }
    expect(stepText(step)).toBe('agy · gemini-3.1-pro-high')
  })
  test('appends the until clause when set', () => {
    const step: ChainStep = { agent: 'codex', model: 'gpt-6-luna', effort: 'medium', until: { usedPercent: 95, window: '5h' } }
    expect(stepText(step)).toBe('codex · gpt-6-luna · medium · until 5h at 95%')
  })
})

describe('step list editing', () => {
  const steps: ChainStep[] = [
    { agent: 'codex', model: 'gpt-6-luna', effort: 'medium' },
    { agent: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
  ]
  test('moveStep swaps a step with its neighbour', () => {
    expect(moveStep(steps, 0, 1).map((step) => step.agent)).toEqual(['claude', 'codex'])
  })
  test('moveStep does nothing past either end', () => {
    expect(moveStep(steps, 0, -1)).toBe(steps)
    expect(moveStep(steps, 1, 1)).toBe(steps)
  })
  test('withStep appends a step', () => {
    const next = withStep(steps, { agent: 'agy', model: 'gemini-3.1-pro-high' })
    expect(next).toHaveLength(3)
    expect(next[2]?.agent).toBe('agy')
  })
  test('withoutStep removes by index', () => {
    expect(withoutStep(steps, 0)).toEqual([steps[1] as ChainStep])
  })
})

describe('policyFromForm', () => {
  test('omits empty fields', () => {
    expect(policyFromForm({ maxAgents: '', minAvailableMib: '', maxPressure: '', maxContainerSuites: '' })).toEqual({})
  })
  test('validates and converts numeric fields', () => {
    const policy: AdmissionPolicy = policyFromForm({ maxAgents: '3', minAvailableMib: '2048', maxPressure: 'elevated', maxContainerSuites: '1' })
    expect(policy).toEqual({ maxAgents: 3, minAvailableMib: 2048, maxPressure: 'elevated', maxContainerSuites: 1 })
  })
  test('a non-numeric field throws rather than silently coercing', () => {
    expect(() => policyFromForm({ maxAgents: 'abc', minAvailableMib: '', maxPressure: '', maxContainerSuites: '' })).toThrow()
  })
})

describe('unused import guard', () => {
  test('a chain value type-checks against the fixtures used above', () => {
    const chain: Chain = { name: 'claude', when: { parentAgent: 'claude' }, steps: [] }
    expect(chain.name).toBe('claude')
  })
})
