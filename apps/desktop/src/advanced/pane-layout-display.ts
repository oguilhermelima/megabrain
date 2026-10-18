import type { MenuIcon } from '@/components/menu-icons'
import { parseItem, type ItemKind } from '@/panes/pane-model'
import type { Preset } from '@/panes/split-groups'

export const presetNames: Record<Preset, string> = { row: 'Side by side', column: 'Stacked', grid: 'Grid', main: 'One large + column', bottom: 'One on the bottom', top: 'One on the top' }
export const presetIcons: Record<Preset, MenuIcon> = { row: 'splitRight', column: 'splitDown', grid: 'splitGrid', main: 'splitMain', bottom: 'splitBottom', top: 'splitTop' }

const paneViewKinds: ReadonlySet<ItemKind> = new Set<ItemKind>(['dispatch', 'session', 'native', 'terminal', 'launcher', 'code'])

/** Only project-backed panes have the top bar where the Code action lives. */
export function hasActionBar(item: string): boolean {
  const kind = parseItem(item)?.kind
  return kind !== undefined && paneViewKinds.has(kind)
}
