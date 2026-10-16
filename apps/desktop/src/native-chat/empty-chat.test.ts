import { describe, expect, test } from 'bun:test'
import { agentLabel, chatSuggestions, emptyChatText } from '@/native-chat/empty-chat'

describe('emptyChatText', () => {
  test('names the worktree folder in the headline and the agent in the detail', () => {
    const text = emptyChatText('claude', '/Users/me/Worktrees/polish-desktop-empty-chat')
    expect(text.headline).toBe('What should we build in polish-desktop-empty-chat?')
    expect(text.detail.startsWith('Claude can read')).toBe(true)
  })

  test('a trailing slash still finds the folder', () => {
    expect(emptyChatText('codex', '/repo/megabrain/').headline).toBe('What should we build in megabrain?')
  })

  test('each known agent gets its display name', () => {
    expect(emptyChatText('codex', '/r').detail.startsWith('Codex ')).toBe(true)
    expect(emptyChatText('grok', '/r').detail.startsWith('Grok ')).toBe(true)
    expect(emptyChatText('agy', '/r').detail.startsWith('agy ')).toBe(true)
  })

  test('an unknown agent keeps its id', () => {
    expect(agentLabel('gemini')).toBe('gemini')
    expect(emptyChatText('gemini', '/r').detail.startsWith('gemini ')).toBe(true)
  })
})

describe('chatSuggestions', () => {
  test('four suggestions, each with an icon, a title and a hint', () => {
    const list = chatSuggestions(null)
    expect(list.map((item) => item.icon)).toEqual(['explain', 'bugs', 'tests', 'pulls'])
    expect(list.every((item) => item.title.length > 0 && item.hint.length > 0)).toBe(true)
    expect(list[2]?.title).toBe('Write tests for the code I changed last')
  })

  test('the tests suggestion names a changed file', () => {
    expect(chatSuggestions('src/app.ts')[2]?.title).toBe('Write tests for src/app.ts')
  })
})
