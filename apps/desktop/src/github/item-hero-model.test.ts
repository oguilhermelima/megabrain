import { describe, expect, test } from 'bun:test'
import { heroActions, heroLayout, wideHeroMin } from '@/github/item-hero-model'
import type { MergeBox } from '@/github/merge-box-model'

type Box = Pick<MergeBox, 'primary' | 'primaryDisabled' | 'secondary'>
const box = (extra: Partial<Box> = {}): Box => ({ primary: 'merge', primaryDisabled: false, secondary: ['convert-to-draft', 'close'], ...extra })

describe('heroActions', () => {
  test('a merged pull request has no action at all', () => {
    expect(heroActions({ state: 'merged', isDraft: false, box: box({ primary: null, secondary: [] }) })).toEqual({ primary: null, review: false, more: [] })
  })

  test('a closed pull request leads with reopen and offers nothing else', () => {
    expect(heroActions({ state: 'closed', isDraft: false, box: box({ primary: 'reopen', secondary: [] }) })).toEqual({ primary: 'reopen', review: false, more: [] })
  })

  test('a draft leads with ready for review and can still be reviewed', () => {
    expect(heroActions({ state: 'open', isDraft: true, box: box({ primary: 'ready-for-review', secondary: ['close'] }) })).toEqual({ primary: 'ready-for-review', review: true, more: ['close'] })
  })

  test('an open pull request ready to merge leads with merge and keeps review beside it', () => {
    expect(heroActions({ state: 'open', isDraft: false, box: box() })).toEqual({ primary: 'merge', review: true, more: ['convert-to-draft', 'close'] })
  })

  test('a blocked merge leads with review instead', () => {
    expect(heroActions({ state: 'open', isDraft: false, box: box({ primaryDisabled: true }) }).primary).toBe('review')
  })

  test('a merge that waits (auto-merge) or auto-merge already on leads with review', () => {
    expect(heroActions({ state: 'open', isDraft: false, box: box({ primary: 'auto-merge' }) })).toEqual({ primary: 'review', review: false, more: ['convert-to-draft', 'close'] })
    expect(heroActions({ state: 'open', isDraft: false, box: box({ primary: 'disable-auto-merge' }) }).primary).toBe('review')
  })

  test('the more menu carries the merge box quiet actions, failed-check re-run included', () => {
    expect(heroActions({ state: 'open', isDraft: false, box: box({ primaryDisabled: true, secondary: ['rerun-failed', 'convert-to-draft', 'close'] }) }).more).toEqual(['rerun-failed', 'convert-to-draft', 'close'])
  })
})

describe('heroLayout', () => {
  test('wide at and above the threshold, narrow below it', () => {
    expect(heroLayout(wideHeroMin)).toBe('wide')
    expect(heroLayout(1512)).toBe('wide')
    expect(heroLayout(wideHeroMin - 1)).toBe('narrow')
    expect(heroLayout(0)).toBe('narrow')
  })
})
