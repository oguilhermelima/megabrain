import type { NoticeDisplayItem } from '@/chat/notice-model'
import { subagentSummary } from '@/chat/subagent-model'
import { toolLabel, toolRunLine } from '@/chat/tool-sentence'

// Search inside a chat's transcript: what each row is searched by, where the matches are, and how the
// search bar walks them. The person's and the assistant's words count, and a tool run by its sentence and
// its calls' labels; a tool's raw input and output never do, nor thinking, which shows collapsed.

/** A match: the row it is in and which match it is within that row, in reading order. */
export interface SearchMatch {
  row: number
  index: number
}

/** Markdown as the reader sees it: headings, emphasis, code marks, list and quote markers and link targets dropped. */
export function plainMarkdown(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|`|~~/g, '')
        .replace(/(^|\W)\*(\S[^*]*)\*/g, '$1$2'),
    )
    .join('\n')
}

/** What a row is searched by: the text it shows. */
export function searchableText(item: NoticeDisplayItem): string {
  switch (item.type) {
    case 'notice':
      return ''
    case 'tool-group':
      return [toolRunLine(item).sentence, ...item.items.flatMap((step) => (step.type === 'tool' ? [toolLabel(step.call.tool?.name ?? '', step.call.tool?.input)] : []))].filter((part) => part !== '').join('\n')
    case 'subagent': {
      const summary = subagentSummary(item)
      return `${summary.type}\n${summary.description}`
    }
    case 'subagent-group':
      return item.items.map((subagent) => `${subagentSummary(subagent).type}\n${subagentSummary(subagent).description}`).join('\n')
    case 'message': {
      const event = item.event
      if (event.kind === 'user') return event.text
      if (event.kind === 'assistant') return event.command === undefined ? plainMarkdown(event.text) : event.text
      if (event.kind === 'system') return event.text
      return ''
    }
  }
}

/** Where the query starts in `text`, ignoring case, each match after the end of the one before. */
export function occurrences(text: string, query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const haystack = text.toLowerCase()
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) found.push(at)
  return found
}

/** Every match of the query in the rows, in reading order. */
export function findMatches(items: readonly NoticeDisplayItem[], query: string): SearchMatch[] {
  if (query.trim() === '') return []
  return items.flatMap((item, row) => occurrences(searchableText(item), query).map((_, index) => ({ row, index })))
}

/** Enter and Shift+Enter: the next or previous match, wrapping at the ends; -1 with none. */
export function stepMatch(current: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1
  if (current < 0) return delta === 1 ? 0 : count - 1
  return (current + delta + count) % count
}

/** Where a new query starts: the first match at or below the row in view, else the first one; -1 with none. */
export function firstMatchFrom(matches: readonly SearchMatch[], row: number): number {
  if (matches.length === 0) return -1
  const below = matches.findIndex((match) => match.row >= row)
  return below === -1 ? 0 : below
}

export function matchLabel(current: number, count: number): string {
  return count === 0 ? 'No matches' : `${current + 1} of ${count}`
}

/** The turns, by index among `turnRows` (each turn's first row), that hold a match. */
export function matchedTurns(turnRows: readonly number[], matches: readonly SearchMatch[]): number[] {
  const turns = new Set<number>()
  for (const match of matches) {
    let turn = -1
    for (let index = 0; index < turnRows.length && (turnRows[index] ?? Infinity) <= match.row; index++) turn = index
    if (turn !== -1) turns.add(turn)
  }
  return [...turns].sort((a, b) => a - b)
}
