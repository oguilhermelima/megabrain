// What a thought shows folded: its last lines, starting where a sentence or a line starts, so the preview
// never opens mid-word or mid-sentence. Only one sentence longer than the whole budget starts at a word,
// marked by an ellipsis.

const maxLines = 3

export interface ThinkingTail {
  text: string
  /** Whether anything before the tail is left out. */
  hidden: boolean
}

/** The end of a thought in at most three lines and about budget characters, from a sentence or line start. */
export function thinkingTail(thought: string, budget = 240): ThinkingTail {
  const text = thought.trim()
  const lines = text.split('\n')
  const lineStart = lines.length > maxLines ? text.length - lines.slice(-maxLines).join('\n').length : 0
  const from = Math.max(lineStart, text.length - budget)
  if (from === 0) return { text, hidden: false }
  const start = boundaryFrom(text, from)
  if (start !== null) return { text: text.slice(start), hidden: true }
  const word = text.slice(from).search(/(?<=\s)\S/)
  return { text: `…${word === -1 ? text.slice(from).trimStart() : text.slice(from + word)}`, hidden: true }
}

// The first sentence or line start at or after from: just after a newline, or after a sentence's closing
// punctuation (and any quote or bracket closing it) followed by a space.
function boundaryFrom(text: string, from: number): number | null {
  const boundary = /\n\s*|[.!?…]["')\]’”]*\s+/g
  if (from > 0 && text[from - 1] === '\n') return from
  boundary.lastIndex = Math.max(0, from - 4)
  for (let match = boundary.exec(text); match !== null; match = boundary.exec(text)) {
    const start = match.index + match[0].length
    if (start >= from && start < text.length) return start
  }
  return null
}
