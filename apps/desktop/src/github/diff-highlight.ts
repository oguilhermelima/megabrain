import { Language } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import type { PartialParse, Tree } from '@lezer/common'
import { highlightTree } from '@lezer/highlight'
import { languageExtension } from '@/code/languages'
import { runWhenIdle } from '@/lib/idle-work'

// Syntax colours for a diff outside an editor: the editors' One Dark highlight style, its CSS
// mounted once in the document, applied to the lines of one file parsed as one text. The parse runs
// in idle slices of a few milliseconds, and a block of lines is coloured only when one of its rows
// is drawn, so a 20000-line file never holds the main thread; rows read plain until then.

export interface Span {
  text: string
  className: string
}

export interface PatchHighlight {
  /** One row's coloured spans, or null while the parse is still running (draw it plain). */
  spans(row: number): Span[] | null
  /** Called once the parse finishes and rows can be coloured. */
  subscribe(listener: () => void): () => void
  ready(): boolean
  /** Stops the parse and drops the tree and every coloured block. */
  dispose(): void
}

/** Rows coloured together when one of them is drawn. */
const blockRows = 64

let mounted = false

function mountStyle() {
  if (mounted || typeof document === 'undefined') return
  const rules = oneDarkHighlightStyle.module?.getRules()
  if (rules === undefined) return
  const style = document.createElement('style')
  style.textContent = rules
  document.head.append(style)
  mounted = true
}

const never: PatchHighlight = { spans: () => null, subscribe: () => () => {}, ready: () => false, dispose: () => {} }

/** The lines of one patch, parsed in the background as one text in the file's language. */
export function highlightPatch(lines: string[], language: string): PatchHighlight {
  const support = languageExtension(language)
  const parser = support === null ? null : support instanceof Language ? support.parser : support.language.parser
  if (parser === null || lines.length === 0) return never
  mountStyle()
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const text = lines.join('\n')
  let tree: Tree | null = null
  let failed = false
  let parse: PartialParse | null = null
  const listeners = new Set<() => void>()
  const blocks = new Map<number, Span[][]>()

  const cancel = runWhenIdle((timeLeft) => {
    try {
      parse ??= parser.startParse(text)
      while (timeLeft() > 0) {
        const done = parse.advance()
        if (done !== null) {
          tree = done
          parse = null
          for (const listener of listeners) listener()
          return true
        }
      }
      return false
    } catch {
      failed = true
      parse = null
      return true
    }
  })

  const colour = (block: number, parsed: Tree): Span[][] => {
    const first = block * blockRows
    const last = Math.min(lines.length, first + blockRows) - 1
    const from = starts[first] ?? 0
    const to = (starts[last] ?? 0) + (lines[last]?.length ?? 0)
    const classes: string[] = new Array<string>(to - from).fill('')
    try {
      highlightTree(
        parsed,
        oneDarkHighlightStyle,
        (start, end, className) => {
          for (let index = Math.max(start, from); index < Math.min(end, to); index++) classes[index - from] = className
        },
        from,
        to,
      )
    } catch {
      // Plain text for this block.
    }
    const rows: Span[][] = []
    for (let row = first; row <= last; row++) {
      const line = lines[row] ?? ''
      const start = (starts[row] ?? 0) - from
      const spans: Span[] = []
      for (let column = 0; column < line.length; column++) {
        const className = classes[start + column] ?? ''
        const previous = spans.at(-1)
        if (previous !== undefined && previous.className === className) previous.text += line.charAt(column)
        else spans.push({ text: line.charAt(column), className })
      }
      rows.push(spans)
    }
    return rows
  }

  return {
    spans: (row) => {
      if (tree === null || failed) return null
      const block = Math.floor(row / blockRows)
      let rows = blocks.get(block)
      if (rows === undefined) {
        rows = colour(block, tree)
        blocks.set(block, rows)
      }
      return rows[row - block * blockRows] ?? null
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ready: () => tree !== null && !failed,
    dispose: () => {
      cancel()
      parse = null
      tree = null
      blocks.clear()
      listeners.clear()
    },
  }
}
