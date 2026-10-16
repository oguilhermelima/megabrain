import type { MessagePart } from '@/api/schema'
import { attachmentKind } from '@/chat/composer-model'

// The composer's content as text runs and attachment tokens, in order. An offset counts each
// character of text and each token as one, the way the caret moves through the box.

export type DraftPart = { type: 'text'; text: string } | { type: 'token'; id: string }
export type Draft = DraftPart[]

/** The object replacement character stands in for a token wherever the draft is read as a string. */
export const tokenCharacter = '￼'

const partLength = (part: DraftPart) => (part.type === 'text' ? part.text.length : 1)

export function draftLength(draft: Draft): number {
  return draft.reduce((total, part) => total + partLength(part), 0)
}

export function draftText(draft: Draft): string {
  return draft.map((part) => (part.type === 'text' ? part.text : tokenCharacter)).join('')
}

/** Adjacent text runs merged and empty ones dropped, so equal content has one shape. */
function normalize(draft: Draft): Draft {
  const result: Draft = []
  for (const part of draft) {
    if (part.type === 'text') {
      if (part.text === '') continue
      const last = result.at(-1)
      if (last?.type === 'text') {
        result[result.length - 1] = { type: 'text', text: last.text + part.text }
        continue
      }
    }
    result.push(part)
  }
  return result
}

/** The draft cut at an offset into what comes before and what comes after. */
function split(draft: Draft, offset: number): [Draft, Draft] {
  const before: Draft = []
  const after: Draft = []
  let position = 0
  for (const part of draft) {
    const length = partLength(part)
    if (position + length <= offset) before.push(part)
    else if (position >= offset) after.push(part)
    else if (part.type === 'text') {
      before.push({ type: 'text', text: part.text.slice(0, offset - position) })
      after.push({ type: 'text', text: part.text.slice(offset - position) })
    }
    position += length
  }
  return [before, after]
}

function insert(draft: Draft, offset: number, part: DraftPart): Draft {
  const [before, after] = split(draft, offset)
  return normalize([...before, part, ...after])
}

export function insertText(draft: Draft, offset: number, text: string): Draft {
  return insert(draft, offset, { type: 'text', text })
}

export function insertToken(draft: Draft, offset: number, id: string): Draft {
  return insert(draft, offset, { type: 'token', id })
}

export function deleteRange(draft: Draft, start: number, end: number): Draft {
  if (end <= start) return draft
  const [before] = split(draft, start)
  const [, after] = split(draft, end)
  return normalize([...before, ...after])
}

/** The token just before the caret, which Backspace removes whole. */
export function tokenBefore(draft: Draft, offset: number): string | null {
  if (offset <= 0) return null
  const [before] = split(draft, offset)
  const last = before.at(-1)
  return last?.type === 'token' ? last.id : null
}

/** The token just after the caret, which Delete removes whole. */
export function tokenAfter(draft: Draft, offset: number): string | null {
  const [, after] = split(draft, offset)
  const first = after[0]
  return first?.type === 'token' ? first.id : null
}

export function tokenOffset(draft: Draft, id: string): number | null {
  let position = 0
  for (const part of draft) {
    if (part.type === 'token' && part.id === id) return position
    position += partLength(part)
  }
  return null
}

export function tokenIds(draft: Draft): string[] {
  return draft.flatMap((part) => (part.type === 'token' ? [part.id] : []))
}

const kindLabels = { image: 'Image', pdf: 'PDF' }

/** Each token's label by its place in the draft: images as Image 1, Image 2, and PDFs counted on their own. */
export function tokenLabels(draft: Draft, kindOf: (id: string) => 'image' | 'pdf'): Map<string, string> {
  const counts = { image: 0, pdf: 0 }
  const labels = new Map<string, string>()
  for (const id of tokenIds(draft)) {
    const kind = kindOf(id)
    counts[kind] += 1
    labels.set(id, `${kindLabels[kind]} ${counts[kind]}`)
  }
  return labels
}

/** Moves a token to where it was dropped; `offset` is a caret position in the draft as it stood. */
export function moveToken(draft: Draft, id: string, offset: number): Draft {
  const from = tokenOffset(draft, id)
  if (from === null) return draft
  const without = deleteRange(draft, from, from + 1)
  return insertToken(without, offset > from ? offset - 1 : offset, id)
}

/** Text next to an image is trimmed on that side, and the message ends are trimmed; blank text goes. */
function tidy(parts: MessagePart[]): MessagePart[] {
  const tidied: MessagePart[] = []
  parts.forEach((part, index) => {
    if (part.type !== 'text') {
      tidied.push(part)
      return
    }
    let text = part.text
    if (index === 0 || parts[index - 1]?.type === 'image') text = text.trimStart()
    if (index === parts.length - 1 || parts[index + 1]?.type === 'image') text = text.trimEnd()
    if (text !== '') tidied.push({ type: 'text', text })
  })
  return tidied
}

const pdfMark = '\u0000'
const pdfLine = /\s*\u0000([^\u0000]*)\u0000\s*/g

function mergeText(parts: MessagePart[]): MessagePart[] {
  const merged: MessagePart[] = []
  for (const part of parts) {
    const last = merged.at(-1)
    if (part.type === 'text' && last?.type === 'text') merged[merged.length - 1] = { type: 'text', text: last.text + part.text }
    else merged.push(part)
  }
  return merged
}

/**
 * The message as the agents take it: text and images in order. A PDF has no part of its own, so it
 * goes as its path on its own line inside the text.
 */
export function toMessageParts(draft: Draft, resolve: (id: string) => { kind: 'image' | 'pdf'; path: string }): MessagePart[] {
  const parts = draft.map((part): MessagePart => {
    if (part.type === 'text') return part
    const attachment = resolve(part.id)
    return attachment.kind === 'image' ? { type: 'image', path: attachment.path } : { type: 'text', text: `${pdfMark}${attachment.path}${pdfMark}` }
  })
  // Whitespace around a PDF's line goes, as it does around an image.
  const lined = mergeText(parts).map((part) => (part.type === 'text' ? { type: 'text' as const, text: part.text.replace(pdfLine, '\n$1\n') } : part))
  return tidy(lined)
}

/** For an agent that reads a terminal: the text, with each image path on its own line where the image sits. */
export function messagePartsToText(parts: MessagePart[]): string {
  return parts
    .map((part) => (part.type === 'image' ? part.path : part.text.trim()))
    .filter((line) => line !== '')
    .join('\n')
}

/** An absolute path to an image, alone on its line: how a message written for a terminal carries one. */
export function isAttachmentPath(line: string): boolean {
  if (!line.startsWith('/')) return false
  return attachmentKind('', line.split('/').at(-1) ?? '')?.kind === 'image'
}

/** The inverse of messagePartsToText: each line that is an image path becomes an image part. */
export function messagePartsFromText(text: string): MessagePart[] {
  const parts: MessagePart[] = []
  let lines: string[] = []
  const flush = () => {
    if (lines.length > 0) parts.push({ type: 'text', text: lines.join('\n') })
    lines = []
  }
  for (const line of text.split('\n')) {
    if (isAttachmentPath(line.trim())) {
      flush()
      parts.push({ type: 'image', path: line.trim() })
    } else lines.push(line)
  }
  flush()
  return tidy(parts)
}
