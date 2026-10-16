import type { GithubDetail, GithubReviewers } from '@/api/schema'

// The conversation as a timeline: the description first, as its author's opening entry, then the
// comments and the submitted reviews in the order they happened.

type Person = GithubDetail['author']

export type TimelineEntry =
  | { kind: 'opened'; key: string; author: Person; at: string | null; body: string }
  | { kind: 'comment'; key: string; author: Person; at: string; body: string; url: string }
  | { kind: 'review'; key: string; author: Person; at: string | null; state: string }

export function timeline(detail: Pick<GithubDetail, 'author' | 'createdAt' | 'body' | 'comments'>, reviews: GithubReviewers['reviews'] = []): TimelineEntry[] {
  const later: { at: number; order: number; entry: TimelineEntry }[] = []
  detail.comments.forEach((comment, index) => later.push({ at: Date.parse(comment.createdAt), order: later.length, entry: { kind: 'comment', key: `comment-${index}-${comment.url}`, author: comment.author, at: comment.createdAt, body: comment.body, url: comment.url } }))
  // A pending review is the viewer's own draft, not something that happened yet.
  reviews
    .filter((review) => review.state !== 'pending')
    .forEach((review, index) => later.push({ at: review.submittedAt === null ? Number.NaN : Date.parse(review.submittedAt), order: later.length, entry: { kind: 'review', key: `review-${index}`, author: review.author, at: review.submittedAt, state: review.state } }))
  // Unknown times go last, each kind keeping the order the CLI gave.
  const time = (value: number) => (Number.isNaN(value) ? Number.POSITIVE_INFINITY : value)
  later.sort((left, right) => time(left.at) - time(right.at) || left.order - right.order)
  return [{ kind: 'opened', key: 'opened', author: detail.author, at: detail.createdAt, body: detail.body }, ...later.map((item) => item.entry)]
}

/** What a review says in the timeline: "approved these changes" and the like. */
export function reviewVerb(state: string): { text: string; tone: 'ok' | 'bad' | 'muted' } {
  if (state === 'approved') return { text: 'approved these changes', tone: 'ok' }
  if (state === 'changes_requested') return { text: 'requested changes', tone: 'bad' }
  if (state === 'dismissed') return { text: 'left a review that was dismissed', tone: 'muted' }
  return { text: 'reviewed', tone: 'muted' }
}
