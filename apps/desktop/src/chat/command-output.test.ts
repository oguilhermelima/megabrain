import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommandOutput } from '@/chat/CommandOutput'
import { formatCommandOutput, isLongOutput, stripAnsi, type OutputBlock } from '@/chat/command-output'

// Real outputs of Claude's local commands as its stream-json printed them (an assistant message from
// the <synthetic> model): /usage from a native chat, /cost, /context and /mcp from claude -p.
const captured = (name: string) => readFileSync(join(import.meta.dir, '..', 'api', 'fixtures', 'captured', 'command-output', name), 'utf8')

const resets = 'resets Oct 17 at 4pm (America/Sao_Paulo)'
const resetsWeek = 'resets Oct 22 at 1pm (America/Sao_Paulo)'

describe('formatCommandOutput', () => {
  test('lays out /usage as meters, a note and two percent-led sections', () => {
    expect(formatCommandOutput(captured('claude-usage.txt'))).toEqual([
      { type: 'section', title: null, detail: null, rows: [{ type: 'text', text: 'You are currently using your subscription to power your Claude Code usage' }] },
      {
        type: 'section',
        title: null,
        detail: null,
        rows: [
          { type: 'meter', label: 'Current session', percent: 23, tone: 'normal', note: resets },
          { type: 'meter', label: 'Current week (all models)', percent: 46, tone: 'normal', note: resetsWeek },
          { type: 'meter', label: 'Current week (Fable)', percent: 0, tone: 'normal', note: resetsWeek },
        ],
      },
      {
        type: 'section',
        title: null,
        detail: null,
        rows: [
          { type: 'text', text: "What's contributing to your limits usage?" },
          {
            type: 'text',
            text: 'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.',
          },
        ],
      },
      {
        type: 'section',
        title: 'Last 24h',
        detail: '5543 requests · 84 sessions',
        rows: [
          { type: 'share', percent: 75, text: 'of your usage was at >150k context' },
          { type: 'share', percent: 56, text: 'of your usage was while 4+ sessions ran in parallel' },
          { type: 'share', percent: 40, text: 'of your usage went to always-on context over 40k tokens' },
          { type: 'share', percent: 18, text: 'of your usage came from sessions active for 8+ hours' },
          { type: 'field', label: 'Top skills', value: '/claude-api 4%, /dataviz 2%, /docs 1%' },
        ],
      },
      {
        type: 'section',
        title: 'Last 7d',
        detail: '40231 requests · 417 sessions',
        rows: [
          { type: 'share', percent: 78, text: 'of your usage was at >150k context' },
          { type: 'share', percent: 63, text: 'of your usage came from sessions active for 8+ hours' },
          { type: 'share', percent: 52, text: 'of your usage was while 4+ sessions ran in parallel' },
          { type: 'share', percent: 43, text: 'of your usage came from subagent-heavy sessions' },
          { type: 'share', percent: 27, text: 'of your usage went to always-on context over 40k tokens' },
          { type: 'field', label: 'Top skills', value: '/mobile-qa 1%, /claude-api 1%' },
          { type: 'field', label: 'Top subagents', value: 'general-purpose 12%' },
        ],
      },
    ])
  })

  test('reads /cost as an aligned label and value list, not as a table', () => {
    expect(formatCommandOutput(captured('claude-cost.txt'))).toEqual([
      {
        type: 'section',
        title: null,
        detail: null,
        rows: [
          { type: 'field', label: 'Total cost', value: '$0.0000' },
          { type: 'field', label: 'Total duration (API)', value: '0s' },
          { type: 'field', label: 'Total duration (wall)', value: '0s' },
          { type: 'field', label: 'Total code changes', value: '0 lines added, 0 lines removed' },
          { type: 'field', label: 'Usage', value: '0 input, 0 output, 0 cache read, 0 cache write' },
        ],
      },
    ])
  })

  test('hands Markdown output such as /context to the Markdown renderer whole', () => {
    const text = captured('claude-context.txt')
    expect(formatCommandOutput(text)).toEqual([{ type: 'markdown', text }])
  })

  test('keeps a sentence and a usage line of /mcp', () => {
    expect(formatCommandOutput(captured('claude-mcp.txt'))).toEqual([
      {
        type: 'section',
        title: null,
        detail: null,
        rows: [
          { type: 'text', text: 'No MCP servers are configured. Add one with `claude mcp add`.' },
          { type: 'field', label: 'Usage', value: '/mcp [reconnect|enable|disable [<server>|all]]. With no server name, applies to all.' },
        ],
      },
    ])
  })

  test('strips ANSI codes before reading a line', () => {
    expect(stripAnsi('\u001b[1mModel:\u001b[22m \u001b[36mopus\u001b[39m\u001b]8;;https://x\u0007link\u001b]8;;\u0007')).toBe('Model: opuslink')
    expect(formatCommandOutput('\u001b[1mModel:\u001b[0m opus\n\u001b[2mSession:\u001b[0m 91% used\n')).toEqual([
      {
        type: 'section',
        title: null,
        detail: null,
        rows: [
          { type: 'field', label: 'Model', value: 'opus' },
          { type: 'meter', label: 'Session', percent: 91, tone: 'red', note: null },
        ],
      },
    ])
  })

  test('tones a meter as the usage bar does and drops a bar drawn in text', () => {
    const rows = (formatCommandOutput('5h limit: [████████░░] 75% used (resets 18:31)\nWeekly limit: 12% used')[0] as Extract<OutputBlock, { type: 'section' }>).rows
    expect(rows).toEqual([
      { type: 'meter', label: '5h limit', percent: 75, tone: 'amber', note: 'resets 18:31' },
      { type: 'meter', label: 'Weekly limit', percent: 12, tone: 'normal', note: null },
    ])
  })

  test('keeps box drawing and space-aligned columns monospace in a code block', () => {
    const box = '┌──────┬────┐\n│ name │ ok │\n└──────┴────┘'
    const columns = 'NAME      STATUS    AGE\nweb       running   2h\nworker    stopped   5m'
    expect(formatCommandOutput(`Servers:\n${box}\n\n${columns}`)).toEqual([
      { type: 'section', title: 'Servers', detail: null, rows: [] },
      { type: 'code', text: box },
      { type: 'code', text: columns },
    ])
  })

  test('keeps a fenced block as code and the text around it', () => {
    expect(formatCommandOutput('Before\n```\nraw   text\n  indented\n```\nAfter')).toEqual([
      { type: 'section', title: null, detail: null, rows: [{ type: 'text', text: 'Before' }] },
      { type: 'code', text: 'raw   text\n  indented' },
      { type: 'section', title: null, detail: null, rows: [{ type: 'text', text: 'After' }] },
    ])
  })

  test('starts a section at a short line ending in a colon and keeps list lines under it', () => {
    expect(formatCommandOutput('Plugins:\n  - alpha\n  - beta\nStatus: ready')).toEqual([
      { type: 'section', title: 'Plugins', detail: null, rows: [{ type: 'text', text: '- alpha' }, { type: 'text', text: '- beta' }, { type: 'field', label: 'Status', value: 'ready' }] },
    ])
  })

  test('keeps a line it does not recognise, word for word', () => {
    const odd = '!!! ¯\\_(ツ)_/¯ ### ~~ 42 -> ??'
    expect(formatCommandOutput(`${odd}\nNothing changed since the last run.`)).toEqual([
      {
        type: 'section',
        title: null,
        detail: null,
        rows: [
          { type: 'text', text: odd },
          { type: 'text', text: 'Nothing changed since the last run.' },
        ],
      },
    ])
  })

  test('reads empty output as nothing', () => {
    expect(formatCommandOutput('\n  \n')).toEqual([])
  })
})

describe('isLongOutput', () => {
  test('/usage and /cost fit; /context and a long listing collapse', () => {
    expect(isLongOutput(formatCommandOutput(captured('claude-usage.txt')))).toBe(false)
    expect(isLongOutput(formatCommandOutput(captured('claude-cost.txt')))).toBe(false)
    expect(isLongOutput(formatCommandOutput(captured('claude-context.txt')))).toBe(true)
    expect(isLongOutput(formatCommandOutput(Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')))).toBe(true)
  })
})

describe('CommandOutput', () => {
  test('heads the result with the command and renders the meter in the usage tones', () => {
    const html = renderToStaticMarkup(createElement(CommandOutput, { command: '/usage', text: captured('claude-usage.txt') }))
    expect(html).toContain('/usage')
    expect(html).toContain('Current week (all models)')
    expect(html).toContain('width:46%')
    expect(html).toContain('Resets Oct 22 at 1pm (America/Sao_Paulo)')
    expect(html).toContain('Last 24h')
    expect(html).toContain('5543 requests · 84 sessions')
    expect(html).not.toContain('Show all')
  })

  test('offers Show all on a long result', () => {
    const listing = `## Plugins\n\n| Plugin | State |\n|--------|-------|\n${Array.from({ length: 30 }, (_, index) => `| plugin-${index} | on |`).join('\n')}`
    const html = renderToStaticMarkup(createElement(CommandOutput, { command: '/plugin', text: listing }))
    expect(html).toContain('Show all')
    expect(html).toContain('<table')
  })
})
