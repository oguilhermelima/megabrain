import { describe, expect, test } from 'bun:test'
import type { MessagePart } from '@/api/schema'
import { deleteRange, draftLength, draftText, insertText, insertToken, isAttachmentPath, messagePartsFromText, messagePartsToText, moveToken, tokenBefore, tokenLabels, toMessageParts, type Draft } from '@/chat/composer-parts'

const text = (value: string) => ({ type: 'text' as const, text: value })
const token = (id: string) => ({ type: 'token' as const, id })
const image = (path: string): MessagePart => ({ type: 'image', path })

// Attachments as the composer resolves them when the message is sent.
const saved: Record<string, { kind: 'image' | 'pdf'; path: string }> = {
  a: { kind: 'image', path: '/s/a.png' },
  b: { kind: 'image', path: '/s/b.jpg' },
  p: { kind: 'pdf', path: '/s/spec.pdf' },
}
const resolve = (id: string) => {
  const found = saved[id]
  if (found === undefined) throw new Error(`no attachment ${id}`)
  return found
}

describe('draft offsets', () => {
  test('a token counts as one character', () => {
    expect(draftLength([text('ab'), token('a'), text('cd')])).toBe(5)
    expect(draftLength([])).toBe(0)
  })

  test('draftText marks each token with the object replacement character', () => {
    expect(draftText([text('ab'), token('a'), text('cd')])).toBe('ab￼cd')
  })
})

describe('insertText', () => {
  test('inserts inside a text run', () => {
    expect(insertText([text('held')], 2, 'llo wor')).toEqual([text('hello world')])
  })

  test('inserts at either side of a token and merges with the neighbouring text', () => {
    const draft: Draft = [text('ab'), token('a'), text('cd')]
    expect(insertText(draft, 2, 'X')).toEqual([text('abX'), token('a'), text('cd')])
    expect(insertText(draft, 3, 'X')).toEqual([text('ab'), token('a'), text('Xcd')])
  })

  test('into an empty draft', () => {
    expect(insertText([], 0, 'hi')).toEqual([text('hi')])
  })

  test('an offset past the end appends', () => {
    expect(insertText([text('ab')], 99, 'c')).toEqual([text('abc')])
  })
})

describe('insertToken', () => {
  test('splits a text run at the caret', () => {
    expect(insertToken([text('look here')], 4, 'a')).toEqual([text('look'), token('a'), text(' here')])
  })

  test('at the start, at the end and next to another token', () => {
    expect(insertToken([text('x')], 0, 'a')).toEqual([token('a'), text('x')])
    expect(insertToken([text('x')], 1, 'a')).toEqual([text('x'), token('a')])
    expect(insertToken([token('a')], 1, 'b')).toEqual([token('a'), token('b')])
    expect(insertToken([], 0, 'a')).toEqual([token('a')])
  })
})

describe('deleteRange', () => {
  test('removes text across runs and the tokens inside the range', () => {
    expect(deleteRange([text('ab'), token('a'), text('cd')], 1, 4)).toEqual([text('ad')])
  })

  test('Backspace right after a token removes only the token', () => {
    const draft: Draft = [text('ab'), token('a'), text('cd')]
    expect(tokenBefore(draft, 3)).toBe('a')
    expect(tokenBefore(draft, 2)).toBeNull()
    expect(tokenBefore(draft, 0)).toBeNull()
    expect(deleteRange(draft, 2, 3)).toEqual([text('abcd')])
  })

  test('an empty range changes nothing', () => {
    const draft: Draft = [text('ab'), token('a')]
    expect(deleteRange(draft, 1, 1)).toEqual(draft)
  })
})

describe('moveToken', () => {
  const draft: Draft = [text('one '), token('a'), text(' two three')]

  test('moves a token forward: the offset is where it was dropped in the draft as it stood', () => {
    // Dropped after "two" (offset 4 + 1 + 4 = 9).
    expect(moveToken(draft, 'a', 9)).toEqual([text('one  two'), token('a'), text(' three')])
  })

  test('moves a token backward to the start', () => {
    expect(moveToken(draft, 'a', 0)).toEqual([token('a'), text('one  two three')])
  })

  test('dropping a token on either side of itself leaves the draft as it was', () => {
    expect(moveToken(draft, 'a', 4)).toEqual(draft)
    expect(moveToken(draft, 'a', 5)).toEqual(draft)
  })

  test('an unknown token changes nothing', () => {
    expect(moveToken(draft, 'zz', 0)).toEqual(draft)
  })

  test('reorders two tokens', () => {
    expect(moveToken([token('a'), token('b')], 'a', 2)).toEqual([token('b'), token('a')])
  })
})

describe('toMessageParts', () => {
  test('keeps text and images in order, an image in the middle of the text', () => {
    expect(toMessageParts([text('compare '), token('a'), text(' with '), token('b')], resolve)).toEqual([text('compare'), image('/s/a.png'), text('with'), image('/s/b.jpg')])
  })

  test('drops empty and blank text, trims the message ends', () => {
    expect(toMessageParts([text('  \n'), token('a'), text('   ')], resolve)).toEqual([image('/s/a.png')])
    expect(toMessageParts([text('  hi  ')], resolve)).toEqual([text('hi')])
    expect(toMessageParts([], resolve)).toEqual([])
  })

  test('a PDF goes as its path on its own line inside the text', () => {
    expect(toMessageParts([text('read '), token('p'), text(' now')], resolve)).toEqual([text('read\n/s/spec.pdf\nnow')])
  })
})

describe('messagePartsToText', () => {
  test('puts each image path on its own line where the image sits', () => {
    expect(messagePartsToText([text('compare'), image('/s/a.png'), text('with'), image('/s/b.jpg')])).toBe('compare\n/s/a.png\nwith\n/s/b.jpg')
  })

  // The behaviour existing sessions had before images moved inline: text first, paths after.
  test('text then images is the text with one path per line after it', () => {
    expect(messagePartsToText([text('look at this'), image('/a/one.png'), image('/a/two.png')])).toBe('look at this\n/a/one.png\n/a/two.png')
    expect(messagePartsToText([text('look  \n\n'), image('/a/one.png')])).toBe('look\n/a/one.png')
    expect(messagePartsToText([image('/a/one.png')])).toBe('/a/one.png')
    expect(messagePartsToText([text(' hi ')])).toBe('hi')
  })
})

describe('messagePartsFromText', () => {
  test('a line that is an image path becomes an image part', () => {
    expect(messagePartsFromText('compare\n/s/a.png\nwith\n/s/b.jpg')).toEqual([text('compare'), image('/s/a.png'), text('with'), image('/s/b.jpg')])
  })

  test('paths with spaces count; commands, relative paths and other files do not', () => {
    expect(isAttachmentPath('/Users/me/Desktop/Screen Shot 1.png')).toBe(true)
    expect(isAttachmentPath('/compact')).toBe(false)
    expect(isAttachmentPath('shots/a.png')).toBe(false)
    expect(isAttachmentPath('/s/notes.txt')).toBe(false)
    expect(isAttachmentPath('see /s/a.png')).toBe(false)
  })

  test('keeps blank lines inside a text run', () => {
    expect(messagePartsFromText('a\n\nb')).toEqual([text('a\n\nb')])
  })
})

describe('round trip', () => {
  const messages: MessagePart[][] = [
    [text('compare'), image('/s/a.png'), text('with'), image('/s/b.jpg')],
    [image('/s/a.png'), text('first line\n\nsecond')],
    [image('/s/a.png'), image('/s/b.jpg')],
    [text('only text')],
  ]

  test('parts to text and back are the same parts', () => {
    for (const parts of messages) expect(messagePartsFromText(messagePartsToText(parts))).toEqual(parts)
  })

  test('text to parts and back is the same text', () => {
    for (const parts of messages) {
      const serialized = messagePartsToText(parts)
      expect(messagePartsToText(messagePartsFromText(serialized))).toBe(serialized)
    }
  })

  test('a draft sent and restored keeps its images where they were', () => {
    const parts = toMessageParts([text('look '), token('a'), text(' then '), token('b')], resolve)
    expect(messagePartsFromText(messagePartsToText(parts))).toEqual(parts)
  })
})

describe('tokenLabels', () => {
  const kinds: Record<string, 'image' | 'pdf'> = { a: 'image', b: 'image', c: 'image', p: 'pdf', q: 'pdf' }
  const kindOf = (id: string) => kinds[id] ?? 'image'
  const labels = (draft: Draft) => Object.fromEntries(tokenLabels(draft, kindOf))
  const base = insertToken(insertToken(insertText([], 0, 'hi '), 3, 'a'), 4, 'b')

  test('images are numbered in the order they appear', () => {
    expect(labels(base)).toEqual({ a: 'Image 1', b: 'Image 2' })
    expect(labels([])).toEqual({})
  })

  test('an image inserted before the others takes the first number', () => {
    expect(labels(insertToken(base, 0, 'c'))).toEqual({ c: 'Image 1', a: 'Image 2', b: 'Image 3' })
  })

  test('moving a token renumbers by the new order', () => {
    expect(labels(moveToken(base, 'b', 0))).toEqual({ b: 'Image 1', a: 'Image 2' })
  })

  test('deleting a token renumbers the rest', () => {
    expect(labels(deleteRange(base, 3, 4))).toEqual({ b: 'Image 1' })
  })

  test('PDFs are numbered on their own', () => {
    const mixed = insertToken(insertToken(base, 3, 'p'), 0, 'q')
    expect(labels(mixed)).toEqual({ q: 'PDF 1', p: 'PDF 2', a: 'Image 1', b: 'Image 2' })
  })
})
