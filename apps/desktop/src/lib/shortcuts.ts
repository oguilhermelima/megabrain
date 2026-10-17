// Every keyboard shortcut of the main window, in one registry: an id the handler matches on, a label
// and group for Settings > Shortcuts, and the default keys. Where Orca has the same action the keys
// are Orca's defaults (`orca` names its keybinding id); elsewhere they are megabrain's own.
//
// A combination is written `mod+shift+d`: modifiers in the order mod, ctrl, alt, shift, then the key.
// mod is ⌘ on a Mac and Ctrl elsewhere. The key is the physical key's character in a US layout, so
// ⇧⌘] stays `mod+shift+]` and not `}`; arrows are left, right, up and down.

export type ShortcutId =
  | 'settings.open'
  | 'chat.new'
  | 'terminal.new'
  | 'sidebar.toggle'
  | 'sidebar.focus'
  | 'sidebar.search'
  | 'item.next'
  | 'item.previous'
  | 'pane.splitRight'
  | 'pane.splitDown'
  | 'pane.close'
  | 'pane.next'
  | 'pane.previous'
  | 'pane.focusLeft'
  | 'pane.focusRight'
  | 'pane.focusUp'
  | 'pane.focusDown'
  | 'view.agent'
  | 'view.code'
  | 'view.pr'
  | 'view.diff'
  | 'view.device'

export interface ShortcutDef {
  id: ShortcutId
  label: string
  group: string
  keys: readonly string[]
  /** The Orca keybinding whose default keys these are; null where Orca has no such action. */
  orca: string | null
  /** Handled where it cannot be changed from Settings (the pane bar's views); listed so its keys show as taken. */
  fixed?: boolean
}

export const shortcuts: readonly ShortcutDef[] = [
  { id: 'chat.new', label: 'New chat or worktree', group: 'General', keys: ['mod+n', 'mod+shift+n'], orca: 'workspace.create' },
  { id: 'terminal.new', label: 'New terminal', group: 'General', keys: ['mod+t'], orca: 'tab.newTerminal' },
  { id: 'settings.open', label: 'Open Settings', group: 'General', keys: ['mod+,'], orca: null },
  { id: 'sidebar.toggle', label: 'Show or hide the sidebar', group: 'Sidebar', keys: ['mod+b'], orca: 'sidebar.left.toggle' },
  { id: 'sidebar.focus', label: 'Focus the sidebar', group: 'Sidebar', keys: ['mod+shift+0'], orca: 'sidebar.focusWorktreeList' },
  { id: 'sidebar.search', label: 'Search projects', group: 'Sidebar', keys: ['mod+f'], orca: null },
  { id: 'item.next', label: 'Next chat or session', group: 'Sidebar', keys: ['mod+shift+]'], orca: 'tab.nextAllTypes' },
  { id: 'item.previous', label: 'Previous chat or session', group: 'Sidebar', keys: ['mod+shift+['], orca: 'tab.previousAllTypes' },
  { id: 'pane.splitRight', label: 'Split right', group: 'Panes', keys: ['mod+d'], orca: 'terminal.splitRight' },
  { id: 'pane.splitDown', label: 'Split down', group: 'Panes', keys: ['mod+shift+d'], orca: 'terminal.splitDown' },
  { id: 'pane.close', label: 'Close the pane or its item', group: 'Panes', keys: ['mod+w'], orca: 'tab.close' },
  { id: 'pane.next', label: 'Focus the next pane', group: 'Panes', keys: ['mod+]'], orca: 'terminal.focusNextPane' },
  { id: 'pane.previous', label: 'Focus the previous pane', group: 'Panes', keys: ['mod+['], orca: 'terminal.focusPreviousPane' },
  { id: 'pane.focusLeft', label: 'Focus the pane to the left', group: 'Panes', keys: ['mod+alt+left'], orca: null },
  { id: 'pane.focusRight', label: 'Focus the pane to the right', group: 'Panes', keys: ['mod+alt+right'], orca: null },
  { id: 'pane.focusUp', label: 'Focus the pane above', group: 'Panes', keys: ['mod+alt+up'], orca: null },
  { id: 'pane.focusDown', label: 'Focus the pane below', group: 'Panes', keys: ['mod+alt+down'], orca: null },
  { id: 'view.agent', label: 'Agent view', group: 'Pane views', keys: ['mod+1'], orca: null, fixed: true },
  { id: 'view.code', label: 'Code view', group: 'Pane views', keys: ['mod+2'], orca: null, fixed: true },
  { id: 'view.pr', label: 'Pull request view', group: 'Pane views', keys: ['mod+3'], orca: null, fixed: true },
  { id: 'view.diff', label: 'Diff view', group: 'Pane views', keys: ['mod+4'], orca: null, fixed: true },
  { id: 'view.device', label: 'Device view', group: 'Pane views', keys: ['mod+5'], orca: null, fixed: true },
]

const byId = new Map<string, ShortcutDef>(shortcuts.map((shortcut) => [shortcut.id, shortcut]))

/** The keys the person chose, by shortcut id; an id left out keeps its default. */
export type ShortcutOverrides = Partial<Record<ShortcutId, string[]>>

export const noShortcutOverrides: ShortcutOverrides = {}

export type ShortcutBindings = Record<ShortcutId, readonly string[]>

export function bindingsOf(overrides: ShortcutOverrides): ShortcutBindings {
  return Object.fromEntries(shortcuts.map((shortcut) => [shortcut.id, overrides[shortcut.id] ?? shortcut.keys])) as ShortcutBindings
}

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index])

/** Binds `keys` to a shortcut; its default keys drop the override. A fixed shortcut stays as it is. */
export function rebindShortcut(overrides: ShortcutOverrides, id: ShortcutId, keys: readonly string[]): ShortcutOverrides {
  const shortcut = byId.get(id)
  if (shortcut === undefined || shortcut.fixed === true) return overrides
  if (sameKeys(keys, shortcut.keys)) return resetShortcut(overrides, id)
  return { ...overrides, [id]: [...keys] }
}

export function resetShortcut(overrides: ShortcutOverrides, id: ShortcutId): ShortcutOverrides {
  if (!(id in overrides)) return overrides
  const { [id]: _dropped, ...rest } = overrides
  return rest
}

/** Every combination bound to more than one action, with those actions in registry order. */
export function shortcutConflicts(bindings: ShortcutBindings): Record<string, ShortcutId[]> {
  const owners = new Map<string, ShortcutId[]>()
  for (const shortcut of shortcuts) for (const combo of bindings[shortcut.id]) owners.set(combo, [...(owners.get(combo) ?? []), shortcut.id])
  return Object.fromEntries([...owners].filter(([, ids]) => ids.length > 1))
}

const modifierOrder = ['mod', 'ctrl', 'alt', 'shift'] as const

/** A well-formed combination: known modifiers in order, then one key. */
function validCombo(combo: string): boolean {
  const parts = combo.split('+')
  const key = parts.pop()
  if (key === undefined || key === '' || (modifierOrder as readonly string[]).includes(key)) return false
  const positions = parts.map((part) => (modifierOrder as readonly string[]).indexOf(part))
  return positions.every((position, index) => position !== -1 && (index === 0 || position > (positions[index - 1] ?? -1)))
}

// `+` itself is a key that would split as a separator; the registry never binds it.
export function parseShortcutOverrides(raw: unknown): ShortcutOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return noShortcutOverrides
  const { version, bindings } = raw as Record<string, unknown>
  if (version !== 1 || typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) return noShortcutOverrides
  const overrides: ShortcutOverrides = {}
  for (const [id, keys] of Object.entries(bindings)) {
    const shortcut = byId.get(id)
    if (shortcut === undefined || shortcut.fixed === true || !Array.isArray(keys)) continue
    if (!keys.every((key): key is string => typeof key === 'string' && validCombo(key))) continue
    overrides[shortcut.id] = keys
  }
  return overrides
}

export function saveShortcutOverrides(overrides: ShortcutOverrides): string {
  return JSON.stringify({ version: 1, bindings: overrides })
}

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const codeKeys: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

const modifierKeys = new Set(['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS'])

/** The key's name in a combination: its physical key where the code says it, else what it typed. */
function keyName(event: KeyLike): string | null {
  if (modifierKeys.has(event.key)) return null
  const letter = /^Key([A-Z])$/.exec(event.code)
  if (letter !== null) return (letter[1] ?? '').toLowerCase()
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(event.code)
  if (digit !== null) return digit[1] ?? null
  const named = codeKeys[event.code]
  if (named !== undefined) return named
  const key = event.key.toLowerCase()
  return key === '' || key === 'unidentified' || key === '+' ? null : key
}

export const isMacPlatform = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)

/** The combination a key press makes; null while only modifiers are down. */
export function comboOf(event: KeyLike, mac: boolean = isMacPlatform): string | null {
  const key = keyName(event)
  if (key === null) return null
  const modifiers = [mac ? event.metaKey : event.ctrlKey, mac && event.ctrlKey, event.altKey, event.shiftKey]
  return [...modifierOrder.filter((_, index) => modifiers[index] === true), key].join('+')
}

/** The action a key press is bound to, or null. */
export function matchShortcut(event: KeyLike, bindings: ShortcutBindings, mac: boolean = isMacPlatform): ShortcutId | null {
  const combo = comboOf(event, mac)
  if (combo === null) return null
  return shortcuts.find((shortcut) => bindings[shortcut.id].includes(combo))?.id ?? null
}

const macGlyphs: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
const macOrder = ['ctrl', 'alt', 'shift', 'mod']
const otherNames: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const otherOrder = ['mod', 'ctrl', 'alt', 'shift']
const keyGlyphs: Record<string, string> = { left: '←', right: '→', up: '↑', down: '↓' }

function keyLabel(key: string): string {
  return keyGlyphs[key] ?? (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1))
}

/** `mod+shift+d` as macOS writes it (⇧⌘D) or as other systems do (Ctrl+Shift+D). */
export function comboLabel(combo: string, mac: boolean = isMacPlatform): string {
  const parts = combo.split('+')
  const key = keyLabel(parts.pop() ?? '')
  const modifiers = new Set(parts)
  if (mac) return macOrder.filter((name) => modifiers.has(name)).map((name) => macGlyphs[name]).join('') + key
  return [...otherOrder.filter((name) => modifiers.has(name)).map((name) => otherNames[name]), key].join('+')
}
