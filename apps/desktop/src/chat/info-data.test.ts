import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transcriptEventSchema, type InfoData } from '@/api/schema'
import { CommandOutput } from '@/chat/CommandOutput'
import { resetDistance } from '@/chat/composer-status'
import { dataPanel, type InfoPanel } from '@/chat/info-panels'

// The event megabrain appends when it answers an info command itself (feat/chat-info-commands-all-agents):
// { kind: "command-output", command, agent, source: "megabrain", data, text }. Not captured yet: the
// shapes below follow the contract between that CLI lane and this one; fields it does not know are absent.

const now = new Date('2026-10-17T15:00:00.000Z')
const inHours = (hours: number) => new Date(now.getTime() + hours * 3_600_000).toISOString()
const absolute = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const reset = (iso: string) => `Resets ${absolute(iso)} · ${resetDistance(new Date(iso), now)}`

const codexStatus: InfoData = {
  model: 'gpt-6-luna',
  effort: 'high',
  approvals: 'never',
  sandbox: 'workspace-write',
  cwd: '/Users/operator/Workspaces/canto',
  session: { id: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b', startedAt: inHours(-3), turns: 12 },
  context: { used: 182_400, window: 400_000, percent: 45.6 },
  limits: [
    { label: '5h limit', usedPercent: 74, resetsAt: inHours(2), window: '5h' },
    { label: 'Weekly limit', usedPercent: 93, resetsAt: inHours(75), window: 'weekly' },
  ],
  tokens: { input: 1_204_000, output: 38_200, cacheRead: 9_800_000, cacheWrite: 0 },
}

const claudeCost: InfoData = {
  cost: {
    total: 10.86,
    currency: 'USD',
    byModel: [{ model: 'claude-opus-5-5', input: 776, output: 74_200, cacheRead: 20_100_000, cacheWrite: 669_800, cost: 10.86 }],
  },
}

const event = (data: unknown) => ({ id: 'e1', at: now.toISOString(), kind: 'command-output', command: '/status', agent: 'codex', source: 'megabrain', data, text: 'Model: gpt-6-luna' })

describe('the command-output event', () => {
  test('parses with its agent, source and data', () => {
    const parsed = transcriptEventSchema.parse(event(codexStatus))
    expect(parsed.kind).toBe('command-output')
    expect(parsed.agent).toBe('codex')
    expect(parsed.source).toBe('megabrain')
    expect(parsed.data?.limits?.[1]?.window).toBe('weekly')
  })

  test('keeps the event when its data has a shape this app does not read', () => {
    const parsed = transcriptEventSchema.parse(event({ limits: 'soon' }))
    expect(parsed.kind).toBe('command-output')
    expect(parsed.data).toBeUndefined()
    expect(parsed.text).toBe('Model: gpt-6-luna')
  })

  test('reads a limit window it does not know as other', () => {
    const parsed = transcriptEventSchema.parse(event({ limits: [{ label: 'Daily', usedPercent: 10, resetsAt: null, window: 'daily' }] }))
    expect(parsed.data?.limits?.[0]?.window).toBe('other')
  })
})

describe('dataPanel', () => {
  test('lays out Codex /status as settings rows, the context window, limit meters and token rows', () => {
    const panel = dataPanel(codexStatus, now) as Extract<InfoPanel, { kind: 'data' }>
    expect(panel.fields).toEqual([
      { label: 'Model', value: 'gpt-6-luna' },
      { label: 'Effort', value: 'high' },
      { label: 'Approvals', value: 'never' },
      { label: 'Sandbox', value: 'workspace-write' },
      { label: 'Directory', value: '/Users/operator/Workspaces/canto' },
      { label: 'Session', value: '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b' },
      { label: 'Turns', value: '12' },
    ])
    expect(panel.context).toEqual({ used: '182.4k', window: '400k', percent: 45.6, tone: 'normal' })
    expect(panel.meters).toEqual([
      { label: '5h limit', percent: 74, tone: 'amber', reset: reset(inHours(2)) },
      { label: 'Weekly limit', percent: 93, tone: 'red', reset: reset(inHours(75)) },
    ])
    expect(panel.cost).toBeNull()
    expect(panel.tokens).toEqual([
      { label: 'Input', value: '1.2m' },
      { label: 'Output', value: '38.2k' },
      { label: 'Cache read', value: '9.8m' },
      { label: 'Cache write', value: '0' },
    ])
  })

  test('lays out a cost with its models the way Claude prints usage by model', () => {
    const panel = dataPanel(claudeCost, now) as Extract<InfoPanel, { kind: 'data' }>
    expect(panel.cost).toEqual({
      total: '$10.86',
      models: [{ label: 'claude-opus-5-5', value: '776 input, 74.2k output, 20.1m cache read, 669.8k cache write ($10.86)' }],
    })
    expect(panel.fields).toEqual([])
    expect(panel.meters).toEqual([])
    expect(panel.context).toBeNull()
  })

  test('computes the window share only from what the data gives, and leaves a reset out when none is known', () => {
    const panel = dataPanel({ context: { used: 50_000, window: 200_000 }, limits: [{ label: 'Monthly', usedPercent: 12, resetsAt: null, window: 'monthly' }] }, now) as Extract<InfoPanel, { kind: 'data' }>
    expect(panel.context).toEqual({ used: '50k', window: '200k', percent: 25, tone: 'normal' })
    expect(panel.meters).toEqual([{ label: 'Monthly', percent: 12, tone: 'normal', reset: null }])
    expect(dataPanel({ context: { used: 50_000 } }, now)).toBeNull()
  })

  test('is null when the data holds nothing to show', () => {
    expect(dataPanel({}, now)).toBeNull()
  })
})

describe('CommandOutput with data', () => {
  test('renders the data panel, with the text one Show raw away', () => {
    const html = renderToStaticMarkup(createElement(CommandOutput, { command: '/status', text: 'Model: gpt-6-luna', data: codexStatus }))
    expect(html).toContain('gpt-6-luna')
    expect(html).toContain('workspace-write')
    expect(html).toContain('182.4k / 400k')
    expect(html).toContain('Weekly limit')
    expect(html).toContain('width:93%')
    expect(html).toContain('bg-bad')
    expect(html).toContain('Show raw')
  })

  test('falls back to the text when the data holds nothing', () => {
    const html = renderToStaticMarkup(createElement(CommandOutput, { command: '/status', text: 'Model: gpt-6-luna', data: {} }))
    expect(html).toContain('Model')
    expect(html).toContain('gpt-6-luna')
  })
})
