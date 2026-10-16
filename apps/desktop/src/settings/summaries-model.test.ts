import { describe, expect, test } from 'bun:test'
import type { Settings } from '@/api/schema'
import { defaultChatSummaries, effortLevels, parseChatSummaries, serialiseChatSummaries, summaryModels, withAgent, withModel, type ChatSummaries } from '@/settings/summaries-model'

const models: Settings['models'] = [
  { agent: 'claude', model: 'claude-opus-5-5', reasoning: { levels: ['low', 'medium', 'high'] }, current: true },
  { agent: 'claude', model: 'claude-opus-4-5', reasoning: { levels: ['low', 'high'] }, current: false },
  { agent: 'agy', model: 'gemini-3.8-flash', reasoning: { levels: ['low', 'high'] }, current: true },
  { agent: 'codex', model: 'gpt-6-luna', reasoning: { levels: ['medium', 'high'] }, current: true },
]

describe('parseChatSummaries', () => {
  test('nothing saved is off, every 6 messages or 10 minutes, retitling', () => {
    expect(parseChatSummaries(null)).toEqual(defaultChatSummaries)
    expect(parseChatSummaries([])).toEqual(defaultChatSummaries)
    expect(defaultChatSummaries).toMatchObject({ enabled: false, everyMessages: 6, everyMinutes: 10, retitle: true, effort: null })
  })

  test('a saved form reads back as it was written', () => {
    const saved: ChatSummaries = { enabled: true, agent: 'agy', model: 'gemini-3.8-flash', effort: 'low', everyMessages: 4, everyMinutes: 15, retitle: false }
    expect(parseChatSummaries(JSON.parse(serialiseChatSummaries(saved)))).toEqual(saved)
  })

  test('an unusable field takes its default and keeps the rest', () => {
    const parsed = parseChatSummaries({ enabled: true, agent: 'gemini', model: 7, effort: '', everyMessages: 0, everyMinutes: 2.5, retitle: 'yes' })
    expect(parsed).toEqual({ ...defaultChatSummaries, enabled: true })
  })
})

describe('the form', () => {
  test('models group like the composer picker: current, then older', () => {
    const groups = summaryModels(models, 'claude')
    expect(groups.current.map((entry) => entry.model)).toEqual(['claude-opus-5-5'])
    expect(groups.older.map((entry) => entry.model)).toEqual(['claude-opus-4-5'])
  })

  test('another agent takes its first current model at the default effort', () => {
    const next = withAgent({ ...defaultChatSummaries, effort: 'high' }, 'agy', models)
    expect(next).toMatchObject({ agent: 'agy', model: 'gemini-3.8-flash', effort: null })
    expect(withAgent(defaultChatSummaries, 'grok', models).model).toBe('')
  })

  test('another model keeps an effort it offers and drops one it does not', () => {
    const saved = { ...defaultChatSummaries, model: 'claude-opus-5-5', effort: 'medium' }
    expect(withModel(saved, 'claude-opus-4-5', models).effort).toBeNull()
    expect(withModel({ ...saved, effort: 'high' }, 'claude-opus-4-5', models).effort).toBe('high')
    expect(effortLevels(models, 'claude', 'unknown')).toEqual([])
  })
})
