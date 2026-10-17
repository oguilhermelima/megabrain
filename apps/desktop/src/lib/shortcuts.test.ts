import { describe, expect, test } from 'bun:test'
import {
  bindingsOf,
  comboLabel,
  comboOf,
  matchShortcut,
  noShortcutOverrides,
  parseShortcutOverrides,
  rebindShortcut,
  resetShortcut,
  saveShortcutOverrides,
  shortcutConflicts,
  shortcuts,
  type KeyLike,
} from '@/lib/shortcuts'

const press = (key: string, code: string, modifiers: Partial<Pick<KeyLike, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {}): KeyLike => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
})

describe('the shortcut registry', () => {
  test('every shortcut the app had keeps a place, with one id each', () => {
    const ids: string[] = shortcuts.map((shortcut) => shortcut.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['settings.open', 'chat.new', 'terminal.new', 'sidebar.toggle', 'sidebar.focus', 'sidebar.search', 'item.next', 'item.previous', 'pane.splitRight', 'pane.splitDown', 'pane.close', 'pane.next', 'pane.previous', 'pane.focusLeft', 'pane.focusRight', 'pane.focusUp', 'pane.focusDown', 'view.agent', 'view.code', 'view.pr', 'view.diff', 'view.device']) {
      expect(ids).toContain(id)
    }
    expect(shortcuts.every((shortcut) => shortcut.label !== '' && shortcut.group !== '' && shortcut.keys.length > 0)).toBe(true)
  })

  test("the defaults follow Orca's where Orca has the same action", () => {
    const keys = bindingsOf(noShortcutOverrides)
    expect(keys['chat.new']).toEqual(['mod+n', 'mod+shift+n'])
    expect(keys['terminal.new']).toEqual(['mod+t'])
    expect(keys['pane.close']).toEqual(['mod+w'])
    expect(keys['item.next']).toEqual(['mod+shift+]'])
    expect(keys['item.previous']).toEqual(['mod+shift+['])
    expect(keys['pane.next']).toEqual(['mod+]'])
    expect(keys['pane.previous']).toEqual(['mod+['])
    expect(keys['pane.splitRight']).toEqual(['mod+d'])
    expect(keys['pane.splitDown']).toEqual(['mod+shift+d'])
    expect(keys['sidebar.toggle']).toEqual(['mod+b'])
    expect(keys['sidebar.focus']).toEqual(['mod+shift+0'])
    // Orca leaves Settings unbound by default; megabrain keeps its ⌘,.
    expect(keys['settings.open']).toEqual(['mod+,'])
    expect(keys['pane.focusLeft']).toEqual(['mod+alt+left'])
    expect(keys['view.agent']).toEqual(['mod+1'])
  })

  test('the defaults have no conflicts', () => {
    expect(shortcutConflicts(bindingsOf(noShortcutOverrides))).toEqual({})
  })

  test('the pane bar views are listed but cannot be changed here', () => {
    expect(shortcuts.filter((shortcut) => shortcut.fixed === true).map((shortcut) => shortcut.id)).toEqual(['view.agent', 'view.code', 'view.pr', 'view.diff', 'view.device'])
    expect(rebindShortcut(noShortcutOverrides, 'view.agent', ['mod+9'])).toEqual(noShortcutOverrides)
  })
})

describe('comboOf', () => {
  test('names a key press by its physical key and its modifiers, ⌘ as mod on a Mac', () => {
    expect(comboOf(press('d', 'KeyD', { metaKey: true }), true)).toBe('mod+d')
    expect(comboOf(press('D', 'KeyD', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+d')
    expect(comboOf(press('}', 'BracketRight', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+]')
    expect(comboOf(press('ArrowLeft', 'ArrowLeft', { metaKey: true, altKey: true }), true)).toBe('mod+alt+left')
    expect(comboOf(press(')', 'Digit0', { metaKey: true, shiftKey: true }), true)).toBe('mod+shift+0')
    expect(comboOf(press(',', 'Comma', { metaKey: true }), true)).toBe('mod+,')
    expect(comboOf(press('Tab', 'Tab', { ctrlKey: true }), true)).toBe('ctrl+tab')
  })

  test('Ctrl is mod away from a Mac', () => {
    expect(comboOf(press('d', 'KeyD', { ctrlKey: true }), false)).toBe('mod+d')
  })

  test('a lone modifier is no combination yet', () => {
    expect(comboOf(press('Meta', 'MetaLeft', { metaKey: true }), true)).toBeNull()
    expect(comboOf(press('Shift', 'ShiftLeft', { shiftKey: true }), true)).toBeNull()
  })
})

describe('matchShortcut', () => {
  const defaults = bindingsOf(noShortcutOverrides)

  test('finds the action bound to a press', () => {
    expect(matchShortcut(press('d', 'KeyD', { metaKey: true }), defaults, true)).toBe('pane.splitRight')
    expect(matchShortcut(press('D', 'KeyD', { metaKey: true, shiftKey: true }), defaults, true)).toBe('pane.splitDown')
    expect(matchShortcut(press('w', 'KeyW', { metaKey: true }), defaults, true)).toBe('pane.close')
    expect(matchShortcut(press('ArrowUp', 'ArrowUp', { metaKey: true, altKey: true }), defaults, true)).toBe('pane.focusUp')
    expect(matchShortcut(press('}', 'BracketRight', { metaKey: true, shiftKey: true }), defaults, true)).toBe('item.next')
  })

  test('extra modifiers are a different press', () => {
    expect(matchShortcut(press('w', 'KeyW', { metaKey: true, shiftKey: true }), defaults, true)).toBeNull()
    expect(matchShortcut(press('d', 'KeyD'), defaults, true)).toBeNull()
  })

  test('an override replaces the default keys', () => {
    const bindings = bindingsOf(rebindShortcut(noShortcutOverrides, 'pane.close', ['mod+shift+w']))
    expect(matchShortcut(press('w', 'KeyW', { metaKey: true }), bindings, true)).toBeNull()
    expect(matchShortcut(press('W', 'KeyW', { metaKey: true, shiftKey: true }), bindings, true)).toBe('pane.close')
  })
})

describe('overrides', () => {
  test('a rebinding reads back the same after saving', () => {
    const overrides = rebindShortcut(rebindShortcut(noShortcutOverrides, 'pane.close', ['mod+shift+w']), 'terminal.new', [])
    expect(parseShortcutOverrides(JSON.parse(saveShortcutOverrides(overrides)))).toEqual(overrides)
    expect(bindingsOf(overrides)['terminal.new']).toEqual([])
  })

  test('binding the default keys again drops the override', () => {
    const overrides = rebindShortcut(rebindShortcut(noShortcutOverrides, 'pane.close', ['mod+shift+w']), 'pane.close', ['mod+w'])
    expect(overrides).toEqual(noShortcutOverrides)
  })

  test('reset brings one shortcut back to its default and leaves the others', () => {
    const overrides = rebindShortcut(rebindShortcut(noShortcutOverrides, 'pane.close', ['mod+shift+w']), 'terminal.new', ['mod+alt+t'])
    const reset = resetShortcut(overrides, 'pane.close')
    expect(bindingsOf(reset)['pane.close']).toEqual(['mod+w'])
    expect(bindingsOf(reset)['terminal.new']).toEqual(['mod+alt+t'])
  })

  test('a shared combination is a conflict naming both actions', () => {
    const bindings = bindingsOf(rebindShortcut(noShortcutOverrides, 'terminal.new', ['mod+d']))
    expect(shortcutConflicts(bindings)).toEqual({ 'mod+d': ['terminal.new', 'pane.splitRight'] })
  })

  test('unknown ids, fixed ids, bad keys and other shapes are dropped on reading', () => {
    expect(parseShortcutOverrides(null)).toEqual(noShortcutOverrides)
    expect(parseShortcutOverrides({ version: 2, bindings: {} })).toEqual(noShortcutOverrides)
    expect(parseShortcutOverrides({ version: 1, bindings: { 'no.such': ['mod+x'], 'view.agent': ['mod+9'], 'pane.close': 'mod+x', 'terminal.new': ['mod+alt+t', 4] } })).toEqual(noShortcutOverrides)
  })
})

describe('comboLabel', () => {
  test("writes a combination the way the platform does", () => {
    expect(comboLabel('mod+shift+d', true)).toBe('⇧⌘D')
    expect(comboLabel('mod+alt+left', true)).toBe('⌥⌘←')
    expect(comboLabel('mod+shift+]', true)).toBe('⇧⌘]')
    expect(comboLabel('mod+shift+d', false)).toBe('Ctrl+Shift+D')
    expect(comboLabel('ctrl+tab', true)).toBe('⌃Tab')
  })
})
