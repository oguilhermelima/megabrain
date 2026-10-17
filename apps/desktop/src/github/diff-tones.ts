import type { DiffLine } from '@/github/review-model'

// How a diff line looks wherever one is drawn: a pull request's Files tab and an edit in a chat.

export const lineTone: Record<DiffLine['kind'], string> = {
  add: 'bg-ok/[0.10]',
  del: 'bg-bad/[0.10]',
  context: '',
  hunk: 'bg-accent/[0.08] text-ink-400',
  note: 'text-ink-500 italic',
}

export const markers: Record<DiffLine['kind'], string> = {
  add: '+',
  del: '-',
  context: ' ',
  hunk: '',
  note: '',
}
