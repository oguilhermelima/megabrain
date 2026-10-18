import { describe, expect, test } from 'bun:test'
import { thinkingTail } from '@/chat/thinking-tail'

describe('thinkingTail', () => {
  test('a short thought shows whole', () => {
    expect(thinkingTail('  Reading the test first.  ')).toEqual({ text: 'Reading the test first.', hidden: false })
  })

  test('three short lines show whole', () => {
    expect(thinkingTail('One.\nTwo.\nThree.')).toEqual({ text: 'One.\nTwo.\nThree.', hidden: false })
  })

  test('a long thought starts at the earliest sentence that fits', () => {
    const text = `${'Earlier reasoning about the layout. '.repeat(8)}The route file history/[id].tsx is shared. Now I am looking at the tests.`
    const tail = thinkingTail(text, 80)
    expect(tail).toEqual({ text: 'The route file history/[id].tsx is shared. Now I am looking at the tests.', hidden: true })
  })

  test('never more than three lines', () => {
    expect(thinkingTail('a\nb\nc\nd\ne')).toEqual({ text: 'c\nd\ne', hidden: true })
  })

  test('a line start counts as a boundary even without punctuation', () => {
    expect(thinkingTail(`${'x'.repeat(100)} and more words\n- read the file\n- run the tests`, 40)).toEqual({ text: '- read the file\n- run the tests', hidden: true })
  })

  test('a sentence after a closing quote or bracket starts after it', () => {
    expect(thinkingTail(`${'Some words here. '.repeat(10)}He said "done." (It ran.) Then it stopped.`, 30)).toEqual({ text: '(It ran.) Then it stopped.', hidden: true })
  })

  test('a dotted name is not a sentence end', () => {
    expect(thinkingTail(`${'Long words keep going on '.repeat(6)}so open chat-model.ts and read thinkingProgress next`, 50).text.startsWith('ts and')).toBe(false)
  })

  test('one sentence longer than the budget starts at a word with an ellipsis', () => {
    const tail = thinkingTail(`${'word '.repeat(80)}last words here`, 30)
    expect(tail.hidden).toBe(true)
    expect(tail.text.startsWith('…')).toBe(true)
    expect(tail.text.endsWith('last words here')).toBe(true)
    expect(tail.text.slice(1)).toMatch(/^\S/)
    expect(tail.text.length).toBeLessThanOrEqual(31)
  })

  test('blank lines at the end do not take the three lines', () => {
    expect(thinkingTail('a\nb\nc\nd\n\n\n')).toEqual({ text: 'b\nc\nd', hidden: true })
  })
})
