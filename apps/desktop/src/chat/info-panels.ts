import type { InfoData } from '@/api/schema'
import { formatCommandOutput, outputRow, stripAnsi, type OutputBlock } from '@/chat/command-output'
import { parseResetsAt, resetDistance, usageLimitTone, type LimitTone } from '@/chat/composer-status'

// Info commands as panels. Claude's own output is read from its text: /usage as limit meters and usage
// insights, /context as the window by category and its tables as rows. Each part is read on its own; a
// part without the expected shape keeps the generic layout (command-output.ts), so a change in what
// Claude prints costs one section, never the card. An info command megabrain answered itself, for any
// agent, comes with data and is laid out from that (dataPanel).

export interface Meter {
  label: string
  percent: number
  tone: LimitTone
  /** "Resets Oct 22 at 1pm (America/Sao_Paulo)", or null when the line gave none. */
  reset: string | null
}

export type UsageSection =
  | { type: 'note'; text: string }
  | { type: 'meters'; meters: Meter[] }
  /** "What's contributing to your limits usage?" and the caveat under it. */
  | { type: 'insights'; title: string; note: string | null }
  /** "Last 24h · 5543 requests · 84 sessions" and the shares and fields listed under it. */
  | { type: 'period'; title: string; detail: string | null; shares: { percent: number; text: string }[]; fields: { label: string; value: string }[] }
  | { type: 'fallback'; blocks: OutputBlock[] }

export interface ContextCategory {
  name: string
  tokens: string
  percent: number
  /** Deferred categories are listed but not loaded, so they sit outside the window's bar. */
  role: 'used' | 'free' | 'buffer' | 'deferred'
}

export interface ContextRow {
  name: string
  /** The table's second column: a tool's server, a skill's source, a memory file's path. */
  detail: string
  tokens: string
}

export interface ContextGroup {
  name: string
  /** The rows' total, written as /context writes a count. */
  tokens: string
  rows: ContextRow[]
}

export type ContextSection =
  | { type: 'categories'; title: string; categories: ContextCategory[] }
  /** A long table also comes grouped by its second column, largest group first; null when short. */
  | { type: 'rows'; title: string; columns: [string, string]; rows: ContextRow[]; groups: ContextGroup[] | null }
  | { type: 'fallback'; markdown: string }

export interface InfoField {
  label: string
  value: string
}

export type InfoPanel =
  | { kind: 'usage'; sections: UsageSection[] }
  | { kind: 'context'; model: string | null; tokens: { used: string; total: string; percent: number } | null; sections: ContextSection[] }
  | {
      kind: 'data'
      /** Model, effort, approvals, sandbox, folder and session, as far as the data names them. */
      fields: InfoField[]
      context: { used: string; window: string; percent: number; tone: LimitTone } | null
      meters: Meter[]
      /** The total, then one row per model written as Claude's usage by model. */
      cost: { total: string; models: InfoField[] } | null
      tokens: InfoField[]
    }

/** A count as /context prints it ("1.9k", "~480", "< 20"); a bound such as "< 20" counts as nothing. */
export function tokenCount(text: string): { value: number; approximate: boolean } | null {
  const trimmed = text.trim()
  if (/^<\s*\d+(?:\.\d+)?[km]?$/i.test(trimmed)) return { value: 0, approximate: true }
  const count = /^(~)?\s*(\d+(?:\.\d+)?)([km])?$/i.exec(trimmed)
  if (count === null) return null
  const scale = { k: 1_000, m: 1_000_000 }[(count[3] ?? '').toLowerCase()] ?? 1
  return { value: Math.round(Number(count[2]) * scale), approximate: count[1] !== undefined }
}

export function formatTokens(value: number, approximate = false): string {
  const tilde = approximate ? '~' : ''
  if (value >= 1_000_000) return `${tilde}${Math.round(value / 100_000) / 10}m`
  if (value >= 1_000) return `${tilde}${Math.round(value / 100) / 10}k`
  return `${tilde}${value}`
}

// ---- /usage

const usageSignal = /^\s*Current (?:session|week)\b[^\n]*?\d+(?:\.\d+)?%\s+used/im
const indented = (line: string) => /^\s/.test(line)

function usageSection(lines: string[]): UsageSection {
  const fallback: UsageSection = { type: 'fallback', blocks: formatCommandOutput(lines.join('\n')) }
  const rows = lines.map(outputRow)
  if (rows.every((row) => row.type === 'meter')) {
    return {
      type: 'meters',
      meters: rows.map((row) => {
        const reset = row.note === null ? null : row.note.replace(/^resets\b/i, 'Resets')
        return { label: row.label, percent: row.percent, tone: row.tone, reset }
      }),
    }
  }
  const [first = '', ...rest] = lines
  if (rest.length === 0) return rows[0]?.type === 'text' ? { type: 'note', text: first.trim() } : fallback
  if (indented(first)) return fallback
  if (first.trim().endsWith('?') && rows.every((row) => row.type === 'text') && !rest.some(indented)) {
    return { type: 'insights', title: first.trim(), note: rest.map((line) => line.trim()).join(' ') }
  }
  if (!rest.every(indented)) return fallback
  const [title = '', ...detail] = first.trim().split(' · ')
  const shares: { percent: number; text: string }[] = []
  const fields: { label: string; value: string }[] = []
  for (const row of rows.slice(1)) {
    if (row.type === 'share') shares.push({ percent: row.percent, text: row.text })
    else if (row.type === 'field') fields.push({ label: row.label, value: row.value })
    else return fallback
  }
  return { type: 'period', title, detail: detail.length === 0 ? null : detail.join(' · '), shares, fields }
}

function usagePanel(text: string): InfoPanel | null {
  const groups: string[][] = [[]]
  for (const line of text.split('\n')) {
    if (line.trim() === '') groups.push([])
    else groups.at(-1)?.push(line.trimEnd())
  }
  const sections = groups.filter((group) => group.length > 0).map(usageSection)
  return sections.length === 0 ? null : { kind: 'usage', sections }
}

// ---- /context

const contextSignal = /^## Context Usage\s*$/m
const modelLine = /^\*\*Model:\*\*\s*(\S.*)$/
const tokensLine = /^\*\*Tokens:\*\*\s*(\S+)\s*\/\s*(\S+)\s*\((\d+(?:\.\d+)?)%\)$/
const separatorRow = /^\|(?:\s*:?-+:?\s*\|)+$/
/** Past this many rows a table also shows grouped. */
const groupedRows = 12

const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())

/** A pipe table's header and rows, or null when the body is anything else or a row is ragged. */
function tableOf(body: string[]): { header: string[]; rows: string[][] } | null {
  const lines = body.filter((line) => line.trim() !== '')
  const [head, separator, ...rest] = lines
  if (head === undefined || separator === undefined || !separatorRow.test(separator.trim().replace(/\s+/g, ' ')) || !lines.every((line) => line.trim().startsWith('|'))) return null
  const header = cellsOf(head)
  const rows = rest.map(cellsOf)
  return rows.every((row) => row.length === header.length) ? { header, rows } : null
}

const roleOf = (name: string): ContextCategory['role'] => {
  if (/\(deferred\)/i.test(name)) return 'deferred'
  if (/^free space$/i.test(name)) return 'free'
  if (/^autocompact buffer$/i.test(name)) return 'buffer'
  return 'used'
}

function groupsOf(rows: ContextRow[]): ContextGroup[] {
  const totals = new Map<string, { value: number; approximate: boolean; rows: ContextRow[] }>()
  for (const row of rows) {
    const count = tokenCount(row.tokens)
    const group = totals.get(row.detail) ?? { value: 0, approximate: false, rows: [] }
    group.value += count?.value ?? 0
    group.approximate ||= count?.approximate ?? false
    group.rows.push(row)
    totals.set(row.detail, group)
  }
  return [...totals.entries()]
    .sort(([, a], [, b]) => b.value - a.value)
    .map(([name, group]) => ({ name, tokens: formatTokens(group.value, group.approximate), rows: group.rows }))
}

function contextSection(chunk: string): ContextSection {
  const [titleLine = '', ...body] = chunk.split('\n')
  const title = titleLine.trim()
  const fallback: ContextSection = { type: 'fallback', markdown: `### ${chunk}`.trim() }
  const table = tableOf(body)
  if (table === null) return fallback
  const [first, second, third] = table.header
  if (table.header.length === 3 && first === 'Category' && second === 'Tokens' && third === 'Percentage') {
    const categories: ContextCategory[] = []
    for (const [name = '', tokens = '', percent = ''] of table.rows) {
      const share = /^(\d+(?:\.\d+)?)%$/.exec(percent)
      if (share === null || tokenCount(tokens) === null) return fallback
      categories.push({ name, tokens, percent: Number(share[1]), role: roleOf(name) })
    }
    return { type: 'categories', title, categories }
  }
  if (table.header.length === 3 && third === 'Tokens' && first !== undefined && second !== undefined) {
    const rows = table.rows.map(([name = '', detail = '', tokens = '']) => ({ name, detail, tokens }))
    if (rows.some((row) => tokenCount(row.tokens) === null)) return fallback
    return { type: 'rows', title, columns: [first, second], rows, groups: rows.length > groupedRows ? groupsOf(rows) : null }
  }
  return fallback
}

function contextPanel(text: string): InfoPanel {
  const [head = '', ...chunks] = text.split(/^### /m)
  let model: string | null = null
  let tokens: Extract<InfoPanel, { kind: 'context' }>['tokens'] = null
  const unread: string[] = []
  for (const raw of head.split('\n')) {
    const line = raw.trim()
    if (line === '' || contextSignal.test(line)) continue
    const named = modelLine.exec(line)
    const counted = tokensLine.exec(line)
    if (named !== null && model === null) model = named[1] ?? null
    else if (counted !== null && tokens === null) tokens = { used: counted[1] ?? '', total: counted[2] ?? '', percent: Number(counted[3]) }
    else unread.push(line)
  }
  const sections = chunks.map((chunk) => contextSection(chunk.trimEnd()))
  return { kind: 'context', model, tokens, sections: unread.length === 0 ? sections : [{ type: 'fallback', markdown: unread.join('\n') }, ...sections] }
}

/** The panel for an info command's output, or null to keep the generic layout. `command` "" is a record that names none. */
export function infoPanel(command: string, text: string): InfoPanel | null {
  const clean = stripAnsi(text).replace(/\r\n?/g, '\n')
  if ((command === '' || command === '/context') && contextSignal.test(clean)) return contextPanel(clean)
  if ((command === '' || command === '/usage') && usageSignal.test(clean)) return usagePanel(clean)
  return null
}

// ---- Data megabrain read

const money = (amount: number, currency: string | undefined) => {
  if (currency === undefined) return amount.toFixed(2)
  return currency.toUpperCase() === 'USD' ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`
}

type TokenCounts = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
const tokenParts: [keyof TokenCounts, string][] = [
  ['input', 'input'],
  ['output', 'output'],
  ['cacheRead', 'cache read'],
  ['cacheWrite', 'cache write'],
]

const resetOf = (resetsAt: string | null | undefined, now: Date) => {
  const at = parseResetsAt(resetsAt ?? null)
  if (at === null) return null
  return `Resets ${at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${resetDistance(at, now)}`
}

/** The panel for what megabrain read, or null when it holds nothing to show and the text should. */
export function dataPanel(data: InfoData, now: Date = new Date()): InfoPanel | null {
  const fields: InfoField[] = []
  const field = (label: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') fields.push({ label, value: String(value) })
  }
  field('Model', data.model)
  field('Effort', data.effort)
  field('Approvals', data.approvals)
  field('Sandbox', data.sandbox)
  field('Directory', data.cwd)
  field('Session', data.session?.id)
  field('Turns', data.session?.turns)

  const { used, window } = data.context ?? {}
  const share = data.context?.percent ?? (used !== undefined && window !== undefined && window > 0 ? Math.round((used / window) * 1000) / 10 : undefined)
  const context = used === undefined || window === undefined || share === undefined ? null : { used: formatTokens(used), window: formatTokens(window), percent: share, tone: usageLimitTone(share) }

  const meters = (data.limits ?? []).map((limit) => ({ label: limit.label, percent: limit.usedPercent, tone: usageLimitTone(limit.usedPercent), reset: resetOf(limit.resetsAt, now) }))

  const cost =
    data.cost === undefined
      ? null
      : {
          total: money(data.cost.total, data.cost.currency),
          models: (data.cost.byModel ?? []).map((model) => {
            const counts = tokenParts.flatMap(([key, name]) => (model[key] === undefined ? [] : [`${formatTokens(model[key])} ${name}`])).join(', ')
            return { label: model.model, value: `${counts}${model.cost === undefined ? '' : ` (${money(model.cost, data.cost?.currency)})`}` }
          }),
        }

  const tokens = tokenParts.flatMap(([key, name]) => {
    const value = data.tokens?.[key]
    return value === undefined ? [] : [{ label: name.charAt(0).toUpperCase() + name.slice(1), value: formatTokens(value) }]
  })

  if (fields.length === 0 && context === null && meters.length === 0 && cost === null && tokens.length === 0) return null
  return { kind: 'data', fields, context, meters, cost, tokens }
}
