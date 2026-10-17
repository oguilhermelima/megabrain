import { usageLimitTone, type LimitTone } from '@/chat/composer-status'

// How a slash command's output reads in a conversation. Agents print it for a terminal: blank-line
// groups, "Label: value" lines, usage shares, aligned tables. The formatter reads that shape, not any
// one command, and keeps every line it does not recognise as text.

export type OutputRow =
  /** "Current session: 23% used · resets ...": a usage meter, toned as the usage bar is. */
  | { type: 'meter'; label: string; percent: number; tone: LimitTone; note: string | null }
  /** "Label: value", aligned in two columns with its neighbours. */
  | { type: 'field'; label: string; value: string }
  /** "75% of your usage ...": a share leading its sentence. */
  | { type: 'share'; percent: number; text: string }
  | { type: 'text'; text: string }

export type OutputBlock =
  /** A run of rows, under a title when the output gave one; detail is what followed the title's first " · ". */
  | { type: 'section'; title: string | null; detail: string | null; rows: OutputRow[] }
  /** Fenced, boxed or column-aligned text, kept monospace as printed. */
  | { type: 'code'; text: string }
  /** Output written in Markdown (headings, pipe tables), rendered as Markdown. */
  | { type: 'markdown'; text: string }

// CSI sequences (colours, cursor moves) and OSC sequences (hyperlinks, titles).
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export function stripAnsi(text: string): string {
  return text.replace(ansi, '')
}

const markdownSignal = /^(#{1,6} \S|\|.*\|\s*$)/m
const fence = /^\s*```/
const boxDrawing = /[─-╿]/
// Two columns or more: text, a gap of two spaces or more, text.
const columnGap = /\S {2,}\S/
const listLike = /^\s+\S|^\s*(?:[-*•]|\d+[.)])\s/

const meter = /^(?:(.+?):\s*)?(?:\[[^\]]*\]\s*)?(\d+(?:\.\d+)?)%\s+used\b[\s·•,;–—-]*(.*)$/i
const share = /^(\d+(?:\.\d+)?)%\s+(\S.*)$/
// A label is a short name: up to five words, no sentence punctuation; the value follows a colon and a space.
const field = /^([A-Za-z0-9][^:.!?;]{0,39}?):\s+(\S.*)$/
const maxLabelWords = 5
const maxTitleLength = 80

function rowOf(line: string): OutputRow {
  const text = line.trim()
  const used = meter.exec(text)
  if (used !== null) {
    const percent = Number(used[2])
    const note = (used[3] ?? '').trim().replace(/^\((.*)\)$/, '$1')
    return { type: 'meter', label: (used[1] ?? '').trim(), percent, tone: usageLimitTone(percent), note: note === '' ? null : note }
  }
  const led = share.exec(text)
  if (led !== null) return { type: 'share', percent: Number(led[1]), text: led[2] ?? '' }
  const pair = field.exec(text)
  if (pair !== null && (pair[1] ?? '').trim().split(/\s+/).length <= maxLabelWords) return { type: 'field', label: (pair[1] ?? '').trim(), value: pair[2] ?? '' }
  return { type: 'text', text }
}

const isRecognised = (line: string) => rowOf(line).type !== 'text'
const isTabular = (line: string) => boxDrawing.test(line) || (!isRecognised(line) && columnGap.test(line.trim()))

function dedent(lines: string[]): string {
  const indent = Math.min(...lines.filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)?.[0].length ?? 0))
  return lines.map((line) => line.slice(indent)).join('\n')
}

/** A title: a short line ending in ":", or one the lines after it are indented or listed under. */
function titleOf(line: string, next: string | undefined): { title: string; detail: string | null } | null {
  const text = line.trim()
  if (next === undefined || text.length > maxTitleLength || isRecognised(line) || listLike.test(line)) return null
  if (!text.endsWith(':') && !listLike.test(next)) return null
  const [title = '', ...rest] = text.replace(/:$/, '').split(' · ')
  return { title, detail: rest.length === 0 ? null : rest.join(' · ') }
}

/** One blank-line group: its tables become code, the rest sections, a new one at each title. */
function groupBlocks(lines: string[]): OutputBlock[] {
  const blocks: OutputBlock[] = []
  let section: Extract<OutputBlock, { type: 'section' }> | null = null
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? ''
    let end = index
    while (end < lines.length && isTabular(lines[end] ?? '')) end += 1
    if (end - index >= 2 || (end > index && boxDrawing.test(line))) {
      blocks.push({ type: 'code', text: dedent(lines.slice(index, end)) })
      section = null
      index = end
      continue
    }
    const title = titleOf(line, lines[index + 1])
    if (title !== null || section === null) {
      section = { type: 'section', title: title?.title ?? null, detail: title?.detail ?? null, rows: [] }
      blocks.push(section)
    }
    if (title === null) section.rows.push(rowOf(line))
    index += 1
  }
  return blocks
}

/** The output as blocks to lay out; empty output is none. */
export function formatCommandOutput(text: string): OutputBlock[] {
  const clean = stripAnsi(text).replace(/\r\n?/g, '\n')
  if (clean.trim() === '') return []
  if (markdownSignal.test(clean)) return [{ type: 'markdown', text: clean }]
  const blocks: OutputBlock[] = []
  let group: string[] = []
  let fenced: string[] | null = null
  const flush = () => {
    if (group.length > 0) blocks.push(...groupBlocks(group))
    group = []
  }
  for (const line of clean.split('\n')) {
    if (fence.test(line)) {
      if (fenced === null) {
        flush()
        fenced = []
      } else {
        blocks.push({ type: 'code', text: fenced.join('\n') })
        fenced = null
      }
    } else if (fenced !== null) fenced.push(line)
    else if (line.trim() === '') flush()
    else group.push(line)
  }
  if (fenced !== null) blocks.push({ type: 'code', text: fenced.join('\n') })
  flush()
  return blocks
}

/** Past this many rows the result opens collapsed, with Show all. */
const collapsedRows = 24

const blockRows = (block: OutputBlock) =>
  block.type === 'section' ? block.rows.length + (block.title === null ? 0 : 1) : block.text.split('\n').length

export function isLongOutput(blocks: OutputBlock[]): boolean {
  return blocks.reduce((total, block) => total + blockRows(block), 0) > collapsedRows
}
