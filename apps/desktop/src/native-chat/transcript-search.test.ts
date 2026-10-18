import { describe, expect, test } from 'bun:test'
import type { TranscriptEvent } from '@/api/schema'
import type { NoticeDisplayItem } from '@/chat/notice-model'
import { findMatches, firstMatchFrom, matchedTurns, matchLabel, occurrences, plainMarkdown, searchableText, stepMatch } from '@/native-chat/transcript-search'

const event = (id: string, kind: TranscriptEvent['kind'], text: string, extra: Partial<TranscriptEvent> = {}): TranscriptEvent => ({ id, at: null, kind, text, ...extra })
const message = (id: string, kind: TranscriptEvent['kind'], text: string, extra: Partial<TranscriptEvent> = {}): NoticeDisplayItem => ({ type: 'message', event: event(id, kind, text, extra) })
const bash = (id: string, command: string, output: string): NoticeDisplayItem => ({
  type: 'tool-group',
  id,
  items: [
    {
      type: 'tool',
      id: `${id}-call`,
      call: event(`${id}-call`, 'tool-call', 'Bash', { tool: { name: 'Bash', input: JSON.stringify({ command }) } }),
      result: event(`${id}-result`, 'tool-result', output, { tool: { name: 'Bash', status: 'ok' } }),
      status: 'ok',
    },
  ],
})

describe('occurrences', () => {
  test('every start of the query, ignoring case, without overlaps', () => {
    expect(occurrences('Tests pass; the TEST suite tests', 'test')).toEqual([0, 16, 27])
    expect(occurrences('aaaa', 'aa')).toEqual([0, 2])
  })

  test('an empty or blank query matches nothing', () => {
    expect(occurrences('anything', '')).toEqual([])
    expect(occurrences('anything', '   ')).toEqual([])
  })
})

describe('plainMarkdown', () => {
  test('drops the marks the reader never sees, keeping the words', () => {
    expect(plainMarkdown('## Steps\n\n1. Rename **five files**\n- Run `pnpm test`\n> quoted [the docs](https://example.com)')).toBe('Steps\n\nRename five files\nRun pnpm test\nquoted the docs')
  })

  test('keeps snake_case and code fences content', () => {
    expect(plainMarkdown('```ts\nconst step_order = 1\n```')).toBe('const step_order = 1')
  })
})

describe('searchableText', () => {
  test('the person and the assistant by their text, the assistant without markdown marks', () => {
    expect(searchableText(message('u1', 'user', 'Tidy the steps'))).toBe('Tidy the steps')
    expect(searchableText(message('a1', 'assistant', 'The **steps** pass'))).toBe('The steps pass')
  })

  test('a tool run by its sentence and its calls\' labels, never its raw output', () => {
    const text = searchableText(bash('t1', 'pnpm test', 'secret-output-line'))
    expect(text).toContain('Ran 1 command')
    expect(text).toContain('pnpm test')
    expect(text).not.toContain('secret-output-line')
  })

  test('thinking, which shows collapsed, is not searched', () => {
    expect(searchableText(message('th1', 'thinking', 'internal plan'))).toBe('')
  })
})

describe('findMatches', () => {
  const rows = [
    message('u1', 'user', 'Rename the steps'),
    message('a1', 'assistant', 'Steps renamed. The **steps** now read in order.'),
    bash('t1', 'ls steps', 'steps steps steps'),
    message('u2', 'user', 'Thanks'),
    message('a2', 'assistant', 'One more step left'),
  ]

  test('matches in transcript order, each with its row and its place within the row', () => {
    expect(findMatches(rows, 'steps')).toEqual([
      { row: 0, index: 0 },
      { row: 1, index: 0 },
      { row: 1, index: 1 },
      { row: 2, index: 0 },
    ])
  })

  test('a tool run counts once for its label, never for the three in its output', () => {
    expect(findMatches(rows, 'steps').filter((match) => match.row === 2)).toHaveLength(1)
  })

  test('no query, no matches', () => {
    expect(findMatches(rows, '')).toEqual([])
  })
})

describe('navigation', () => {
  test('Enter and Shift+Enter move forward and back, wrapping at the ends', () => {
    expect(stepMatch(0, 1, 3)).toBe(1)
    expect(stepMatch(2, 1, 3)).toBe(0)
    expect(stepMatch(0, -1, 3)).toBe(2)
    expect(stepMatch(-1, 1, 3)).toBe(0)
    expect(stepMatch(-1, -1, 3)).toBe(2)
    expect(stepMatch(0, 1, 0)).toBe(-1)
  })

  test('a new query starts at the first match at or below the row in view, else the first', () => {
    const matches = [
      { row: 1, index: 0 },
      { row: 4, index: 0 },
      { row: 4, index: 1 },
      { row: 9, index: 0 },
    ]
    expect(firstMatchFrom(matches, 0)).toBe(0)
    expect(firstMatchFrom(matches, 3)).toBe(1)
    expect(firstMatchFrom(matches, 4)).toBe(1)
    expect(firstMatchFrom(matches, 10)).toBe(0)
    expect(firstMatchFrom([], 3)).toBe(-1)
  })

  test('the count reads "3 of 12"', () => {
    expect(matchLabel(2, 12)).toBe('3 of 12')
    expect(matchLabel(-1, 0)).toBe('No matches')
  })
})

describe('matchedTurns', () => {
  test('each turn with a match in its rows, once, by turn index; rows above the first turn belong to none', () => {
    // Turns start at rows 2, 5 and 9.
    const matches = [
      { row: 0, index: 0 },
      { row: 3, index: 0 },
      { row: 4, index: 0 },
      { row: 4, index: 1 },
      { row: 11, index: 0 },
    ]
    expect(matchedTurns([2, 5, 9], matches)).toEqual([0, 2])
  })

  test('no matches, no marks', () => {
    expect(matchedTurns([0, 3], [])).toEqual([])
  })
})
