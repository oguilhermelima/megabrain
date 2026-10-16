// What every row menu in the sidebar holds, and the order it shows it in. Items are grouped by kind,
// the groups always in this order with a separator between them, and destructive items last:
//   open      New chat, New terminal, Open in Code, Show on GitHub, Reveal in Finder
//   git       New worktree, New stacked branch, Sync stack, Open PRs, Merge stack
//   copy      Copy path, Copy branch name, Refresh
//   organise  Rename, Move to folder, Hide
//   danger    Close, Stop, Release, Remove, Delete folder (in the danger colour)
// Within a group, items keep the order they were given in.

export const menuGroups = ['open', 'git', 'copy', 'organise', 'danger'] as const

export type MenuGroup = (typeof menuGroups)[number]

/** The non-empty groups of `items`, in menuGroups order. */
export function menuSections<T extends { group: MenuGroup }>(items: readonly T[]): T[][] {
  return menuGroups.map((group) => items.filter((item) => item.group === group)).filter((section) => section.length > 0)
}

/** The item an arrow key, Home or End moves focus to among `count`, wrapping; null for other keys. */
export function menuFocusStep(count: number, current: number | null, key: string): number | null {
  if (count === 0) return null
  switch (key) {
    case 'ArrowDown':
      return current === null ? 0 : (current + 1) % count
    case 'ArrowUp':
      return current === null ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

const macGlyphs: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' }
const macOrder = ['ctrl', 'alt', 'shift', 'mod']
const otherNames: Record<string, string> = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const otherOrder = ['mod', 'ctrl', 'alt', 'shift']

/** `mod+shift+v` as macOS writes it (⇧⌘V) or as other systems do (Ctrl+Shift+V). */
export function shortcutLabel(shortcut: string, mac: boolean): string {
  const parts = shortcut.toLowerCase().split('+')
  const key = (parts.pop() ?? '').toUpperCase()
  const modifiers = new Set(parts)
  if (mac) return macOrder.filter((name) => modifiers.has(name)).map((name) => macGlyphs[name]).join('') + key
  return [...otherOrder.filter((name) => modifiers.has(name)).map((name) => otherNames[name]), key].join('+')
}

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
