import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { StreamLanguage } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { MergeView } from '@codemirror/merge'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

/** A pure-black theme matching the app chrome (apps/desktop/src/styles.css). */
const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#000000', color: '#f5f5f7', height: '100%' },
    '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '13px' },
    '.cm-gutters': { backgroundColor: '#000000', color: '#4c4c55', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-cursor': { display: 'none' },
  },
  { dark: true },
)

const readOnlyExtensions: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

function languageExtension(language: string): Extension {
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
      return []
  }
}

/** A read-only CodeMirror editor with syntax highlighting and line numbers. */
export function CodeEditor({ text, language }: { text: string; language: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const previousScrollTop = viewRef.current?.scrollDOM.scrollTop ?? 0
    viewRef.current?.destroy()
    const view = new EditorView({
      state: EditorState.create({ doc: text, extensions: [basicSetup, languageExtension(language), darkTheme, ...readOnlyExtensions] }),
      parent: container,
    })
    view.scrollDOM.scrollTop = previousScrollTop
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [text, language])

  return <div ref={containerRef} className="h-full overflow-hidden" />
}

/** A read-only side-by-side diff: original on the left, modified on the right. */
export function CodeDiffEditor({ original, modified, language }: { original: string; modified: string; language: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<MergeView | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const previousScrollTop = viewRef.current?.a.scrollDOM.scrollTop ?? 0
    viewRef.current?.destroy()
    const extensions = [languageExtension(language), darkTheme, ...readOnlyExtensions]
    const view = new MergeView({
      a: { doc: original, extensions },
      b: { doc: modified, extensions },
      parent: container,
      highlightChanges: true,
      gutter: true,
    })
    view.a.scrollDOM.scrollTop = previousScrollTop
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [original, modified, language])

  return <div ref={containerRef} className="h-full overflow-hidden [&_.cm-merge-a]:h-full [&_.cm-merge-b]:h-full [&_.cm-mergeView]:h-full" />
}
