import { useRef, type MouseEvent as ReactMouseEvent } from 'react'
import type { MenuRow } from '@/components/ContextMenu'
import type { MenuIcon } from '@/components/menu-icons'
import type { MenuModel } from '@/chat/chat-menu-model'

/**
 * How the transcript writes into the chat's composer: the view makes one with useComposeChannel and
 * hands it to both; the composer fills `current` while it accepts text, with a function that puts a
 * block at the caret on a paragraph of its own.
 */
export type ComposeChannel = { current: ((block: string) => void) | null }

export function useComposeChannel(): ComposeChannel {
  return useRef<((block: string) => void) | null>(null)
}

/** What a row under the pointer knows about itself, which the DOM alone does not carry. */
export interface MenuParts {
  message: { markdown: string; element: HTMLElement }
  tool: { command: string | null; input: string | null; output: string | null }
  image: { src: string; name: string; open: (() => void) | null }
}

// Filled on the way up: the innermost row's handler runs first, and what it set stays.
const parts = new WeakMap<Event, Partial<MenuParts>>()

/** Called from a row's onContextMenu, before the transcript's own handler reads what was marked. */
export function markMenu(event: ReactMouseEvent, found: Partial<MenuParts>) {
  parts.set(event.nativeEvent, { ...found, ...parts.get(event.nativeEvent) })
}

export function markedParts(event: ReactMouseEvent): Partial<MenuParts> {
  return parts.get(event.nativeEvent) ?? {}
}

/** The menu model's rows as the context menu's sections, each action given its handler and icon. */
export function toSections<A extends string>(models: MenuModel<A>[], run: (action: A) => void, icons: Record<A, MenuIcon>): MenuRow[][] {
  const sections: MenuRow[][] = [[]]
  for (const model of models) {
    if ('separator' in model) sections.push([])
    else sections[sections.length - 1]?.push({ label: model.label, icon: icons[model.action], shortcut: model.shortcut, disabled: model.disabled, onSelect: () => run(model.action) })
  }
  return sections.filter((section) => section.length > 0)
}
