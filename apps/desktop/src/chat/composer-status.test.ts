import { describe, expect, test } from 'bun:test'
import type { Settings, UsageReading } from '@/api/schema'
import { measuredModels } from '@/api/fixtures/models'
import {
  providerUsage,
  readingAge,
  staleNote,
  resetDistance,
  highestLimit,
  agentModels,
  contextChoice,
  contextMeter,
  contextUsage,
  contextWindow,
  defaultWindow,
  displayName,
  effortCommand,
  effortLevels,
  effortName,
  effortStep,
  findModel,
  formatTokens,
  groupModels,
  limitTone,
  usageLimitTone,
  menuGroups,
  modelCommand,
  modelDescriptor,
  modelHint,
  modelLabel,
  modelName,
  modelWindows,
  parseResetsAt,
  pickerLabel,
  resetText,
  sessionCommand,
  switchNeedsConfirm,
  switchTarget,
  withContextWindow,
  type ContextMeter,
} from '@/chat/composer-status'

type Models = Settings['models']

function reading(provider: string, window: string, usedPercent: number | null, resetsAt: string | null = '1000'): UsageReading {
  return { provider, window, status: usedPercent === null ? 'unknown' : 'current', usedPercent, resetsAt, fetchedAt: null, reason: '' }
}

function registry(agent: string, ids: string[], extra: Record<string, Record<string, unknown>> = {}): Models {
  return ids.map((model) => ({ agent, model, reasoning: { levels: ['low', 'high'] }, ...extra[model] }))
}

describe('formatTokens', () => {
  test('thousands as k and millions as M, one decimal only when it says something', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(412_000)).toBe('412k')
    expect(formatTokens(412_499)).toBe('412k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
    expect(formatTokens(200_000)).toBe('200k')
  })
})

describe('modelName', () => {
  test('the registry ids the person saw, as names', () => {
    const names: Record<string, string> = {
      'claude-sonnet-5': 'Sonnet 5',
      'claude-sonnet-4-6': 'Sonnet 4.6',
      'claude-opus-5': 'Opus 5',
      'claude-fable-5': 'Fable 5',
      'claude-fable-5-1': 'Fable 5.1',
      'claude-opus-4-8': 'Opus 4.8',
      'claude-opus-4-7': 'Opus 4.7',
      'claude-opus-4-6': 'Opus 4.6',
      'claude-opus-5-5': 'Opus 5.5',
      'claude-sonnet-5-5': 'Sonnet 5.5',
      'claude-mythos-preview': 'Mythos Preview',
    }
    for (const [id, name] of Object.entries(names)) expect(modelName(id)).toBe(name)
  })

  test('date suffixes go, and the old version-first ids read the same way', () => {
    expect(modelName('claude-opus-4-5-20251101')).toBe('Opus 4.5')
    expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('claude-opus-4-1-20250805')).toBe('Opus 4.1')
    expect(modelName('claude-opus-4-20250514')).toBe('Opus 4')
    expect(modelName('claude-sonnet-4-20250514')).toBe('Sonnet 4')
    expect(modelName('claude-3-7-sonnet-20250219')).toBe('Sonnet 3.7')
    expect(modelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
    expect(modelName('claude-3-haiku-20240307')).toBe('Haiku 3')
  })

  test('the 1M suffix is not part of the name', () => {
    expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  })

  test('other agents: GPT keeps its hyphen, other words are capitalised', () => {
    expect(modelName('gpt-6-luna')).toBe('GPT-6 Luna')
    expect(modelName('gpt-5.6-sol')).toBe('GPT-5.6 Sol')
    expect(modelName('gpt-5.5')).toBe('GPT-5.5')
    expect(modelName('gpt-5.3-codex-spark')).toBe('GPT-5.3 Codex Spark')
    expect(modelName('gpt-5.4-mini')).toBe('GPT-5.4 Mini')
    expect(modelName('gemini-3.8-flash-high')).toBe('Gemini 3.8 Flash High')
    expect(modelName('grok-4.7-build-fast')).toBe('Grok 4.7 Build Fast')
    expect(modelName('claude-opus-4-6-thinking')).toBe('Opus 4.6 Thinking')
    expect(modelName('opus')).toBe('Opus')
  })
})

describe('modelLabel', () => {
  test('the name, with the effort when set', () => {
    expect(modelLabel('claude-opus-5-5', 'high')).toBe('Opus 5.5 · high')
    expect(modelLabel('claude-opus-5-5', undefined)).toBe('Opus 5.5')
    expect(modelLabel('gpt-6-luna', null)).toBe('GPT-6 Luna')
  })

  test('an unknown model is Default', () => {
    expect(modelLabel(null, undefined)).toBe('Default')
    expect(modelLabel('', 'high')).toBe('Default')
  })
})

describe('groupModels', () => {
  test('the newest version of each family is current, the rest older, both in registry order', () => {
    const claude = registry(
      'claude',
      ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-fable-5-1', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'claude-3-haiku-20240307', 'claude-opus-5-5', 'claude-sonnet-5-5'],
    )
    const grouped = groupModels(claude)
    expect(grouped.current.map((model) => model.model)).toEqual(['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(grouped.older.map((model) => model.model)).toEqual(['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-5', 'claude-opus-4-5-20251101', 'claude-3-haiku-20240307'])
  })

  test('every model of the newest generation stays current', () => {
    const codex = registry('codex', ['gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.5', 'gpt-6-luna', 'gpt-6-sol'])
    expect(groupModels(codex).current.map((model) => model.model)).toEqual(['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'])
  })

  test('a model the registry marks retired or deprecated is older even when it is the only one of its family', () => {
    const claude = registry('claude', ['claude-opus-5-5', 'claude-mythos-preview', 'claude-haiku-4-5-20251001'], {
      'claude-mythos-preview': { status: 'deprecated' },
      'claude-haiku-4-5-20251001': { status: 'retired' },
    })
    const grouped = groupModels(claude)
    expect(grouped.current.map((model) => model.model)).toEqual(['claude-opus-5-5'])
    expect(grouped.older.map((model) => model.model)).toEqual(['claude-mythos-preview', 'claude-haiku-4-5-20251001'])
  })
})

describe('main models per agent, on the registry measured 2026-10-16', () => {
  const main = (agent: string) => groupModels(agentModels(measuredModels, agent)).current.map((model) => model.model)
  const older = (agent: string) => groupModels(agentModels(measuredModels, agent)).older.length

  test('Claude: the 5.5 family', () => {
    expect(main('claude')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-5', 'claude-haiku-5-5'])
    expect(older('claude')).toBe(18)
  })

  test('Codex: the gpt-6 family', () => {
    expect(main('codex')).toEqual(['gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol'])
    expect(older('codex')).toBe(9)
  })

  test('agy, after the fold: Gemini 4, Gemini 3.8, Claude Opus 5.5 and Claude Sonnet 5.5', () => {
    expect(main('agy')).toEqual(['gemini-4-argon', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(older('agy')).toBe(1)
  })

  test('Grok: the newest grok, standard and fast', () => {
    expect(main('grok')).toEqual(['grok-4.7', 'grok-4.7-build-fast'])
    expect(older('grok')).toBe(2)
  })

  test('a newer point release takes its line over, the rest of the generation stays', () => {
    const codex = registry('codex', ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-terra'])
    expect(groupModels(codex).current.map((model) => model.model)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
  })

  test('a model with no version to rank is older', () => {
    expect(groupModels(registry('agy', ['gpt-oss-120b', 'gemini-4-argon'])).older.map((model) => model.model)).toEqual(['gpt-oss-120b'])
  })
})

describe('withContextWindow', () => {
  test('1M adds the suffix once and standard takes it off', () => {
    expect(withContextWindow('claude-opus-5-5', '1m')).toBe('claude-opus-5-5[1m]')
    expect(withContextWindow('claude-opus-5-5[1m]', '1m')).toBe('claude-opus-5-5[1m]')
    expect(withContextWindow('claude-opus-5-5[1m]', 'standard')).toBe('claude-opus-5-5')
    expect(withContextWindow('claude-opus-5-5', 'standard')).toBe('claude-opus-5-5')
  })
})

describe('contextWindow', () => {
  const models = [
    ...registry('claude', ['claude-opus-5-5', 'claude-sonnet-5-5'], { 'claude-sonnet-5-5': { contextWindow: 1_000_000 } }),
    ...registry('codex', ['gpt-6-luna', 'gpt-6-sol'], { 'gpt-6-sol': { contextWindow: 400_000 } }),
    ...registry('grok', ['grok-4.7'], { 'grok-4.7': { contextWindow: 256_000 } }),
  ]

  test('the window the chat reports wins and is not derived', () => {
    expect(contextWindow(500_000, 'claude', 'claude-opus-5-5', models)).toEqual({ tokens: 500_000, derived: false })
  })

  test('the 1M suffix gives 1M', () => {
    expect(contextWindow(null, 'claude', 'claude-opus-5-5[1m]', models)).toEqual({ tokens: 1_000_000, derived: true })
  })

  test('the registry window comes before the agent default', () => {
    expect(contextWindow(undefined, 'claude', 'claude-sonnet-5-5', models)).toEqual({ tokens: 1_000_000, derived: true })
    expect(contextWindow(null, 'codex', 'gpt-6-sol', models)).toEqual({ tokens: 400_000, derived: true })
    expect(contextWindow(null, 'grok', 'grok-4.7', models)).toEqual({ tokens: 256_000, derived: true })
  })

  test('Claude is 200k and Codex 272k otherwise', () => {
    expect(contextWindow(null, 'claude', 'claude-opus-5-5', models)).toEqual({ tokens: 200_000, derived: true })
    expect(contextWindow(null, 'claude', null, models)).toEqual({ tokens: 200_000, derived: true })
    expect(contextWindow(null, 'codex', 'gpt-6-luna', models)).toEqual({ tokens: 272_000, derived: true })
  })

  test('an agent with no known window has none', () => {
    expect(contextWindow(null, 'grok', 'grok-9', models)).toBeNull()
    expect(contextWindow(null, null, null, models)).toBeNull()
  })
})

describe('contextChoice', () => {
  test('a window of 1M or more is the 1M choice', () => {
    expect(contextChoice({ tokens: 1_000_000, derived: true })).toBe('1m')
    expect(contextChoice({ tokens: 200_000, derived: true })).toBe('standard')
    expect(contextChoice(null)).toBe('standard')
  })
})

describe('contextUsage', () => {
  test('tokens of the window, with the share used and its tone', () => {
    expect(contextUsage(412_000, 1_000_000)).toEqual({ label: '412k / 1M', fraction: 0.412, tone: 'normal' })
    expect(contextUsage(380_000, 1_000_000)?.label).toBe('380k / 1M')
  })

  test('amber above 80 percent of the window, red above 95', () => {
    expect(contextUsage(170_000, 200_000)?.tone).toBe('amber')
    expect(contextUsage(195_000, 200_000)?.tone).toBe('red')
  })

  test('without a window, the tokens alone and no share', () => {
    expect(contextUsage(412_000, null)).toEqual({ label: '412k', fraction: null, tone: 'normal' })
    expect(contextUsage(412_000, undefined)).toEqual({ label: '412k', fraction: null, tone: 'normal' })
  })

  test('the share never passes the whole bar', () => {
    expect(contextUsage(1_200_000, 1_000_000)?.fraction).toBe(1)
  })

  test('unknown tokens hide it', () => {
    expect(contextUsage(null, 1_000_000)).toBeNull()
    expect(contextUsage(undefined, undefined)).toBeNull()
  })
})

describe('limitTone', () => {
  test('amber above 80 percent, red above 95', () => {
    expect(limitTone(80)).toBe('normal')
    expect(limitTone(80.1)).toBe('amber')
    expect(limitTone(95)).toBe('amber')
    expect(limitTone(95.1)).toBe('red')
  })
})

describe('usageLimitTone', () => {
  test('warning above 70 percent, critical above 90, sooner than the context meter', () => {
    expect(usageLimitTone(0)).toBe('normal')
    expect(usageLimitTone(70)).toBe('normal')
    expect(usageLimitTone(70.1)).toBe('amber')
    expect(usageLimitTone(90)).toBe('amber')
    expect(usageLimitTone(90.1)).toBe('red')
    expect(usageLimitTone(100)).toBe('red')
  })

  test('a provider limit takes its tone from the usage rule', () => {
    const [usage] = providerUsage([reading('claude', '5h', 75, null), reading('claude', 'weekly', 92, null)])
    expect(usage?.limits.map((limit) => limit.tone)).toEqual(['amber', 'red'])
  })
})

describe('parseResetsAt', () => {
  test('unix seconds in a string, as Codex reports it', () => {
    expect(parseResetsAt('1792100312')?.getTime()).toBe(1_792_100_312_000)
  })

  test('an ISO date with microseconds and an offset, as Claude reports it', () => {
    expect(parseResetsAt('2026-10-15T21:19:59.608999+00:00')?.getTime()).toBe(Date.UTC(2026, 9, 15, 21, 19, 59, 608))
    expect(parseResetsAt('2026-10-15T21:19:59Z')?.getTime()).toBe(Date.UTC(2026, 9, 15, 21, 19, 59))
  })

  test('anything else is unknown, never NaN', () => {
    expect(parseResetsAt('soon')).toBeNull()
    expect(parseResetsAt('')).toBeNull()
    expect(parseResetsAt('12abc')).toBeNull()
    expect(parseResetsAt(null)).toBeNull()
  })
})

describe('resetText', () => {
  const now = new Date(2026, 9, 15, 12, 0, 0)
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000)

  test('hours and minutes within a day', () => {
    expect(resetText(later(134), now)).toBe('resets 2h 14m')
    expect(resetText(later(16), now)).toBe('resets 16m')
    expect(resetText(later(23 * 60), now)).toBe('resets 23h 0m')
  })

  test('part of a minute counts as a minute, and a past reset is now', () => {
    expect(resetText(new Date(now.getTime() + 30_000), now)).toBe('resets 1m')
    expect(resetText(later(-5), now)).toBe('resets now')
  })

  test('a day or more away, the weekday', () => {
    expect(resetText(new Date(2026, 9, 16, 12, 0, 0), now)).toBe('resets Fri')
    expect(resetText(new Date(2026, 9, 18, 9, 30, 0), now)).toBe('resets Sun')
  })
})

describe('highestLimit', () => {
  const limit = (window: string, usedPercent: number) => ({ window, usedPercent, tone: 'normal' as const, resets: null, resetsAt: null })

  test('the window with the highest use', () => {
    expect(highestLimit([limit('5h', 13), limit('weekly', 37)])?.window).toBe('weekly')
    expect(highestLimit([limit('5h', 91), limit('weekly', 37)])?.window).toBe('5h')
  })

  test('a tie keeps the first window', () => {
    expect(highestLimit([limit('5h', 40), limit('weekly', 40)])?.window).toBe('5h')
  })

  test('no limits, no ring', () => {
    expect(highestLimit([])).toBeNull()
  })
})

describe('agentModels', () => {
  const models: Models = [
    { agent: 'codex', model: 'gpt-6-luna', reasoning: { levels: ['low', 'high'] } },
    { agent: 'claude', model: 'claude-sonnet-5', reasoning: { levels: ['low', 'medium', 'high'] } },
    { agent: 'claude', model: 'claude-opus-5', reasoning: { levels: [] } },
  ]

  test("only the chat's agent's models, in the registry's order", () => {
    expect(agentModels(models, 'claude').map((model) => model.model)).toEqual(['claude-sonnet-5', 'claude-opus-5'])
    expect(agentModels(models, null)).toEqual([])
  })
})

describe('registry names, windows and the current flag', () => {
  const models = registry('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'], {
    'claude-opus-5-5': { name: 'Opus 5.5', contextWindows: [200_000, 1_000_000], current: true },
    'claude-sonnet-5-5': { contextWindows: [200_000], current: true },
    'claude-opus-5': { current: false },
    'claude-haiku-4-5-20251001': { current: false },
  })

  test('the registry name wins over the one read from the id', () => {
    expect(displayName('claude-opus-5-5[1m]', models)).toBe('Opus 5.5')
    expect(displayName('claude-sonnet-5-5', models)).toBe('Sonnet 5.5')
    expect(displayName('claude-unknown-9', models)).toBe('Unknown 9')
  })

  test('a registry name that is only a version reads with its family from the id', () => {
    const grok = registry('grok', ['grok-4.7', 'grok-4.7-build-fast'], { 'grok-4.7': { name: '4.7' }, 'grok-4.7-build-fast': { name: '4.7 Build Fast' } })
    expect(displayName('grok-4.7', grok)).toBe('Grok 4.7')
    expect(displayName('grok-4.7-build-fast', grok)).toBe('Grok 4.7 Build Fast')
    const legacy = registry('claude', ['claude-3-7-sonnet-20250219'], { 'claude-3-7-sonnet-20250219': { name: '3.7 Sonnet' } })
    expect(displayName('claude-3-7-sonnet-20250219', legacy)).toBe('Sonnet 3.7')
  })

  test('a current flag an older registry still carries does not override the rule', () => {
    const grouped = groupModels(models)
    expect(grouped.current.map((model) => model.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001'])
    expect(grouped.older.map((model) => model.model)).toEqual(['claude-opus-5'])
  })

  test('the windows a model supports: the registry list, else 200k and 1M for Claude, else its one window', () => {
    expect(modelWindows(models[0], 'claude')).toEqual([200_000, 1_000_000])
    expect(modelWindows(models[1], 'claude')).toEqual([200_000])
    expect(modelWindows(models[2], 'claude')).toEqual([200_000, 1_000_000])
    expect(modelWindows(undefined, 'claude')).toEqual([200_000, 1_000_000])
    expect(modelWindows({ agent: 'codex', model: 'gpt-6-sol', reasoning: { levels: [] }, contextWindow: 400_000 }, 'codex')).toEqual([400_000])
    expect(modelWindows(undefined, 'codex')).toEqual([272_000])
    expect(modelWindows(undefined, 'grok')).toEqual([])
  })
})

describe('modelDescriptor', () => {
  test("the registry's own description, else the family's hint, else what the model offers", () => {
    expect(modelDescriptor({ agent: 'grok', model: 'grok-4.7', reasoning: { levels: ['low', 'high'] }, description: "SpaceXAI's latest frontier model" }, 'grok')).toBe("SpaceXAI's latest frontier model")
    expect(modelDescriptor({ agent: 'claude', model: 'claude-opus-5-5', reasoning: { levels: [] } }, 'claude')).toBe('Most capable')
    expect(modelDescriptor({ agent: 'agy', model: 'gemini-3.8-flash', reasoning: { levels: ['low', 'medium', 'high'] } }, 'agy')).toBe('Fastest')
    expect(modelDescriptor({ agent: 'claude', model: 'claude-fable-5-5', reasoning: { levels: ['low'] }, contextWindows: [200_000, 1_000_000] }, 'claude')).toBe('Up to 1M context')
    expect(modelDescriptor({ agent: 'agy', model: 'gemini-4-argon', reasoning: { levels: ['low', 'medium', 'high'] } }, 'agy')).toBe('Low to High effort')
    expect(modelDescriptor({ agent: 'agy', model: 'gpt-oss-120b', reasoning: { levels: ['medium'] } }, 'agy')).toBeNull()
  })

  test('Codex tiers say what each is for, as Codex itself describes them', () => {
    expect(modelDescriptor({ agent: 'codex', model: 'gpt-6-luna', reasoning: { levels: [] } }, 'codex')).toBe('Fast and affordable')
    expect(modelDescriptor({ agent: 'codex', model: 'gpt-6-sol', reasoning: { levels: [] } }, 'codex')).toBe('Everyday workhorse')
    expect(modelDescriptor({ agent: 'codex', model: 'gpt-6-astra', reasoning: { levels: [] } }, 'codex')).toBe('Frontier intelligence')
  })
})

describe('the context window a pick starts with', () => {
  test('1M wherever the model supports it, else its first window', () => {
    expect(defaultWindow([200_000, 1_000_000])).toBe(1_000_000)
    expect(defaultWindow([256_000, 500_000])).toBe(256_000)
    expect(defaultWindow([272_000])).toBe(272_000)
    expect(defaultWindow([])).toBeNull()
  })

  test('switching to a model that supports 1M lands on 1M, even from 200k', () => {
    const windows = modelWindows(findModel(measuredModels, 'claude-opus-5-5'), 'claude')
    expect(switchTarget('claude-opus-5-5', windows, defaultWindow(windows))).toEqual({ model: 'claude-opus-5-5[1m]', window: 1_000_000 })
    const haiku = modelWindows(findModel(measuredModels, 'claude-haiku-4-5-20251001'), 'claude')
    expect(switchTarget('claude-haiku-4-5-20251001', haiku, defaultWindow(haiku))).toEqual({ model: 'claude-haiku-4-5-20251001', window: 200_000 })
  })
})

describe('the effort slider', () => {
  const stops = (agent: string, id: string) => effortLevels(findModel(agentModels(measuredModels, agent), id), agent, true).map(effortName)

  test('one stop per level the selected model supports, with its full name', () => {
    expect(stops('claude', 'claude-opus-5-5[1m]')).toEqual(['Low', 'Medium', 'High', 'X-High', 'Max'])
    expect(stops('codex', 'gpt-6-astra')).toEqual(['Low', 'Medium', 'High', 'X-High', 'Max', 'Ultra'])
    expect(stops('codex', 'gpt-6-luna')).toEqual(['Low', 'Medium', 'High', 'X-High', 'Max'])
    expect(stops('agy', 'gemini-4-argon')).toEqual(['Low', 'Medium', 'High'])
    expect(stops('grok', 'grok-4.5')).toEqual(['Low', 'Medium', 'High'])
    expect(stops('grok', 'grok-4.7')).toEqual(['Low', 'Medium', 'High', 'X-High'])
  })

  test('arrows move one stop and stop at the ends; Home and End jump; other keys do nothing', () => {
    const levels = ['low', 'medium', 'high']
    expect(effortStep(levels, 'medium', 'ArrowRight')).toBe('high')
    expect(effortStep(levels, 'medium', 'ArrowUp')).toBe('high')
    expect(effortStep(levels, 'medium', 'ArrowLeft')).toBe('low')
    expect(effortStep(levels, 'medium', 'ArrowDown')).toBe('low')
    expect(effortStep(levels, 'high', 'ArrowRight')).toBe('high')
    expect(effortStep(levels, 'low', 'ArrowLeft')).toBe('low')
    expect(effortStep(levels, 'medium', 'Home')).toBe('low')
    expect(effortStep(levels, 'low', 'End')).toBe('high')
    expect(effortStep(levels, undefined, 'ArrowRight')).toBe('low')
    expect(effortStep(levels, 'medium', 'Enter')).toBeNull()
    expect(effortStep([], undefined, 'ArrowRight')).toBeNull()
  })
})

describe('modelHint', () => {
  test('one line on what each family is for, nothing for one it does not know', () => {
    expect(modelHint('claude-haiku-4-5-20251001')).toBe('Fastest')
    expect(modelHint('claude-sonnet-5-5')).toBe('Balanced')
    expect(modelHint('claude-opus-5-5[1m]')).toBe('Most capable')
    expect(modelHint('gpt-5.4-mini')).toBe('Fastest')
    expect(modelHint('grok-4.7')).toBeNull()
  })
})

describe('pickerLabel', () => {
  test('name, window and effort, each only when known', () => {
    expect(pickerLabel('Opus 5.5', 1_000_000, 'high')).toBe('Opus 5.5 · 1M · high')
    expect(pickerLabel('Opus 5.5', 200_000, undefined)).toBe('Opus 5.5 · 200k')
    expect(pickerLabel('GPT-6 Luna', null, 'medium')).toBe('GPT-6 Luna · medium')
    expect(pickerLabel(null, 200_000, undefined)).toBe('Default · 200k')
  })
})

describe('switching model', () => {
  test('the /model command for each window: the 1M window adds the suffix, any other takes it off', () => {
    expect(modelCommand('claude-opus-5-5', 1_000_000)).toBe('/model claude-opus-5-5[1m]')
    expect(modelCommand('claude-opus-5-5[1m]', 200_000)).toBe('/model claude-opus-5-5')
    expect(modelCommand('claude-sonnet-5-5', null)).toBe('/model claude-sonnet-5-5')
    expect(modelCommand('gpt-6-luna', 272_000)).toBe('/model gpt-6-luna')
  })

  test('a picked model keeps the window in use when it supports it, else takes its first', () => {
    expect(switchTarget('claude-sonnet-5-5', [200_000, 1_000_000], 1_000_000)).toEqual({ model: 'claude-sonnet-5-5[1m]', window: 1_000_000 })
    expect(switchTarget('claude-sonnet-5-5', [200_000], 1_000_000)).toEqual({ model: 'claude-sonnet-5-5', window: 200_000 })
    expect(switchTarget('claude-opus-5-5[1m]', [200_000, 1_000_000], 200_000)).toEqual({ model: 'claude-opus-5-5', window: 200_000 })
    expect(switchTarget('gpt-6-luna', [], null)).toEqual({ model: 'gpt-6-luna', window: null })
  })

  test('a switch asks first only when the chat already has context and the model really changes', () => {
    expect(switchNeedsConfirm('claude-opus-5-5', 'claude-sonnet-5-5', 380_000)).toBe(true)
    expect(switchNeedsConfirm('claude-opus-5-5', 'claude-opus-5-5[1m]', 1)).toBe(true)
    expect(switchNeedsConfirm(null, 'claude-opus-5-5', 12)).toBe(true)
    expect(switchNeedsConfirm('claude-opus-5-5', 'claude-sonnet-5-5', 0)).toBe(false)
    expect(switchNeedsConfirm('claude-opus-5-5', 'claude-sonnet-5-5', null)).toBe(false)
    expect(switchNeedsConfirm('claude-opus-5-5', 'claude-sonnet-5-5', undefined)).toBe(false)
    expect(switchNeedsConfirm('claude-opus-5-5', 'claude-opus-5-5', 380_000)).toBe(false)
  })
})

describe('effort', () => {
  const models: Models = [
    { agent: 'claude', model: 'claude-opus-5-5', reasoning: { levels: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    { agent: 'claude', model: 'claude-haiku-4-5', reasoning: { levels: [] } },
    { agent: 'codex', model: 'gpt-6-luna', reasoning: { levels: ['low', 'medium', 'high'] } },
  ]

  test('the picker offers the levels the registry lists for the model, whatever its window', () => {
    expect(effortLevels(findModel(models, 'claude-opus-5-5[1m]'), 'claude', false)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortLevels(findModel(models, 'claude-haiku-4-5'), 'claude', false)).toEqual([])
    expect(effortLevels(undefined, 'claude', false)).toEqual([])
  })

  test('a native chat sets effort itself; a running session only when its agent takes a command for it', () => {
    expect(effortLevels(findModel(models, 'gpt-6-luna'), 'codex', true)).toEqual(['low', 'medium', 'high'])
    expect(effortLevels(findModel(models, 'gpt-6-luna'), 'codex', false)).toEqual([])
    expect(effortLevels(findModel(models, 'claude-opus-5-5'), 'claude', true)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('Claude takes /effort <level>; Codex and the others have no command for it', () => {
    expect(effortCommand('claude', 'high')).toBe('/effort high')
    expect(effortCommand('claude', 'xhigh')).toBe('/effort xhigh')
    expect(effortCommand('codex', 'high')).toBeNull()
    expect(effortCommand('grok', 'high')).toBeNull()
    expect(effortCommand(null, 'high')).toBeNull()
  })

  test('a running session gets /effort when only the effort changes, /model when the model or window does', () => {
    expect(sessionCommand('claude', 'claude-opus-5-5[1m]', { model: 'claude-opus-5-5[1m]', window: 1_000_000, effort: 'high' })).toBe('/effort high')
    expect(sessionCommand('claude', 'claude-opus-5-5', { model: 'claude-sonnet-5-5', window: 200_000, effort: 'high' })).toBe('/model claude-sonnet-5-5')
    expect(sessionCommand('claude', 'claude-opus-5-5', { model: 'claude-opus-5-5[1m]', window: 1_000_000, effort: undefined })).toBe('/model claude-opus-5-5[1m]')
    expect(sessionCommand('claude', null, { model: 'claude-opus-5-5', window: 200_000, effort: undefined })).toBe('/model claude-opus-5-5')
    expect(sessionCommand('codex', 'gpt-6-luna', { model: 'gpt-6-luna', window: 272_000, effort: 'high' })).toBeNull()
  })

  test('the label carries the effort picked', () => {
    expect(pickerLabel('Opus 5.5', 1_000_000, 'high')).toBe('Opus 5.5 · 1M · high')
  })

  test('changing only the effort keeps the prompt cache, so it never asks first', () => {
    expect(switchNeedsConfirm('claude-opus-5-5[1m]', 'claude-opus-5-5[1m]', 380_000)).toBe(false)
  })
})

describe('session model names', () => {
  const ids = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-luna']
  const expected: Record<string, string> = {
    'claude-opus-5-5': 'Opus 5.5',
    'claude-opus-5-5[1m]': 'Opus 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5',
    'gpt-6-luna': 'GPT-6 Luna',
  }

  test('a registry name that is only the id is no name: the name is read from the id', () => {
    // The CLI fills a missing name with the id itself.
    const models = ids.map((model) => ({ agent: model.startsWith('gpt') ? 'codex' : 'claude', model, name: model, reasoning: { levels: [] } }))
    for (const [id, name] of Object.entries(expected)) expect(displayName(id, models)).toBe(name)
  })

  test('with no name, an empty one or no entry at all, the name is read from the id', () => {
    const models = ids.map((model, index) => ({ agent: 'claude', model, reasoning: { levels: [] }, ...(index === 0 ? { name: '' } : {}) }))
    for (const [id, name] of Object.entries(expected)) {
      expect(displayName(id, models)).toBe(name)
      expect(displayName(id, [])).toBe(name)
    }
  })

  test('a real registry name still wins', () => {
    const models = [{ agent: 'claude', model: 'claude-opus-5-5', name: 'Opus 5.5 (preview)', reasoning: { levels: [] } }]
    expect(displayName('claude-opus-5-5[1m]', models)).toBe('Opus 5.5 (preview)')
  })
})

describe('menuGroups', () => {
  // Haiku 4.5 is the newest haiku here, so it is retired to stay older.
  const models = registry('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'], {
    'claude-haiku-4-5-20251001': { status: 'retired' },
  })
  const ids = (list: Models) => list.map((model) => model.model)

  test('with a current model in use, nothing is pulled out of the older group', () => {
    const groups = menuGroups(models, 'claude-opus-5-5[1m]')
    expect(ids(groups.current)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(groups.selected).toBeNull()
    expect(ids(groups.older)).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001'])
  })

  test('an older model in use shows on its own above the group and leaves it', () => {
    const groups = menuGroups(models, 'claude-opus-5[1m]')
    expect(groups.selected?.model).toBe('claude-opus-5')
    expect(ids(groups.older)).toEqual(['claude-haiku-4-5-20251001'])
  })

  test('with no model or an unknown one, the groups are the plain grouping', () => {
    for (const id of [null, '', 'claude-unknown-9']) {
      const groups = menuGroups(models, id)
      expect(groups.selected).toBeNull()
      expect(ids(groups.older)).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001'])
    }
  })
})

describe('contextMeter', () => {
  test('known tokens of a reported window: short text, share, tone and the exact count', () => {
    expect(contextMeter(341_250, { tokens: 1_000_000, derived: false })).toEqual({
      text: '341k / 1M',
      fraction: 0.34125,
      tone: 'normal',
      title: 'Context used: 341,250 of 1,000,000 tokens (34%)',
    })
  })

  test('a window taken from the model says so', () => {
    expect(contextMeter(170_000, { tokens: 200_000, derived: true })).toEqual({
      text: '170k / 200k',
      fraction: 0.85,
      tone: 'amber',
      title: 'Context used: 170,000 of 200,000 tokens (85%). Window from the model; the chat does not report it.',
    })
  })

  test('tokens without a window: the count alone and no share', () => {
    expect(contextMeter(41_000, null)).toEqual({ text: '41k', fraction: null, tone: 'normal', title: 'Context used: 41,000 tokens. Window unknown.' })
  })

  test('unknown tokens show a dash, never nothing', () => {
    const unknown: ContextMeter = { text: '—', fraction: null, tone: 'normal', title: 'Context used: not reported yet' }
    expect(contextMeter(null, { tokens: 1_000_000, derived: false })).toEqual(unknown)
    expect(contextMeter(undefined, null)).toEqual(unknown)
  })
})

describe('effortName', () => {
  test('an effort level as the menu labels it', () => {
    expect(['low', 'medium', 'high', 'xhigh', 'max'].map(effortName)).toEqual(['Low', 'Medium', 'High', 'X-High', 'Max'])
    expect(effortName('minimal')).toBe('Minimal')
  })
})

describe('providerUsage', () => {
  const at = (fetchedAt: number | null, item: UsageReading): UsageReading => ({ ...item, fetchedAt })

  test('each provider with a share once, in the order the readings name them, its highest window picked', () => {
    const usage = providerUsage([reading('codex', '5h', 17), reading('claude', '5h', 4), reading('codex', 'weekly', 66), reading('claude', 'weekly', 88), reading('grok', '5h', null)])
    expect(usage.map((item) => [item.agent, item.highest.window, item.highest.usedPercent])).toEqual([
      ['codex', 'weekly', 66],
      ['claude', 'weekly', 88],
    ])
  })

  test('a tie keeps the first window, 5-hour before weekly', () => {
    expect(providerUsage([reading('codex', 'weekly', 40), reading('codex', '5h', 40)])[0]?.highest.window).toBe('5h')
  })

  test('rows go 5-hour, weekly, then any other window in reading order, a window without a share left out', () => {
    const usage = providerUsage([reading('claude', 'opus-weekly', 12), reading('claude', 'weekly', 30), reading('claude', 'monthly', null), reading('claude', 'daily', 5), reading('claude', '5h', 9)])
    expect(usage[0]?.limits.map((limit) => limit.window)).toEqual(['5h', 'weekly', 'opus-weekly', 'daily'])
  })

  test('a window outside 5-hour and weekly can be the highest', () => {
    expect(providerUsage([reading('claude', '5h', 10), reading('claude', 'opus-weekly', 93)])[0]?.highest).toMatchObject({ window: 'opus-weekly', tone: 'red' })
  })

  test('the snapshot is the newest reading of the provider, null when none says', () => {
    const usage = providerUsage([at(100, reading('codex', '5h', 1)), at(250, reading('codex', 'weekly', 2)), at(null, reading('claude', '5h', 3))])
    expect(usage.map((item) => item.fetchedAt)).toEqual([250, null])
  })

  test('nothing to show without a share', () => {
    expect(providerUsage([])).toEqual([])
    expect(providerUsage([reading('grok', '5h', null), reading('grok', 'weekly', null)])).toEqual([])
  })
})

describe('readingAge', () => {
  const now = new Date(1_000_000_000)
  test('how long ago a snapshot was read, from unix seconds', () => {
    expect([999_990, 999_700, 999_000 - 7200, 1_000_000 - 3 * 86_400].map((seconds) => readingAge(seconds, now))).toEqual(['just now', '5m ago', '2h ago', '3d ago'])
  })

  test('null when the reading has no time, and just now for a clock slightly ahead', () => {
    expect(readingAge(null, now)).toBeNull()
    expect(readingAge(1_000_030, now)).toBe('just now')
  })
})

describe('resetDistance', () => {
  const now = new Date(Date.UTC(2026, 9, 16, 12, 0))
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000)
  test('minutes, hours and minutes within a day, days and hours beyond', () => {
    expect([later(9), later(65), later(23 * 60 + 59), later(3 * 1440 + 4 * 60 + 30)].map((at) => resetDistance(at, now))).toEqual(['in 9m', 'in 1h 5m', 'in 23h 59m', 'in 3d 4h'])
  })
  test('a reset already past is now', () => {
    expect(resetDistance(later(-5), now)).toBe('now')
  })
})

describe('stale usage', () => {
  const stale = (usedPercent: number | null, retryAt: number | null): UsageReading => ({ ...reading('claude', '5h', usedPercent), status: 'stale', reason: 'claude 5h window is stale (provider returned HTTP 429)', retryAt })

  test('a stale provider keeps its readings and says why and when it retries', () => {
    const [usage] = providerUsage([stale(5, 1_000_240)])
    expect(usage?.highest.usedPercent).toBe(5)
    expect(usage?.stale).toEqual({ reason: expect.stringContaining('429'), retryAt: 1_000_240 })
    expect(staleNote(usage?.stale ?? null, new Date(1_000_000_000))).toBe('rate limited, retrying in 4m')
  })

  test('a current provider has no note, and a past or unknown retry just says retrying', () => {
    expect(providerUsage([reading('claude', '5h', 5)])[0]?.stale).toBeNull()
    expect(staleNote(null)).toBeNull()
    expect(staleNote({ reason: 'claude 5h window is stale (provider returned HTTP 429)', retryAt: null })).toBe('rate limited, retrying')
    expect(staleNote({ reason: 'x (request timed out)', retryAt: 10 }, new Date(20_000))).toBe('unavailable, retrying')
  })
})
