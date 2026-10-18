import { describe, expect, test } from 'bun:test'
import { mayTakeFocus, rovingIndex, safeDecision } from '@/native-chat/approval-keys'

describe('rovingIndex', () => {
  test('right and down move to the next decision, wrapping at the end', () => {
    expect(rovingIndex('ArrowRight', 0, 3)).toBe(1)
    expect(rovingIndex('ArrowDown', 1, 3)).toBe(2)
    expect(rovingIndex('ArrowRight', 2, 3)).toBe(0)
  })

  test('left and up move to the previous decision, wrapping at the start', () => {
    expect(rovingIndex('ArrowLeft', 2, 3)).toBe(1)
    expect(rovingIndex('ArrowUp', 1, 3)).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, 3)).toBe(2)
  })

  test('Home and End reach the ends', () => {
    expect(rovingIndex('Home', 2, 3)).toBe(0)
    expect(rovingIndex('End', 0, 3)).toBe(2)
  })

  test('a single decision stays put', () => {
    expect(rovingIndex('ArrowRight', 0, 1)).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, 1)).toBe(0)
  })

  test('Enter, Space and other keys are left to the buttons', () => {
    expect(rovingIndex('Enter', 0, 3)).toBeNull()
    expect(rovingIndex(' ', 0, 3)).toBeNull()
    expect(rovingIndex('a', 0, 3)).toBeNull()
  })

  test('no decisions, no move', () => {
    expect(rovingIndex('ArrowRight', 0, 0)).toBeNull()
  })
})

describe('safeDecision', () => {
  test('Deny wherever it stands', () => {
    expect(safeDecision(['allow', 'allow-session', 'deny'])).toBe(2)
    expect(safeDecision(['deny', 'allow'])).toBe(0)
  })

  test('the first decision when Deny is not offered', () => {
    expect(safeDecision(['allow', 'allow-session'])).toBe(0)
  })
})

describe('mayTakeFocus', () => {
  test('takes the focus from nothing or from an element that is not a field', () => {
    expect(mayTakeFocus(null)).toBe(true)
    expect(mayTakeFocus({ editable: false, text: 'a button label' })).toBe(true)
  })

  test('takes it from an empty composer', () => {
    expect(mayTakeFocus({ editable: true, text: '' })).toBe(true)
    expect(mayTakeFocus({ editable: true, text: '  \n' })).toBe(true)
  })

  test('never from a composer the person is typing in', () => {
    expect(mayTakeFocus({ editable: true, text: 'half a sentence' })).toBe(false)
  })
})
