import { describe, expect, test } from 'bun:test'
import type { Settings } from '@/api/schema'
import { measuredModels } from '@/api/fixtures/models'
import {
  defaultModelSettings,
  levelList,
  modelCards,
  parseModelSettings,
  serialiseModelSettings,
  windowList,
  withAgentDefault,
  withModelEnabled,
  type ModelSettings,
} from '@/settings/models-model'

type Models = Settings['models']

describe('parseModelSettings', () => {
  test('nothing saved is no toggles and no defaults', () => {
    expect(parseModelSettings(null)).toEqual(defaultModelSettings)
    expect(defaultModelSettings).toEqual({ version: 1, models: {}, defaults: {} })
  })

  test('a saved form reads back as written, and unusable fields are dropped one by one', () => {
    const saved: ModelSettings = { version: 1, models: { 'codex/gpt-6-sol': true }, defaults: { codex: { model: 'gpt-6-luna', effort: 'medium' } } }
    expect(parseModelSettings(JSON.parse(serialiseModelSettings(saved)))).toEqual(saved)
    expect(parseModelSettings({ version: 1, models: { 'codex/a': 'yes', 'codex/b': false }, defaults: { codex: { model: 7 }, grok: { model: 'grok-4.7', effort: null } } })).toEqual({
      version: 1,
      models: { 'codex/b': false },
      defaults: { grok: { model: 'grok-4.7', effort: null } },
    })
  })
})

describe('changes', () => {
  test('toggling a model records it under agent/model', () => {
    expect(withModelEnabled(defaultModelSettings, 'codex', 'gpt-6-sol', true)).toEqual({ version: 1, models: { 'codex/gpt-6-sol': true }, defaults: {} })
  })

  test('turning off the agent default clears that default', () => {
    const settings: ModelSettings = { version: 1, models: {}, defaults: { codex: { model: 'gpt-6-luna', effort: null } } }
    expect(withModelEnabled(settings, 'codex', 'gpt-6-luna', false)).toEqual({ version: 1, models: { 'codex/gpt-6-luna': false }, defaults: {} })
  })

  test('a default is set with its effort, and cleared with null', () => {
    const set = withAgentDefault(defaultModelSettings, 'codex', 'gpt-6-luna', 'high')
    expect(set.defaults).toEqual({ codex: { model: 'gpt-6-luna', effort: 'high' } })
    expect(withAgentDefault(set, 'codex', null, null).defaults).toEqual({})
  })
})

describe('modelCards', () => {
  const cards = modelCards(measuredModels, '')
  const card = (agent: string) => cards.find((item) => item.agent === agent)

  test('one card per agent, in the app order, current models then older ones', () => {
    expect(cards.map((item) => item.agent)).toEqual(['claude', 'codex', 'grok', 'agy'])
    expect(card('claude')?.current.map((model) => model.model)).toEqual(['claude-fable-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    expect(card('claude')?.older).toHaveLength(18)
    expect(card('codex')?.current.map((model) => model.model)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'])
  })

  test('counts say how many are on of how many there are', () => {
    expect(card('claude')?.counts).toEqual({ enabled: 4, total: 22 })
    expect(card('codex')?.counts).toEqual({ enabled: 3, total: 13 })
  })

  test('search matches the name, the id and the best-for line, and drops cards with nothing left', () => {
    const found = modelCards(measuredModels, 'luna')
    expect(found.map((item) => item.agent)).toEqual(['codex'])
    expect([...found[0]!.current, ...found[0]!.older].map((model) => model.model)).toEqual(['gpt-6-luna', 'gpt-5.6-luna'])
    expect(modelCards(measuredModels, 'OPUS 5.5').map((item) => item.agent)).toEqual(['claude', 'agy'])
    expect(modelCards(measuredModels, 'quick edits').length).toBeGreaterThan(0)
    expect(modelCards(measuredModels, 'zzz')).toEqual([])
  })

  test('a model without the enabled flag, from an older CLI, counts as on', () => {
    const models: Models = [{ agent: 'codex', model: 'gpt-6-luna', reasoning: { levels: ['low'] } }]
    expect(modelCards(models, '')[0]?.counts).toEqual({ enabled: 1, total: 1 })
  })
})

describe('readable lists', () => {
  test('levels as names joined by a dot, none as a phrase', () => {
    expect(levelList(['low', 'medium', 'high', 'xhigh', 'max'])).toBe('Low · Medium · High · X-High · Max')
    expect(levelList([])).toBe('No effort setting')
  })

  test('windows as short sizes', () => {
    expect(windowList([200_000, 1_000_000])).toBe('200k · 1M')
    expect(windowList([])).toBeNull()
  })
})
