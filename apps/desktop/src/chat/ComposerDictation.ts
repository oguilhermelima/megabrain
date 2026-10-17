import { useRef } from 'react'
import type { Notice } from '@/chat/composer-look'
import { draftText, insertText, type Draft } from '@/chat/composer-parts'
import { useDictation } from '@/chat/ComposerSupport'

export function useComposerDictation({ current, selection, apply, show }: {
  current: () => Draft
  selection: () => [number, number]
  apply: (next: Draft, offset: number) => void
  show: (next: Notice | null) => void
}) {
  // Dictation writes at the caret where it started, replacing what it wrote before as it hears more.
  const dictationBase = useRef<{ draft: Draft; offset: number } | null>(null)
  return useDictation(
    () => {
      dictationBase.current = { draft: current(), offset: selection()[1] }
    },
    (spoken) => {
      const base = dictationBase.current
      if (base === null) return
      const before = draftText(base.draft).slice(0, base.offset)
      const words = spoken.trimStart()
      const text = before === '' || /\s$/.test(before) ? words : ` ${words}`
      apply(insertText(base.draft, base.offset, text), base.offset + text.length)
    },
    (message) => show({ tone: 'bad', text: message }),
  )
}
