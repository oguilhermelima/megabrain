import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CommandOutput } from '@/chat/CommandOutput'
import { formatCommandOutput } from '@/chat/command-output'
import { formatTokens, infoPanel, tokenCount, type ContextSection, type InfoPanel, type UsageSection } from '@/chat/info-panels'

// Real outputs of Claude's info commands: /usage from a native chat, /context from claude -p and from a
// real chat with MCP servers, agents and memory files (paths redacted to /Users/operator).
const captured = (name: string) => readFileSync(join(import.meta.dir, '..', 'api', 'fixtures', 'captured', 'command-output', name), 'utf8')

const usageText = captured('claude-usage.txt')
const contextText = captured('claude-context.txt')
const contextFullText = captured('claude-context-full.txt')

const usagePanel = (text: string) => infoPanel('/usage', text) as Extract<InfoPanel, { kind: 'usage' }>
const contextPanel = (text: string) => infoPanel('/context', text) as Extract<InfoPanel, { kind: 'context' }>
const rowsSection = (panel: Extract<InfoPanel, { kind: 'context' }>, title: string) =>
  panel.sections.find((section): section is Extract<ContextSection, { type: 'rows' }> => section.type === 'rows' && section.title === title)

const resets = 'Resets Oct 17 at 4pm (America/Sao_Paulo)'
const resetsWeek = 'Resets Oct 22 at 1pm (America/Sao_Paulo)'

describe('tokenCount and formatTokens', () => {
  test('read the counts /context prints, approximate ones flagged', () => {
    expect(tokenCount('1.9k')).toEqual({ value: 1900, approximate: false })
    expect(tokenCount('88')).toEqual({ value: 88, approximate: false })
    expect(tokenCount('1m')).toEqual({ value: 1_000_000, approximate: false })
    expect(tokenCount('~480')).toEqual({ value: 480, approximate: true })
    expect(tokenCount('< 20')).toEqual({ value: 0, approximate: true })
    expect(tokenCount('lots')).toBeNull()
  })

  test('write a count the way /context does', () => {
    expect(formatTokens(480)).toBe('480')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1321)).toBe('1.3k')
    expect(formatTokens(132_900)).toBe('132.9k')
    expect(formatTokens(1_000_000)).toBe('1m')
    expect(formatTokens(480, true)).toBe('~480')
  })
})

describe('infoPanel', () => {
  test('reads /usage as a note, limit meters, the insights heading and one section per period', () => {
    expect(usagePanel(usageText).sections).toEqual([
      { type: 'note', text: 'You are currently using your subscription to power your Claude Code usage' },
      {
        type: 'meters',
        meters: [
          { label: 'Current session', percent: 23, tone: 'normal', reset: resets },
          { label: 'Current week (all models)', percent: 46, tone: 'normal', reset: resetsWeek },
          { label: 'Current week (Fable)', percent: 0, tone: 'normal', reset: resetsWeek },
        ],
      },
      {
        type: 'insights',
        title: "What's contributing to your limits usage?",
        note: 'Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.',
      },
      {
        type: 'period',
        title: 'Last 24h',
        detail: '5543 requests · 84 sessions',
        shares: [
          { percent: 75, text: 'of your usage was at >150k context' },
          { percent: 56, text: 'of your usage was while 4+ sessions ran in parallel' },
          { percent: 40, text: 'of your usage went to always-on context over 40k tokens' },
          { percent: 18, text: 'of your usage came from sessions active for 8+ hours' },
        ],
        fields: [{ label: 'Top skills', value: '/claude-api 4%, /dataviz 2%, /docs 1%' }],
      },
      {
        type: 'period',
        title: 'Last 7d',
        detail: '40231 requests · 417 sessions',
        shares: [
          { percent: 78, text: 'of your usage was at >150k context' },
          { percent: 63, text: 'of your usage came from sessions active for 8+ hours' },
          { percent: 52, text: 'of your usage was while 4+ sessions ran in parallel' },
          { percent: 43, text: 'of your usage came from subagent-heavy sessions' },
          { percent: 27, text: 'of your usage went to always-on context over 40k tokens' },
        ],
        fields: [
          { label: 'Top skills', value: '/mobile-qa 1%, /claude-api 1%' },
          { label: 'Top subagents', value: 'general-purpose 12%' },
        ],
      },
    ])
  })

  test('tones a /usage meter by the usage thresholds', () => {
    const meters = usagePanel('Current session: 75% used · resets 4pm\nCurrent week (all models): 95% used').sections[0] as Extract<UsageSection, { type: 'meters' }>
    expect(meters.meters.map((meter) => [meter.tone, meter.reset])).toEqual([
      ['amber', 'Resets 4pm'],
      ['red', null],
    ])
  })

  test('falls back to the generic layout for one /usage section that does not parse, keeping the others', () => {
    const garbledPeriod = '  ▒▒ 3 of 7 rows unavailable ▒▒'
    const text = usageText
      .replace('  56% of your usage was while 4+ sessions ran in parallel', garbledPeriod)
      .replace('Current week (Fable): 0% used · resets Oct 22 at 1pm (America/Sao_Paulo)', 'Current week (Fable): unavailable')
    const sections = usagePanel(text).sections
    expect(sections.map((section) => section.type)).toEqual(['note', 'fallback', 'insights', 'fallback', 'period'])
    const meterGroup = 'Current session: 23% used · resets Oct 17 at 4pm (America/Sao_Paulo)\nCurrent week (all models): 46% used · resets Oct 22 at 1pm (America/Sao_Paulo)\nCurrent week (Fable): unavailable'
    expect(sections[1]).toEqual({ type: 'fallback', blocks: formatCommandOutput(meterGroup) })
    const period = text.split('\n\n')[3] ?? ''
    expect(period).toContain(garbledPeriod)
    expect(sections[3]).toEqual({ type: 'fallback', blocks: formatCommandOutput(period) })
    expect((sections[4] as Extract<UsageSection, { type: 'period' }>).title).toBe('Last 7d')
  })

  test('reads /context as the model, the window and its categories, then each table as rows', () => {
    const panel = contextPanel(contextText)
    expect(panel.model).toBe('claude-opus-5-5')
    expect(panel.tokens).toEqual({ used: '32k', total: '1m', percent: 3 })
    expect(panel.sections[0]).toEqual({
      type: 'categories',
      title: 'Estimated usage by category',
      categories: [
        { name: 'System prompt', tokens: '1.9k', percent: 0.2, role: 'used' },
        { name: 'System tools', tokens: '28.1k', percent: 2.8, role: 'used' },
        { name: 'Skills', tokens: '2k', percent: 0.2, role: 'used' },
        { name: 'Free space', tokens: '935k', percent: 93.5, role: 'free' },
        { name: 'Autocompact buffer', tokens: '33k', percent: 3.3, role: 'buffer' },
      ],
    })
    const skills = rowsSection(panel, 'Skills')
    expect(skills?.columns).toEqual(['Skill', 'Source'])
    expect(skills?.rows[0]).toEqual({ name: 'dataviz', detail: 'Built-in', tokens: '~480' })
    expect(skills?.rows).toHaveLength(13)
    expect(skills?.groups?.map((group) => [group.name, group.rows.length, group.tokens])).toEqual([['Built-in', 13, '~2k']])
    expect(panel.sections).toHaveLength(2)
  })

  test('keeps deferred categories out of the window and groups long tables by their second column', () => {
    const panel = contextPanel(contextFullText)
    expect(panel.model).toBe('claude-opus-5-5[1m]')
    expect(panel.tokens).toEqual({ used: '257.2k', total: '500k', percent: 51 })
    const categories = panel.sections[0] as Extract<ContextSection, { type: 'categories' }>
    expect(categories.categories.filter((category) => category.role === 'deferred').map((category) => category.name)).toEqual(['MCP tools (deferred)', 'System tools (deferred)'])
    const inWindow = categories.categories.filter((category) => category.role !== 'deferred').reduce((total, category) => total + category.percent, 0)
    expect(Math.round(inWindow)).toBe(100)

    const tools = rowsSection(panel, 'MCP Tools')
    expect(tools?.rows).toHaveLength(145)
    expect(tools?.groups?.map((group) => [group.name, group.rows.length])).toEqual(
      expect.arrayContaining([
        ['appium-mcp', 32],
        ['caveman', 5],
        ['claude_ai_Claude_Docs', 8],
        ['claude_ai_Notion', 65],
        ['playwright', 25],
        ['refero', 10],
      ]),
    )
    expect(tools?.groups?.[0]?.name).toBe('claude_ai_Notion')
    expect(tools?.groups?.find((group) => group.name === 'caveman')?.tokens).toBe('1.3k')

    const agents = rowsSection(panel, 'Custom Agents')
    expect(agents?.columns).toEqual(['Agent Type', 'Source'])
    expect(agents?.rows).toHaveLength(5)
    expect(agents?.groups).toBeNull()
    expect(rowsSection(panel, 'Memory Files')?.rows[0]).toEqual({ name: 'User', detail: '/Users/operator/.claude/CLAUDE.md', tokens: '21.7k' })
    expect(rowsSection(panel, 'Skills')?.groups?.map((group) => group.name).sort()).toEqual(['Built-in', 'Plugin (caveman)', 'Plugin (superset)', 'Project', 'User', 'claude.ai sync'])
    expect(panel.sections.map((section) => (section.type === 'fallback' ? 'fallback' : section.title))).toEqual(['Estimated usage by category', 'MCP Tools', 'Custom Agents', 'Memory Files', 'Skills'])
  })

  test('shows a /context section it cannot read as Markdown, keeping the others', () => {
    const suggestions = '### Suggestions\n\n- Run /compact to free about 120k tokens\n- 3 MCP servers are unused in this session'
    const text = `${contextFullText.replace('| caveman:docs:AGENTS | Plugin | 30 |', '| caveman:docs:AGENTS | 30 |')}\n\n${suggestions}\n`
    const panel = contextPanel(text)
    const fallbacks = panel.sections.filter((section): section is Extract<ContextSection, { type: 'fallback' }> => section.type === 'fallback')
    expect(fallbacks).toHaveLength(2)
    expect(fallbacks[0]?.markdown.startsWith('### Custom Agents\n')).toBe(true)
    expect(fallbacks[0]?.markdown).toContain('| caveman:docs:AGENTS | 30 |')
    expect(fallbacks[1]?.markdown).toBe(suggestions)
    expect(rowsSection(panel, 'Memory Files')?.rows).toHaveLength(4)
  })

  test('keeps a /context header line it cannot read, as Markdown above the rest', () => {
    const panel = contextPanel(contextText.replace('**Tokens:** 32k / 1m (3%)', '**Tokens:** unknown'))
    expect(panel.tokens).toBeNull()
    expect(panel.model).toBe('claude-opus-5-5')
    expect(panel.sections[0]).toEqual({ type: 'fallback', markdown: '**Tokens:** unknown' })
    expect(panel.sections[1]?.type).toBe('categories')
  })

  test('leaves other commands and empty output to the generic layout', () => {
    expect(infoPanel('/cost', captured('claude-cost.txt'))).toBeNull()
    expect(infoPanel('/mcp', captured('claude-mcp.txt'))).toBeNull()
    expect(infoPanel('/usage', '\n')).toBeNull()
    expect(infoPanel('/context', 'Context is not available yet.')).toBeNull()
  })

  test('recognises the output when the record names no command', () => {
    expect(infoPanel('', usageText)?.kind).toBe('usage')
    expect(infoPanel('', contextText)?.kind).toBe('context')
  })
})

describe('CommandOutput panels', () => {
  const render = (command: string, text: string, latest = true) => renderToStaticMarkup(createElement(CommandOutput, { command, text, latest }))

  test('draws /usage meters as accent bars with the reset under each', () => {
    const html = render('/usage', usageText)
    expect(html).toContain('Current week (all models)')
    expect(html).toContain('width:46%')
    expect(html).toContain('bg-accent')
    expect(html).toContain(resetsWeek)
    expect(html).toContain('Last 24h')
    expect(html).toContain('Copy')
    expect(html).toContain('Show raw')
  })

  test('draws /context as one stacked bar with a legend, free space and the buffer apart', () => {
    const html = render('/context', contextFullText)
    expect(html).toContain('257.2k / 500k')
    expect(html).toContain('Free space')
    expect(html).toContain('Autocompact buffer')
    expect(html).toContain('MCP Tools')
    expect(html).toContain('claude_ai_Notion')
    expect(html).not.toContain('<table')
  })

  test('renders a section it could not read with the generic layout', () => {
    const html = render('/context', `${contextText}\n\n### Suggestions\n\n| Tip |\n|-----|\n| Run /compact |\n`)
    expect(html).toContain('<table')
    expect(html).toContain('Run /compact')
  })

  test('opens collapsed when it is not the latest result', () => {
    const html = render('/usage', usageText, false)
    expect(html).toContain('/usage')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Current week (all models)')
  })
})
