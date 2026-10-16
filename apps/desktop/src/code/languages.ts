import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { StreamLanguage, type Language, type LanguageSupport } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'

// The CodeMirror language behind each language key of languageForPath (code-model.ts), for the
// editors and for highlighting a diff outside one.

/** The language for a key; null for plain text. */
export function languageExtension(language: string): LanguageSupport | Language | null {
  switch (language) {
    case 'typescript':
      return javascript({ typescript: true, jsx: true })
    case 'javascript':
      return javascript({ jsx: true })
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'rust':
      return rust()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'python':
      return python()
    case 'shell':
      return StreamLanguage.define(shell)
    default:
      return null
  }
}
