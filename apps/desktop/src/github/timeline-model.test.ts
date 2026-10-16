import { describe, expect, test } from 'bun:test'
import { reviewVerb, timeline } from '@/github/timeline-model'

const person = (login: string) => ({ login, name: null, isBot: false })
const comment = (login: string, createdAt: string) => ({ author: person(login), body: `from ${login}`, createdAt, url: `https://github.com/o/r/pull/1#${login}-${createdAt}` })
const detail = (comments: ReturnType<typeof comment>[]) => ({ author: person('author'), createdAt: '2026-10-01T00:00:00Z', body: 'The description', comments })
const review = (login: string, state: string, submittedAt: string | null) => ({ author: person(login), state, submittedAt })

describe('timeline', () => {
  test('the description opens the timeline as its author entry, even with nothing else', () => {
    expect(timeline(detail([]))).toEqual([{ kind: 'opened', key: 'opened', author: person('author'), at: '2026-10-01T00:00:00Z', body: 'The description' }])
  })

  test('comments and reviews interleave by time', () => {
    const entries = timeline(detail([comment('a', '2026-10-02T00:00:00Z'), comment('b', '2026-10-04T00:00:00Z')]), [review('r', 'approved', '2026-10-03T00:00:00Z')])
    expect(entries.map((entry) => `${entry.kind}:${entry.author?.login}`)).toEqual(['opened:author', 'comment:a', 'review:r', 'comment:b'])
  })

  test('a pending review is left out', () => {
    expect(timeline(detail([]), [review('me', 'pending', null)]).map((entry) => entry.kind)).toEqual(['opened'])
  })

  test('a review with no time goes last, keeping its order', () => {
    const entries = timeline(detail([comment('a', '2026-10-02T00:00:00Z')]), [review('x', 'commented', null), review('y', 'approved', null)])
    expect(entries.map((entry) => entry.author?.login)).toEqual(['author', 'a', 'x', 'y'])
  })

  test('equal times keep the order the CLI gave', () => {
    const entries = timeline(detail([comment('a', '2026-10-02T00:00:00Z'), comment('b', '2026-10-02T00:00:00Z')]))
    expect(entries.map((entry) => entry.author?.login)).toEqual(['author', 'a', 'b'])
  })
})

describe('reviewVerb', () => {
  test('names each review state with its tone', () => {
    expect(reviewVerb('approved')).toEqual({ text: 'approved these changes', tone: 'ok' })
    expect(reviewVerb('changes_requested')).toEqual({ text: 'requested changes', tone: 'bad' })
    expect(reviewVerb('commented').tone).toBe('muted')
    expect(reviewVerb('dismissed').tone).toBe('muted')
  })
})
