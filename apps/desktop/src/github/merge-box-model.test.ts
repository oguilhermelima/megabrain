import { describe, expect, test } from 'bun:test'
import type { GithubCheck, GithubReviewers } from '@/api/schema'
import { mergeBox, type MergeBoxInput } from '@/github/merge-box-model'

const readiness = (extra: Partial<GithubReviewers> = {}): GithubReviewers => ({
  requested: [],
  reviews: [],
  mergeable: 'mergeable',
  mergeStateStatus: 'clean',
  reviewDecision: null,
  requiredChecks: [],
  ...extra,
})
const passing: GithubCheck[] = [{ name: 'unit', state: 'success' }, { name: 'lint', state: 'success' }]
const input = (extra: Partial<MergeBoxInput> = {}): MergeBoxInput => ({ state: 'open', isDraft: false, checks: passing, readiness: readiness(), autoMerge: null, ...extra })
const row = (box: ReturnType<typeof mergeBox>, kind: string) => box.rows.find((entry) => entry.kind === kind)

describe('mergeBox', () => {
  test('a clean pull request merges with the method select, and closing stays a quiet action', () => {
    const box = mergeBox(input())
    expect(box).toMatchObject({ tone: 'ok', headline: 'Ready to merge', primary: 'merge', primaryDisabled: false, showMethod: true })
    expect(box.secondary).toEqual(['convert-to-draft', 'close'])
    expect(row(box, 'checks')).toEqual({ kind: 'checks', tone: 'ok', text: 'All checks passed' })
    expect(row(box, 'reviews')).toEqual({ kind: 'reviews', tone: 'muted', text: 'No review required' })
    expect(row(box, 'conflicts')).toEqual({ kind: 'conflicts', tone: 'ok', text: 'No conflicts with the base branch' })
  })

  test('failing optional checks still merge, warn, and offer a re-run first', () => {
    const box = mergeBox(input({ checks: [...passing, { name: 'e2e', state: 'failure' }, { name: 'docs', state: 'failure' }], readiness: readiness({ mergeStateStatus: 'unstable' }) }))
    expect(box).toMatchObject({ tone: 'warn', headline: 'Can merge; some optional checks fail', primary: 'merge', primaryDisabled: false })
    expect(row(box, 'checks')).toEqual({ kind: 'checks', tone: 'warn', text: '2 checks failing' })
    expect(box.secondary).toEqual(['rerun-failed', 'convert-to-draft', 'close'])
  })

  test('a failed required check blocks the merge behind auto-merge and counts the required ones', () => {
    const box = mergeBox(input({ checks: [{ name: 'unit', state: 'failure' }], readiness: readiness({ mergeStateStatus: 'blocked', requiredChecks: [{ name: 'unit', state: 'failure' }, { name: 'lint', state: 'success' }] }) }))
    expect(box).toMatchObject({ tone: 'warn', headline: 'Merging is waiting', detail: 'Required checks failed: unit.', primary: 'auto-merge', showMethod: true })
    expect(row(box, 'checks')).toEqual({ kind: 'checks', tone: 'bad', text: '1 check failing (1/2 required passing)' })
  })

  test('running checks wait', () => {
    const box = mergeBox(input({ checks: [{ name: 'unit', state: 'pending' }], readiness: readiness({ mergeStateStatus: 'blocked', requiredChecks: [{ name: 'unit', state: 'pending' }] }) }))
    expect(box.primary).toBe('auto-merge')
    expect(row(box, 'checks')).toEqual({ kind: 'checks', tone: 'warn', text: '1 check still running (0/1 required passing)' })
  })

  test('the review row names the decision and who is still asked', () => {
    const asked = [{ login: 'alice', name: null, isBot: false }, { login: 'bob', name: null, isBot: false }]
    expect(row(mergeBox(input({ readiness: readiness({ reviewDecision: 'review_required', mergeStateStatus: 'blocked', requested: asked }) })), 'reviews')).toEqual({ kind: 'reviews', tone: 'warn', text: 'An approving review is required; waiting on alice, bob' })
    expect(row(mergeBox(input({ readiness: readiness({ reviewDecision: 'approved' }) })), 'reviews')).toEqual({ kind: 'reviews', tone: 'ok', text: 'Approved' })
    expect(row(mergeBox(input({ readiness: readiness({ reviewDecision: 'changes_requested', mergeStateStatus: 'blocked' }) })), 'reviews')?.tone).toBe('bad')
    expect(row(mergeBox(input({ readiness: readiness({ requested: asked }) })), 'reviews')).toEqual({ kind: 'reviews', tone: 'muted', text: 'Waiting on alice, bob' })
  })

  test('conflicts block the merge outright', () => {
    const box = mergeBox(input({ readiness: readiness({ mergeable: 'conflicting', mergeStateStatus: 'dirty' }) }))
    expect(box).toMatchObject({ tone: 'bad', headline: 'Merging is blocked', detail: 'Resolve the conflicts with the base branch first.', primary: 'merge', primaryDisabled: true })
    expect(row(box, 'conflicts')).toEqual({ kind: 'conflicts', tone: 'bad', text: 'This branch has conflicts with the base branch' })
  })

  test('a branch behind its base and an unknown mergeability say so', () => {
    expect(row(mergeBox(input({ readiness: readiness({ mergeStateStatus: 'behind' }) })), 'conflicts')?.tone).toBe('warn')
    expect(row(mergeBox(input({ readiness: readiness({ mergeable: 'unknown', mergeStateStatus: 'unknown' }) })), 'conflicts')).toEqual({ kind: 'conflicts', tone: 'muted', text: 'GitHub is still checking for conflicts' })
  })

  test('a draft offers ready for review instead of merge and no convert to draft', () => {
    const box = mergeBox(input({ isDraft: true, readiness: readiness({ mergeStateStatus: 'draft' }) }))
    expect(box).toMatchObject({ headline: 'This pull request is still a draft', primary: 'ready-for-review', showMethod: false })
    expect(box.secondary).toEqual(['close'])
  })

  test('auto-merge turned on offers to turn it off', () => {
    const box = mergeBox(input({ autoMerge: 'squash', readiness: readiness({ mergeStateStatus: 'blocked', reviewDecision: 'review_required' }) }))
    expect(box).toMatchObject({ tone: 'ok', headline: 'Auto-merge is on', primary: 'disable-auto-merge', showMethod: false })
    expect(box.secondary).toContain('close')
  })

  test('without a readiness read only the checks show and plain merge stays', () => {
    const box = mergeBox(input({ readiness: null }))
    expect(box.rows.map((entry) => entry.kind)).toEqual(['checks'])
    expect(box.primary).toBe('merge')
  })

  test('no checks at all leave out the checks row', () => {
    expect(row(mergeBox(input({ checks: [] })), 'checks')).toBeUndefined()
  })

  test('merged has nothing to do; closed offers only reopen', () => {
    expect(mergeBox(input({ state: 'merged' }))).toMatchObject({ headline: 'Merged', primary: null, secondary: [], rows: [] })
    expect(mergeBox(input({ state: 'closed' }))).toMatchObject({ headline: 'Closed without merging', primary: 'reopen', secondary: [], rows: [] })
  })
})
