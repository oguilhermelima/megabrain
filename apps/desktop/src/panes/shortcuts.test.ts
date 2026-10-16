import { describe, expect, test } from 'bun:test'
import { paneShortcut } from '@/panes/shortcuts'

const key = (value: string, modifiers: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) => ({
  key: value,
  metaKey: modifiers.meta ?? false,
  shiftKey: modifiers.shift ?? false,
  altKey: modifiers.alt ?? false,
  ctrlKey: modifiers.ctrl ?? false,
})

describe('pane shortcuts', () => {
  test('⌘D splits right, ⌘⇧D splits down', () => {
    expect(paneShortcut(key('d', { meta: true }))).toBe('split-right')
    expect(paneShortcut(key('D', { meta: true, shift: true }))).toBe('split-down')
    expect(paneShortcut(key('d', { meta: true, shift: true }))).toBe('split-down')
  })

  test('⌘W closes the focused pane', () => {
    expect(paneShortcut(key('w', { meta: true }))).toBe('close-pane')
  })

  test('without ⌘, or with ⌥ or ⌃, nothing is a pane shortcut', () => {
    expect(paneShortcut(key('d'))).toBeNull()
    expect(paneShortcut(key('d', { ctrl: true }))).toBeNull()
    expect(paneShortcut(key('d', { meta: true, alt: true }))).toBeNull()
    expect(paneShortcut(key('w', { meta: true, ctrl: true }))).toBeNull()
    expect(paneShortcut(key('w', { meta: true, shift: true }))).toBeNull()
  })

  test('other keys are not pane shortcuts', () => {
    expect(paneShortcut(key('t', { meta: true }))).toBeNull()
    expect(paneShortcut(key('n', { meta: true }))).toBeNull()
  })
})
