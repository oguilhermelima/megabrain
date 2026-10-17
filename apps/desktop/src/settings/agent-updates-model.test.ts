import { describe, expect, test } from 'bun:test'
import { checkedLabel, decisiveLine, defaultUpdatePolicy, parseUpdatePolicy, pendingBadge, serialiseUpdatePolicy, updateRows, withAgentAutoUpdate, withAutoUpdate, type AgentUpdateEntry } from '@/settings/agent-updates-model'

const now = Date.parse('2026-10-17T12:00:00Z')

const codexEntry: AgentUpdateEntry = { agent: 'codex', installed: '0.163.0', latest: '0.163.0', status: 'up-to-date', installKind: 'standalone', checkedAt: '2026-10-17T11:30:00Z' }
const claudeEntry: AgentUpdateEntry = { agent: 'claude', installed: '2.4.1', latest: '2.5.0', status: 'update-available', installKind: 'native', checkedAt: '2026-10-17T09:00:00Z' }
const report: AgentUpdateEntry[] = [
  codexEntry,
  claudeEntry,
  { agent: 'grok', installed: '1.2.0', latest: '1.3.0', status: 'update-available', installKind: 'npm', checkedAt: '2026-10-17T10:00:00Z', lastAttempt: { at: '2026-10-17T10:00:05Z', ok: false, error: 'npm warn deprecated\nnpm error code EACCES\n\n' } },
  { agent: 'agy', installed: '1.4.1', latest: null, status: 'latest-unknown', installKind: 'unknown', checkedAt: '2026-10-17T11:00:00Z' },
]

describe('update policy', () => {
  test('nothing saved is automatic for every agent', () => {
    expect(parseUpdatePolicy(null)).toEqual(defaultUpdatePolicy)
    expect(defaultUpdatePolicy).toEqual({ enabled: true, perAgent: {} })
  })

  test('a saved policy reads back as written; unknown agents and non-boolean values are dropped', () => {
    const saved = { enabled: false, perAgent: { codex: true } }
    expect(parseUpdatePolicy(JSON.parse(serialiseUpdatePolicy(saved)))).toEqual(saved)
    expect(parseUpdatePolicy({ enabled: 'no', perAgent: { gemini: true, grok: 'yes', claude: false } })).toEqual({ enabled: true, perAgent: { claude: false } })
  })

  test('the main switch sets every agent and clears their own choices', () => {
    expect(withAutoUpdate({ enabled: true, perAgent: { codex: false } }, false)).toEqual({ enabled: false, perAgent: {} })
  })

  test('an agent switch keeps a choice only where it differs from the main switch', () => {
    expect(withAgentAutoUpdate({ enabled: false, perAgent: {} }, 'codex', true)).toEqual({ enabled: false, perAgent: { codex: true } })
    expect(withAgentAutoUpdate({ enabled: false, perAgent: { codex: true } }, 'codex', false)).toEqual({ enabled: false, perAgent: {} })
  })
})

describe('updateRows', () => {
  test('one row per agent in a fixed order with its state, versions, install kind and automatic switch', () => {
    const rows = updateRows(report, { enabled: true, perAgent: { agy: false } }, new Set(), {})
    expect(rows.map((row) => [row.agent, row.state, row.installed, row.latest, row.kind, row.auto, row.canUpdate, row.error])).toEqual([
      ['claude', 'available', '2.4.1', '2.5.0', 'native', true, true, null],
      ['codex', 'up-to-date', '0.163.0', '0.163.0', 'standalone', true, false, null],
      ['grok', 'failed', '1.2.0', '1.3.0', 'npm', true, true, 'npm error code EACCES'],
      ['agy', 'unknown', '1.4.1', null, 'unknown', false, false, null],
    ])
  })

  test('an agent being updated shows as updating and cannot be started again', () => {
    const [claude] = updateRows(report, defaultUpdatePolicy, new Set(['claude']), {})
    expect(claude).toMatchObject({ agent: 'claude', state: 'updating', canUpdate: false })
    expect(updateRows([{ ...claudeEntry, status: 'updating' }], defaultUpdatePolicy, new Set(), {})[0]).toMatchObject({ state: 'updating', canUpdate: false })
  })

  test('a manual update that failed here shows its decisive line, and a retry stays available', () => {
    const [claude] = updateRows(report, defaultUpdatePolicy, new Set(), { claude: 'downloading…\ninstaller exited with status 22' })
    expect(claude).toMatchObject({ state: 'failed', error: 'installer exited with status 22', canUpdate: true })
  })

  test('a failed attempt no longer matters once the agent is up to date', () => {
    const rows = updateRows([{ ...codexEntry, status: 'updated', lastAttempt: { at: '2026-10-17T11:00:00Z', ok: false, error: 'old' } }], defaultUpdatePolicy, new Set(), {})
    expect(rows.find((row) => row.agent === 'codex')).toMatchObject({ agent: 'codex', state: 'up-to-date', error: null })
  })

  test('an agent missing from the report, or with no installed version, is not installed', () => {
    const rows = updateRows([{ agent: 'codex', installed: null, latest: '0.163.0', status: 'update-available', installKind: 'unknown', checkedAt: null }], defaultUpdatePolicy, new Set(), {})
    expect(rows.map((row) => [row.agent, row.state, row.canUpdate])).toEqual([
      ['claude', 'not-installed', false],
      ['codex', 'not-installed', false],
      ['grok', 'not-installed', false],
      ['agy', 'not-installed', false],
    ])
  })

  test('an install kind the app does not know reads as unknown', () => {
    expect(updateRows([{ ...codexEntry, installKind: 'pipx' }], defaultUpdatePolicy, new Set(), {}).find((row) => row.agent === 'codex')?.kind).toBe('unknown')
  })
})

describe('pendingBadge', () => {
  test('counts updates waiting on agents that do not update automatically', () => {
    expect(pendingBadge(updateRows(report, { enabled: true, perAgent: {} }, new Set(), {}))).toBe(0)
    expect(pendingBadge(updateRows(report, { enabled: false, perAgent: {} }, new Set(), {}))).toBe(2)
    expect(pendingBadge(updateRows(report, { enabled: false, perAgent: { claude: true } }, new Set(), {}))).toBe(1)
  })

  test('an update in progress or an unknown latest version is not pending', () => {
    expect(pendingBadge(updateRows(report, { enabled: false, perAgent: {} }, new Set(['claude', 'grok']), {}))).toBe(0)
  })
})

describe('labels', () => {
  test('the decisive line is the last line with text', () => {
    expect(decisiveLine('a\n  b  \n\n')).toBe('b')
    expect(decisiveLine('')).toBe(null)
    expect(decisiveLine(null)).toBe(null)
  })

  test('the last check reads as a short relative time', () => {
    expect(checkedLabel(null, now)).toBe('Never checked')
    expect(checkedLabel('2026-10-17T11:59:40Z', now)).toBe('Checked just now')
    expect(checkedLabel('2026-10-17T11:30:00Z', now)).toBe('Checked 30 min ago')
    expect(checkedLabel('2026-10-17T09:00:00Z', now)).toBe('Checked 3 h ago')
    expect(checkedLabel('2026-10-15T12:00:00Z', now)).toBe('Checked 2 d ago')
    expect(checkedLabel('not a date', now)).toBe('Never checked')
  })
})
