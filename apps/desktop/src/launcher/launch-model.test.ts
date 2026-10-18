import { describe, expect, test } from 'bun:test'
import type { MessagePart } from '@/api/schema'
import { agentDetail, bracketedPaste, chatStart, initialTile, launchPlan, launchTiles, launchWorktree, terminalDetail, type LaunchTile } from '@/launcher/launch-model'

const installed = (...names: string[]) => ['claude', 'codex', 'grok', 'agy'].map((agent) => ({ agent, installed: names.includes(agent) }))
const tile = (tiles: LaunchTile[], id: string) => tiles.find((item) => item.id === id)
const text = (value: string): MessagePart[] => [{ type: 'text', text: value }]

describe('launchTiles', () => {
  test('lists the terminal first, then every agent in a fixed order', () => {
    expect(launchTiles(installed('claude', 'codex', 'grok', 'agy')).map((item) => item.id)).toEqual(['terminal', 'claude', 'codex', 'grok', 'agy'])
  })

  test('an installed agent is enabled with no hint', () => {
    const tiles = launchTiles(installed('claude', 'grok'))
    expect(tile(tiles, 'claude')).toMatchObject({ enabled: true, hint: null })
    expect(tile(tiles, 'grok')).toMatchObject({ enabled: true, hint: null })
  })

  test('an agent whose CLI is missing is disabled and says why', () => {
    const tiles = launchTiles(installed('claude'))
    for (const id of ['codex', 'grok', 'agy']) {
      expect(tile(tiles, id)?.enabled).toBe(false)
      expect(tile(tiles, id)?.hint).toContain('not installed')
    }
  })

  test('an agent the report does not list at all counts as missing', () => {
    expect(tile(launchTiles([{ agent: 'claude', installed: true }]), 'agy')?.enabled).toBe(false)
  })

  test('the terminal is always enabled, even with no agent installed', () => {
    expect(tile(launchTiles(installed()), 'terminal')).toMatchObject({ enabled: true, hint: null })
  })

  test('before the report arrives every tile is enabled, so nothing flickers off', () => {
    expect(launchTiles(null).every((item) => item.enabled && item.hint === null)).toBe(true)
  })
})

describe('launchTiles with agents turned off in Settings', () => {
  test('a turned-off agent is disabled and says where to turn it back on, even when installed', () => {
    const tiles = launchTiles(installed('claude', 'codex'), ['codex'])
    expect(tile(tiles, 'codex')).toMatchObject({ enabled: false })
    expect(tile(tiles, 'codex')?.hint).toContain('Settings')
    expect(tile(tiles, 'claude')).toMatchObject({ enabled: true, hint: null })
  })

  test('before the install report a turned-off agent is still off', () => {
    expect(tile(launchTiles(null, ['grok']), 'grok')?.enabled).toBe(false)
  })
})

describe('initialTile with a default agent', () => {
  const tiles = launchTiles(installed('claude', 'codex', 'grok'))

  test('the default beats the one used last', () => {
    expect(initialTile('grok', tiles, 'codex')).toBe('codex')
  })

  test('a default that is not enabled falls back to the one used last', () => {
    expect(initialTile('grok', tiles, 'agy')).toBe('grok')
    expect(initialTile('grok', launchTiles(installed('claude', 'codex', 'grok'), ['codex']), 'codex')).toBe('grok')
  })

  test('no default is Auto: the one used last', () => {
    expect(initialTile('grok', tiles, null)).toBe('grok')
  })
})

describe('initialTile', () => {
  const tiles = launchTiles(installed('codex', 'grok'))

  test('the tile used last when it is still enabled', () => {
    expect(initialTile('grok', tiles)).toBe('grok')
  })

  test('falls back to the first enabled agent when the remembered one is disabled or unknown', () => {
    expect(initialTile('claude', tiles)).toBe('codex')
    expect(initialTile('nonsense', tiles)).toBe('codex')
    expect(initialTile(null, tiles)).toBe('codex')
  })

  test('the terminal is never the remembered tile: it opens a terminal at once instead of being selected', () => {
    expect(initialTile('terminal', tiles)).toBe('codex')
  })

  test('the terminal when no agent is installed', () => {
    expect(initialTile(null, launchTiles(installed()))).toBe('terminal')
  })
})

describe('launchPlan', () => {
  const base = { cwd: '/work/repo', parts: text('fix the build'), model: 'opus', effort: 'high', engine: 'native' as const }

  test('Claude and Codex start a native chat with the parts, model and effort', () => {
    expect(launchPlan('claude', base)).toEqual({ kind: 'chat', agent: 'claude', cwd: '/work/repo', model: 'opus', effort: 'high', parts: text('fix the build') })
    expect(launchPlan('codex', { ...base, model: null, effort: null })).toEqual({ kind: 'chat', agent: 'codex', cwd: '/work/repo', model: null, effort: null, parts: text('fix the build') })
  })

  test('the terminal opens the login shell with the engine from settings, typed text waiting unsent', () => {
    expect(launchPlan('terminal', { ...base, engine: 'tmux' })).toEqual({ kind: 'terminal', engine: 'tmux', cwd: '/work/repo', firstInput: 'fix the build' })
    expect(launchPlan('terminal', { ...base, parts: [] })).toEqual({ kind: 'terminal', engine: 'native', cwd: '/work/repo', firstInput: null })
  })

  test('Grok and agy start a native chat too, with the parts, model and effort', () => {
    expect(launchPlan('grok', base)).toEqual({ kind: 'chat', agent: 'grok', cwd: '/work/repo', model: 'opus', effort: 'high', parts: text('fix the build') })
    expect(launchPlan('agy', { ...base, engine: 'tmux', model: null, effort: null })).toEqual({ kind: 'chat', agent: 'agy', cwd: '/work/repo', model: null, effort: null, parts: text('fix the build') })
  })

  test('a terminal only takes text: each image becomes its path on a line of its own', () => {
    const plan = launchPlan('terminal', { ...base, parts: [...text('look at '), { type: 'image', path: '/tmp/shot.png' }] })
    expect(plan).toMatchObject({ firstInput: 'look at\n/tmp/shot.png' })
  })

  test('blank text is no first input', () => {
    expect(launchPlan('terminal', { ...base, parts: text('   ') })).toMatchObject({ firstInput: null })
  })
})

describe('chatStart', () => {
  const plan = { kind: 'chat' as const, agent: 'claude' as const, cwd: '/w', model: 'opus', effort: null, parts: text('hi') }

  test('one start carries the model and the message', () => {
    expect(chatStart(plan)).toEqual({ agent: 'claude', cwd: '/w', model: 'opus', parts: text('hi') })
  })

  test('an effort rides on the same start, so the agent is spawned once with it', () => {
    expect(chatStart({ ...plan, effort: 'high' })).toEqual({ agent: 'claude', cwd: '/w', model: 'opus', effort: 'high', parts: text('hi') })
    expect(chatStart({ ...plan, model: null, effort: 'high' })).toEqual({ agent: 'claude', cwd: '/w', effort: 'high', parts: text('hi') })
  })

  test('no message starts an empty chat', () => {
    expect(chatStart({ ...plan, parts: [] })).toEqual({ agent: 'claude', cwd: '/w', model: 'opus' })
    expect(chatStart({ ...plan, parts: [], effort: 'low' })).toEqual({ agent: 'claude', cwd: '/w', model: 'opus', effort: 'low' })
  })
})

describe('launchWorktree', () => {
  const available = ['/a', '/b', '/c']

  test('the clicked worktree wins over the last used', () => {
    expect(launchWorktree('/b', '/c', available)).toBe('/b')
  })

  test('without a click, the last used one while it is still listed', () => {
    expect(launchWorktree(null, '/c', available)).toBe('/c')
  })

  test('a last used worktree that is gone falls back to the first listed', () => {
    expect(launchWorktree(null, '/gone', available)).toBe('/a')
    expect(launchWorktree(null, null, available)).toBe('/a')
  })

  test('a clicked worktree that is no longer listed falls through the same way', () => {
    expect(launchWorktree('/gone', '/c', available)).toBe('/c')
  })

  test('nothing listed is no worktree', () => {
    expect(launchWorktree('/a', '/a', [])).toBeNull()
  })
})

describe('bracketedPaste', () => {
  test('wraps the text so the TUI takes it as one paste, with no Enter', () => {
    expect(bracketedPaste('hello\nworld')).toBe('\x1b[200~hello\nworld\x1b[201~')
  })

  test('text cannot end the paste early', () => {
    expect(bracketedPaste('a\x1b[201~b')).toBe('\x1b[200~ab\x1b[201~')
  })
})

describe('agentDetail', () => {
  const defaults = {
    agents: [
      { agent: 'claude', model: 'opus', effort: 'high' },
      { agent: 'codex', model: 'gpt-6-luna', effort: null },
      { agent: 'grok', model: null, effort: null },
    ],
    shell: 'zsh',
  }
  test('a model picked for the selected agent wins over its default', () => {
    expect(agentDetail('claude', { model: 'sonnet', effort: 'low' }, defaults)).toBe('sonnet · low')
    expect(agentDetail('claude', { model: 'sonnet', effort: null }, defaults)).toBe('sonnet')
  })
  test("otherwise the agent's own configured default model and effort", () => {
    expect(agentDetail('claude', null, defaults)).toBe('opus · high')
    expect(agentDetail('codex', null, defaults)).toBe('gpt-6-luna')
  })
  test('an agent with nothing configured, or before the report arrives, reads as its default', () => {
    expect(agentDetail('grok', null, defaults)).toBe('Default model')
    expect(agentDetail('agy', null, defaults)).toBe('Default model')
    expect(agentDetail('claude', null, null)).toBe('Default model')
  })
})

describe('terminalDetail', () => {
  test("names the shell a new terminal opens, then the worktree", () => {
    expect(terminalDetail('zsh', 'megabrain')).toBe('zsh · megabrain')
  })
  test('before the report arrives it says login shell', () => {
    expect(terminalDetail(null, 'megabrain')).toBe('Login shell · megabrain')
  })
})
