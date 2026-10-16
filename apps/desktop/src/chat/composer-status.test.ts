import { describe, expect, test } from 'bun:test'
import type { Settings, UsageReading } from '@/api/schema'
import {
  agentLimits,
  agentModels,
  contextChoice,
  contextMeter,
  contextUsage,
  contextWindow,
  displayName,
  effortCommand,
  effortLevels,
  effortName,
  findModel,
  formatTokens,
  groupModels,
  limitTone,
  usageLimitTone,
  menuGroups,
  modelCommand,
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

  test('an agent limit takes its tone from the usage rule', () => {
    const limits = agentLimits([reading('claude', '5h', 75, null), reading('claude', 'weekly', 92, null)], 'claude')
    expect(limits.map((limit) => limit.tone)).toEqual(['amber', 'red'])
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

describe('agentLimits', () => {
  const readings = [reading('claude', '5h', 4, '2026-10-15T12:16:00Z'), reading('claude', 'weekly', 88, '9000'), reading('codex', '5h', 17, 'soon'), reading('grok', '5h', null), reading('grok', 'weekly', null)]
  const now = new Date(Date.UTC(2026, 9, 15, 12, 0, 0))

  test("the agent's 5h and weekly readings, with tone and reset time from either form", () => {
    const limits = agentLimits(readings, 'claude', now)
    expect(limits.map(({ window, usedPercent, tone, resets }) => ({ window, usedPercent, tone, resets }))).toEqual([
      { window: '5h', usedPercent: 4, tone: 'normal', resets: 'resets 16m' },
      { window: 'weekly', usedPercent: 88, tone: 'amber', resets: 'resets now' },
    ])
    expect(limits[0]?.resetsAt?.getTime()).toBe(Date.UTC(2026, 9, 15, 12, 16))
    expect(limits[1]?.resetsAt?.getTime()).toBe(9_000_000)
  })

  test('an unparsable reset hides the reset text', () => {
    expect(agentLimits(readings, 'codex', now)).toEqual([{ window: '5h', usedPercent: 17, tone: 'normal', resets: null, resetsAt: null }])
  })

  test('a missing reading is left out', () => {
    expect(agentLimits(readings, 'grok', now)).toEqual([])
    expect(agentLimits(readings, 'agy', now)).toEqual([])
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

  test('the registry current flag decides the groups when it is there', () => {
    const grouped = groupModels(models)
    expect(grouped.current.map((model) => model.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(grouped.older.map((model) => model.model)).toEqual(['claude-opus-5', 'claude-haiku-4-5-20251001'])
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
  const models = registry('claude', ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'], {
    'claude-opus-5-5': { current: true },
    'claude-sonnet-5-5': { current: true },
    'claude-opus-5': { current: false },
    'claude-haiku-4-5-20251001': { current: false },
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
