// The keys that split and close panes: ⌘D splits the focused pane right, ⌘⇧D down, ⌘W closes it.

export type PaneShortcut = 'split-right' | 'split-down' | 'close-pane'

export function paneShortcut(event: { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }): PaneShortcut | null {
  if (!event.metaKey || event.altKey || event.ctrlKey) return null
  const key = event.key.toLowerCase()
  if (key === 'd') return event.shiftKey ? 'split-down' : 'split-right'
  if (key === 'w' && !event.shiftKey) return 'close-pane'
  return null
}
