import { syntaxHighlighting } from '@codemirror/language'
import { diffColumns } from '@/code/code-model'
import { languageExtension } from '@/code/languages'
import { MergeView, unifiedMergeView } from '@codemirror/merge'
import { EditorState, type Extension } from '@codemirror/state'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { EditorView, lineNumbers } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { useEffect, useRef } from 'react'

/** A pure-black theme matching the app chrome (apps/desktop/src/styles.css). */
const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#000000', color: '#f5f5f7', height: '100%' },
    '.cm-scroller': { overflow: 'auto', overscrollBehavior: 'none', fontFamily: 'var(--font-mono)', fontSize: '13px' },
    // A side-by-side diff's sides scroll only sideways; the view around them scrolls down.
    '.cm-mergeView & .cm-scroller': { overscrollBehaviorY: 'auto' },
    '.cm-gutters': { backgroundColor: '#000000', color: '#4c4c55', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-cursor': { display: 'none' },
  },
  { dark: true },
)

const readOnlyExtensions: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false)]

const syntaxColors: Extension = syntaxHighlighting(oneDarkHighlightStyle)


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
      state: EditorState.create({ doc: text, extensions: [basicSetup, languageExtension(language) ?? [], darkTheme, syntaxColors, ...readOnlyExtensions] }),
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

/**
 * A read-only side-by-side diff: original on the left, modified on the right. A new file shows once,
 * every line marked added; marking its text as changed would underline all of it.
 */
export function CodeDiffEditor({ original, modified, language }: { original: string; modified: string; language: string }) {
  if (diffColumns(original, modified) === 'one') return <NewFileEditor text={modified} language={language} />
  return <SideBySideEditor original={original} modified={modified} language={language} />
}

function NewFileEditor({ text, language }: { text: string; language: string }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const extensions = [languageExtension(language) ?? [], darkTheme, syntaxColors, lineNumbers(), unifiedMergeView({ original: '', highlightChanges: false, mergeControls: false }), ...readOnlyExtensions]
    const view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: container })
    return () => view.destroy()
  }, [text, language])

  return <div ref={containerRef} className="h-full overflow-hidden" />
}

function SideBySideEditor({ original, modified, language }: { original: string; modified: string; language: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<MergeView | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const previousScrollTop = viewRef.current?.a.scrollDOM.scrollTop ?? 0
    viewRef.current?.destroy()
    const extensions = [languageExtension(language) ?? [], darkTheme, syntaxColors, lineNumbers(), ...readOnlyExtensions]
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

  return <div ref={containerRef} className="h-full overflow-hidden [&_.cm-merge-a]:h-full [&_.cm-merge-b]:h-full [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overscroll-y-none" />
}
