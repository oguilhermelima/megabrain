import { describe, expect, test } from 'bun:test'
import { agentRows, commandLine, defaultAgentSettings, parseAgentSettings, serialiseAgentSettings, withDefault, withEnabled, type AgentSettings } from '@/settings/agents-model'

const plan = [
  { agent: 'claude', label: 'Claude Code', installed: true },
  { agent: 'codex', label: 'Codex', installed: true },
  { agent: 'agy', label: 'Antigravity (agy)', installed: false },
  { agent: 'grok', label: 'Grok', installed: true },
]

describe('parseAgentSettings', () => {
  test('nothing saved is Auto with every agent on', () => {
    expect(parseAgentSettings(null)).toEqual(defaultAgentSettings)
    expect(defaultAgentSettings).toEqual({ version: 1, default: null, disabled: [] })
  })

  test('a saved form reads back as it was written', () => {
    const saved: AgentSettings = { version: 1, default: 'codex', disabled: ['agy'] }
    expect(parseAgentSettings(JSON.parse(serialiseAgentSettings(saved)))).toEqual(saved)
  })

  test('unknown agents are dropped, and a default that is turned off is no default', () => {
    expect(parseAgentSettings({ version: 1, default: 'gemini', disabled: ['grok', 'gemini', 7] })).toEqual({ version: 1, default: null, disabled: ['grok'] })
    expect(parseAgentSettings({ version: 1, default: 'grok', disabled: ['grok'] })).toEqual({ version: 1, default: null, disabled: ['grok'] })
  })
})

describe('changes', () => {
  test('turning the default off leaves Auto', () => {
    expect(withEnabled({ version: 1, default: 'codex', disabled: [] }, 'codex', false)).toEqual({ version: 1, default: null, disabled: ['codex'] })
  })

  test('turning an agent back on removes it from the disabled list once', () => {
    expect(withEnabled({ version: 1, default: null, disabled: ['grok', 'agy'] }, 'grok', true)).toEqual({ version: 1, default: null, disabled: ['agy'] })
    expect(withEnabled({ version: 1, default: null, disabled: ['grok'] }, 'grok', false)).toEqual({ version: 1, default: null, disabled: ['grok'] })
  })

  test('making an agent the default turns it on; null is Auto', () => {
    expect(withDefault({ version: 1, default: null, disabled: ['grok'] }, 'grok')).toEqual({ version: 1, default: 'grok', disabled: [] })
    expect(withDefault({ version: 1, default: 'grok', disabled: [] }, null)).toEqual({ version: 1, default: null, disabled: [] })
  })
})

describe('agentRows', () => {
  test('every agent in a fixed order with its label, install state, switch, default and launch command', () => {
    const rows = agentRows(plan, { version: 1, default: 'codex', disabled: ['grok'] }, { claude: ['claude', '--dangerously-skip-permissions'], codex: undefined, grok: null })
    expect(rows).toEqual([
      { agent: 'claude', label: 'Claude Code', installed: true, enabled: true, isDefault: false, command: 'claude --dangerously-skip-permissions' },
      { agent: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true, command: undefined },
      { agent: 'grok', label: 'Grok', installed: true, enabled: false, isDefault: false, command: null },
      { agent: 'agy', label: 'Antigravity (agy)', installed: false, enabled: true, isDefault: false, command: undefined },
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
