import { describe, expect, test } from 'bun:test'
import { ariaChecked, checkboxMark, toggled } from '@/components/checkbox-model'

describe('checkboxMark', () => {
  test('follows checked when not indeterminate', () => {
    expect(checkboxMark(true)).toBe('checked')
    expect(checkboxMark(false)).toBe('unchecked')
    expect(checkboxMark(true, false)).toBe('checked')
  })

  test('indeterminate wins over checked', () => {
    expect(checkboxMark(true, true)).toBe('indeterminate')
    expect(checkboxMark(false, true)).toBe('indeterminate')
  })
})

describe('ariaChecked', () => {
  test('maps each mark to its ARIA value', () => {
    expect(ariaChecked('checked')).toBe('true')
    expect(ariaChecked('unchecked')).toBe('false')
    expect(ariaChecked('indeterminate')).toBe('mixed')
  })
})

describe('toggled', () => {
  test('a click flips a plain box', () => {
    expect(toggled('checked')).toBe(false)
    expect(toggled('unchecked')).toBe(true)
  })

  test('a click on a mixed box checks it, whatever checked held underneath', () => {
    expect(toggled('indeterminate')).toBe(true)
  })
})
