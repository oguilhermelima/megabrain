// What a right click in a chat offers, by what is under the pointer. The innermost target leads
// (a link, then an image, a code block, a tool call), the message around it follows, and scrolling
// to the bottom closes every transcript menu. The views turn each action into its handler.

import { openableUrl } from '@/lib/external'

export type ChatAction =
  | 'open-link'
  | 'copy-link'
  | 'copy-image'
  | 'save-image'
  | 'open-image'
  | 'copy-code'
  | 'insert-code'
  | 'copy-input'
  | 'copy-output'
  | 'copy'
  | 'copy-plain'
  | 'quote'
  | 'select-message'
  | 'scroll-bottom'

export type ComposerAction = 'cut' | 'copy' | 'paste' | 'paste-plain' | 'select-all' | 'attach' | 'clear'

export type MenuModel<A extends string> = { action: A; label: string; shortcut?: string; disabled?: boolean } | { separator: true }

/** What was under the pointer: each part null (or '') when absent. */
export interface ChatMenuTarget {
  /** The text selected in the transcript. */
  selection: string
  message: { markdown: string } | null
  code: string | null
  tool: { command: string | null; input: string | null; output: string | null } | null
  /** `viewer`: the image opens in the app's preview when clicked. */
  image: { viewer: boolean } | null
  link: string | null
  /** The chat has a composer to quote or insert into. */
  canCompose: boolean
}

/** Links the system opens: https and mail. Anything else is only copied. */
export const openableLink = (href: string) => openableUrl(href) !== null

export function chatMenu(target: ChatMenuTarget): MenuModel<ChatAction>[] {
  const sections: MenuModel<ChatAction>[][] = []
  const { selection, message, code, tool, image, link, canCompose } = target
  if (link !== null) sections.push([...(openableLink(link) ? [{ action: 'open-link' as const, label: 'Open link' }] : []), { action: 'copy-link', label: 'Copy link' }])
  if (image !== null)
    sections.push([
      { action: 'copy-image', label: 'Copy image' },
      { action: 'save-image', label: 'Save image as…' },
      ...(image.viewer ? [{ action: 'open-image' as const, label: 'Open in viewer' }] : []),
    ])
  if (code !== null) sections.push([{ action: 'copy-code', label: 'Copy code' }, ...(canCompose ? [{ action: 'insert-code' as const, label: 'Insert into composer' }] : [])])
  if (tool !== null) {
    const items: MenuModel<ChatAction>[] = []
    if (tool.command !== null || tool.input !== null) items.push({ action: 'copy-input', label: tool.command !== null ? 'Copy command' : 'Copy input' })
    if (tool.output !== null) items.push({ action: 'copy-output', label: 'Copy output' })
    if (items.length > 0) sections.push(items)
  }
  const selected = selection !== ''
  // ⌘C copies only a selection, so the shortcut shows only when Copy copies one.
  const copy: MenuModel<ChatAction> = selected ? { action: 'copy', label: 'Copy', shortcut: 'mod+c' } : { action: 'copy', label: 'Copy' }
  const quote = canCompose ? [{ action: 'quote' as const, label: 'Quote in reply' }] : []
  if (message !== null) sections.push([copy, { action: 'copy-plain', label: 'Copy as plain text' }, ...quote, { action: 'select-message', label: 'Select message' }])
  else if (selected) sections.push([copy, ...quote])
  sections.push([{ action: 'scroll-bottom', label: 'Scroll to bottom' }])
  return sections.flatMap((section, index) => (index === 0 ? section : [{ separator: true } as const, ...section]))
}

export function composerMenu({ hasSelection, empty, disabled }: { hasSelection: boolean; empty: boolean; disabled: boolean }): MenuModel<ComposerAction>[] {
  return [
    { action: 'cut', label: 'Cut', shortcut: 'mod+x', disabled: disabled || !hasSelection },
    { action: 'copy', label: 'Copy', shortcut: 'mod+c', disabled: !hasSelection },
    { action: 'paste', label: 'Paste', shortcut: 'mod+v', disabled },
    { action: 'paste-plain', label: 'Paste as plain text', shortcut: 'mod+shift+alt+v', disabled },
    { action: 'select-all', label: 'Select all', shortcut: 'mod+a', disabled: empty },
    { separator: true },
    { action: 'attach', label: 'Attach file…', disabled },
    { action: 'clear', label: 'Clear', disabled: disabled || empty },
  ]
}

/** Text as a markdown quote, every line marked, with a blank line after it to write the reply on. */
export function quoteText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').replace(/^\s*\n/, '').trimEnd().split('\n')
  if (lines.length === 1 && lines[0]?.trim() === '') return ''
  return `${lines.map((line) => (line.trim() === '' ? '>' : `> ${line.trimEnd()}`)).join('\n')}\n\n`
}

/** A block put into the composer starts a paragraph of its own after whatever comes before the caret. */
export function insertBlock(before: string, block: string): string {
  if (before === '' || before.endsWith('\n\n')) return block
  return `${before.endsWith('\n') ? '\n' : '\n\n'}${block}`
}

/** The shell command of a tool call whose input names one, as Bash's does. */
export function toolCommand(input: string | undefined): string | null {
  if (input === undefined) return null
  try {
    const parsed: unknown = JSON.parse(input)
    if (typeof parsed === 'object' && parsed !== null && 'command' in parsed && typeof parsed.command === 'string') return parsed.command
  } catch {
    // Not JSON: no command to read.
  }
  return null
}
