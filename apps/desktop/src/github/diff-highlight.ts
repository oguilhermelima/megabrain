import { Language } from '@codemirror/language'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { highlightTree } from '@lezer/highlight'
import { languageExtension } from '@/code/languages'

// Syntax colours for a diff outside an editor: the editors' One Dark highlight style, its CSS
// mounted once in the document, applied to the lines of one file parsed as one text.

export interface Span {
  text: string
  className: string
}

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

/** Each line as coloured spans; one plain span per line when the language is unknown. */
export function highlightLines(lines: string[], language: string): Span[][] {
  const plain = () => lines.map((text) => [{ text, className: '' }])
  const support = languageExtension(language)
  const parser = support === null ? null : support instanceof Language ? support.parser : support.language.parser
  if (parser === null) return plain()
  mountStyle()
  const text = lines.join('\n')
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  // Classes for every character the tree colours; the rest stays plain.
  const classes: string[] = new Array<string>(text.length).fill('')
  try {
    highlightTree(parser.parse(text), oneDarkHighlightStyle, (from, to, className) => {
      for (let index = from; index < to; index++) classes[index] = className
    })
  } catch {
    return plain()
  }
  return lines.map((line, row) => {
    const start = starts[row] ?? 0
    const spans: Span[] = []
    for (let column = 0; column < line.length; column++) {
      const className = classes[start + column] ?? ''
      const last = spans.at(-1)
      if (last !== undefined && last.className === className) last.text += line.charAt(column)
      else spans.push({ text: line.charAt(column), className })
    }
    return spans
  })
}
