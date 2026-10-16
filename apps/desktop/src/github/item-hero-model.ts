import type { MergeBox, SecondaryAction } from '@/github/merge-box-model'

// What the hero at the top of a pull request shows: the one action it leads with for the state the
// pull request is in, the quieter actions in its more menu, and whether the action bar sits beside
// the title or under it for the pane's width.

/** The hero's lead action; review opens the review panel, the rest are the merge box's own writes. */
export type HeroPrimary = 'review' | 'merge' | 'ready-for-review' | 'reopen'

export interface HeroActions {
  primary: HeroPrimary | null
  /** Review stays in the bar beside a lead merge, so an open pull request can always be reviewed. */
  review: boolean
  /** The more menu: the merge box's quiet actions (re-run failed checks, convert to draft, close). */
  more: SecondaryAction[]
}

export function heroActions({ state, isDraft, box }: { state: string; isDraft: boolean; box: Pick<MergeBox, 'primary' | 'primaryDisabled' | 'secondary'> }): HeroActions {
  if (state === 'merged') return { primary: null, review: false, more: [] }
  if (state === 'closed') return { primary: 'reopen', review: false, more: [] }
  if (isDraft) return { primary: 'ready-for-review', review: true, more: box.secondary }
  const mergeReady = box.primary === 'merge' && !box.primaryDisabled
  return mergeReady ? { primary: 'merge', review: true, more: box.secondary } : { primary: 'review', review: false, more: box.secondary }
}

export type HeroLayout = 'wide' | 'narrow'

/** Below this width the action bar moves under the title, so a long title keeps its line length. */
export const wideHeroMin = 820

export function heroLayout(width: number): HeroLayout {
  return width >= wideHeroMin ? 'wide' : 'narrow'
}
