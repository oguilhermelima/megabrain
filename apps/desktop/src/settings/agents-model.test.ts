import { describe, expect, test } from 'bun:test'
import { agentMode, agentRows, commandLine, defaultAgentSettings, parseAgentSettings, serialiseAgentSettings, withDefault, withEnabled, withMode, type AgentSettings } from '@/settings/agents-model'

const plan = [
  { agent: 'claude', label: 'Claude Code', installed: true },
  { agent: 'codex', label: 'Codex', installed: true },
  { agent: 'agy', label: 'Antigravity (agy)', installed: false },
  { agent: 'grok', label: 'Grok', installed: true },
]

describe('parseAgentSettings', () => {
  test('nothing saved is Auto with every agent on', () => {
    expect(parseAgentSettings(null)).toEqual(defaultAgentSettings)
    expect(defaultAgentSettings).toEqual({ version: 1, default: null, disabled: [], modes: {} })
  })

  test('a saved form reads back as it was written', () => {
    const saved: AgentSettings = { version: 1, default: 'codex', disabled: ['agy'], modes: { claude: 'terminal' } }
    expect(parseAgentSettings(JSON.parse(serialiseAgentSettings(saved)))).toEqual(saved)
  })

  test('unknown agents are dropped, and a default that is turned off is no default', () => {
    expect(parseAgentSettings({ version: 1, default: 'gemini', disabled: ['grok', 'gemini', 7], modes: {} })).toEqual({ version: 1, default: null, disabled: ['grok'], modes: {} })
    expect(parseAgentSettings({ version: 1, default: 'grok', disabled: ['grok'], modes: {} })).toEqual({ version: 1, default: null, disabled: ['grok'], modes: {} })
  })
})

describe('agentMode', () => {
  test('modes keep only known agents with chat or terminal', () => {
    expect(parseAgentSettings({ version: 1, default: null, disabled: [], modes: { claude: 'terminal', codex: 'chat', gemini: 'chat', grok: 'tui' } })).toEqual({ version: 1, default: null, disabled: [], modes: { claude: 'terminal', codex: 'chat' } })
    expect(parseAgentSettings({ version: 1, default: null, disabled: [], modes: 'terminal' })).toEqual({ version: 1, default: null, disabled: [], modes: {} })
  })

  test('with nothing saved every agent opens in chat', () => {
    expect(['claude', 'codex', 'grok', 'agy'].map((agent) => agentMode(defaultAgentSettings, agent))).toEqual(['chat', 'chat', 'chat', 'chat'])
  })

  test('a saved mode wins over the agent default', () => {
    const settings: AgentSettings = { version: 1, default: null, disabled: [], modes: { claude: 'terminal' } }
    expect(agentMode(settings, 'claude')).toBe('terminal')
    expect(agentMode(settings, 'codex')).toBe('chat')
  })

  test('agy follows its saved mode like the others', () => {
    expect(agentMode({ version: 1, default: null, disabled: [], modes: { agy: 'terminal' } }, 'agy')).toBe('terminal')
  })

  test('withMode changes only that agent and keeps the rest', () => {
    const settings: AgentSettings = { version: 1, default: 'codex', disabled: ['grok'], modes: { codex: 'terminal' } }
    expect(withMode(settings, 'claude', 'terminal')).toEqual({ version: 1, default: 'codex', disabled: ['grok'], modes: { codex: 'terminal', claude: 'terminal' } })
    expect(withMode(settings, 'codex', 'chat')).toEqual({ version: 1, default: 'codex', disabled: ['grok'], modes: { codex: 'chat' } })
  })
})

describe('changes', () => {
  test('turning the default off leaves Auto', () => {
    expect(withEnabled({ version: 1, default: 'codex', disabled: [], modes: {} }, 'codex', false)).toEqual({ version: 1, default: null, disabled: ['codex'], modes: {} })
  })

  test('turning an agent back on removes it from the disabled list once', () => {
    expect(withEnabled({ version: 1, default: null, disabled: ['grok', 'agy'], modes: {} }, 'grok', true)).toEqual({ version: 1, default: null, disabled: ['agy'], modes: {} })
    expect(withEnabled({ version: 1, default: null, disabled: ['grok'], modes: {} }, 'grok', false)).toEqual({ version: 1, default: null, disabled: ['grok'], modes: {} })
  })

  test('making an agent the default turns it on; null is Auto', () => {
    expect(withDefault({ version: 1, default: null, disabled: ['grok'], modes: {} }, 'grok')).toEqual({ version: 1, default: 'grok', disabled: [], modes: {} })
    expect(withDefault({ version: 1, default: 'grok', disabled: [], modes: {} }, null)).toEqual({ version: 1, default: null, disabled: [], modes: {} })
  })
})

describe('agentRows', () => {
  test('every agent in a fixed order with its label, install state, switch, default and launch command', () => {
    const rows = agentRows(plan, { version: 1, default: 'codex', disabled: ['grok'], modes: {} }, { claude: ['claude', '--dangerously-skip-permissions'], codex: undefined, grok: null })
    expect(rows).toEqual([
      { agent: 'claude', label: 'Claude Code', installed: true, enabled: true, isDefault: false, mode: 'chat', command: 'claude --dangerously-skip-permissions' },
      { agent: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true, mode: 'chat', command: undefined },
      { agent: 'grok', label: 'Grok', installed: true, enabled: false, isDefault: false, mode: 'chat', command: null },
      { agent: 'agy', label: 'Antigravity (agy)', installed: false, enabled: true, isDefault: false, mode: 'chat', command: undefined },
    ])
  })

  test('without the install report the agents are listed by id and not marked installed', () => {
    expect(agentRows(null, defaultAgentSettings, {}).map((row) => [row.agent, row.label, row.installed])).toEqual([
      ['claude', 'Claude', false],
      ['codex', 'Codex', false],
      ['grok', 'Grok', false],
      ['agy', 'agy', false],
    ])
  })
})

describe('commandLine', () => {
  test('quotes only the arguments that need it', () => {
    expect(commandLine(['codex', '--model', 'gpt-6-luna', '-c', 'model_reasoning_effort="high"', 'two words'])).toBe(`codex --model gpt-6-luna -c 'model_reasoning_effort="high"' 'two words'`)
    expect(commandLine(['grok', "it's"])).toBe(`grok 'it'\\''s'`)
  })
})
