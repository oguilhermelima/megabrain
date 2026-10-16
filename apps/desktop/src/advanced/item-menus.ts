import type { NativeChat, ProjectSession } from '@/api/schema'
import { closable } from '@/chat/session-ownership'
import type { MenuItem } from '@/components/ContextMenu'
import { rowStatus } from '@/native-chat/chat-model'
import { closeNeedsConfirm, type AppTerminal } from '@/terminal/terminal-list'

// The menus of the sidebar's item rows: a chat, a terminal or an agent session under its worktree.
// Every one of them has one Close: from its menu, from its close button and with a middle click.

/** An item row: what its menu, its close and a drag act on. */
export type SidebarItemRow = { kind: 'session'; session: ProjectSession } | { kind: 'native'; chat: NativeChat } | { kind: 'terminal'; terminal: AppTerminal }

export interface RowMenuActions {
  /** The row's one Close, by its owner; what still runs asks first. */
  close: (row: SidebarItemRow) => void
  copy: (text: string) => void
  /** Asks, then stops a chat's running turn. */
  stop: (chat: NativeChat) => void
  rename: (terminal: AppTerminal) => void
}

export function chatMenu(chat: NativeChat, actions: RowMenuActions): MenuItem[] {
  const close: MenuItem = { label: 'Close chat', icon: 'close', group: 'danger', onSelect: () => actions.close({ kind: 'native', chat }) }
  if (rowStatus(chat.state) === 'ended') return [close]
  return [{ label: 'Stop chat…', icon: 'stop', group: 'danger', onSelect: () => actions.stop(chat) }, close]
}

export function terminalMenu(terminal: AppTerminal, actions: RowMenuActions): MenuItem[] {
  return [
    { label: 'Rename…', icon: 'rename', group: 'organise', onSelect: () => actions.rename(terminal) },
    { label: closeNeedsConfirm(terminal) ? 'Close terminal…' : 'Close terminal', icon: 'close', group: 'danger', onSelect: () => actions.close({ kind: 'terminal', terminal }) },
  ]
}

/** A conversation of ours listed on its own (an ended terminal conversation): it copies its id and has one Close, asking first while it runs. */
export function sessionMenu(session: ProjectSession, actions: RowMenuActions): MenuItem[] {
  const copy: MenuItem = { label: 'Copy session id', icon: 'copy', group: 'copy', onSelect: () => actions.copy(session.sessionId) }
  if (!closable(session)) return [copy]
  return [copy, { label: session.status === 'ended' ? 'Close' : 'Close…', icon: 'close', group: 'danger', onSelect: () => actions.close({ kind: 'session', session }) }]
}

/** A row's own items with Split right, Split down and Join with… in their own group. */
export function withSplitItems(items: MenuItem[], split: MenuItem[]): MenuItem[] {
  if (split.length === 0) return items
  return [...split.map((item): MenuItem => ({ ...item, group: 'split' })), ...items]
}

const joinLimit = 40

/**
 * Join with…, short enough for a menu: a named group by its name, another by its first member and
 * how many more. `full` names every member, for the tooltip.
 */
export function joinLabel(target: { name: string | null; members: readonly { title: string }[] }): { label: string; full: string } {
  const titles = target.members.map((member) => member.title)
  const full = `Join with ${target.name ?? titles.join(' + ')}`
  const more = target.name === null && titles.length > 1 ? ` +${titles.length - 1}` : ''
  const head = target.name ?? titles[0] ?? ''
  const room = joinLimit - 'Join with '.length - more.length
  const shown = head.length <= room ? head : `${head.slice(0, room - 1).trimEnd()}…`
  return { label: `Join with ${shown}${more}`, full }
}

export type MiddleClickTarget = SidebarItemRow | { kind: 'project' | 'worktree' | 'folder' | 'group' }

export type MiddleClick = { kind: 'close'; row: SidebarItemRow } | null

/** A middle click closes exactly the item it lands on, as its Close item would; other rows ignore it. */
export function middleClickAction(target: MiddleClickTarget): MiddleClick {
  switch (target.kind) {
    case 'native':
    case 'terminal':
      return { kind: 'close', row: target }
    case 'session':
      return closable(target.session) ? { kind: 'close', row: target } : null
    default:
      return null
  }
}
