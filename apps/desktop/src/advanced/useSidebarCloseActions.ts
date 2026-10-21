import type { Dispatch, SetStateAction } from 'react'
import { api } from '@/api'
import type { NativeChat, ProjectSession } from '@/api/schema'
import { closeOf, closable } from '@/chat/session-ownership'
import { useStableCallback } from '@/lib/useStableCallback'
import { itemKey, parseItem, paneList, type Panes } from '@/panes/pane-model'
import { newLauncher, newPaneId } from '@/advanced/usePaneState'
import { removeLayoutItem, type Layout } from '@/panes/split-groups'
import { forgetTerminal } from '@/launcher/LaunchedTerminal'
import { closeCall, closeNeedsConfirm, removeTerminal, terminalLabel, type AppTerminal } from '@/terminal/terminal-list'
import type { SidebarDrag } from '@/advanced/Sidebar'
import type { PendingConfirm } from '@/components/ConfirmDialog'

export function useSidebarCloseActions({
  nativeChats, startedChat, setStartedChat, terminals, setTerminals, panes, setLayout, setCloseConfirm,
  dropChat, findSession, closePaneById,
}: {
  nativeChats: NativeChat[]
  startedChat: NativeChat | null
  setStartedChat: Dispatch<SetStateAction<NativeChat | null>>
  terminals: AppTerminal[]
  setTerminals: Dispatch<SetStateAction<AppTerminal[]>>
  panes: Panes
  setLayout: Dispatch<SetStateAction<Layout>>
  setCloseConfirm: Dispatch<SetStateAction<PendingConfirm | null>>
  dropChat: (id: string) => void
  findSession: (id: string) => { session: ProjectSession; worktreePath: string } | null
  closePaneById: (id: string) => void
}) {
  const closeTerminal = useStableCallback(async (terminal: AppTerminal) => {
    const call = closeCall(terminal)
    if (call !== null) await api.closeTerminal(call.id, call.kill ? { kill: true } : undefined)
    forgetTerminal(terminal.id)
    setTerminals((current) => removeTerminal(current, terminal.id))
    setLayout((current) => removeLayoutItem(current, itemKey('terminal', terminal.id), { id: newPaneId(), item: newLauncher() }))
  })
  const closeChat = useStableCallback(async (chat: NativeChat) => {
    await api.removeChat(chat.id)
    dropChat(chat.id)
    if (startedChat?.id === chat.id) setStartedChat(null)
    setLayout((current) => removeLayoutItem(current, itemKey('native', chat.id), { id: newPaneId(), item: newLauncher() }))
  })
  const requestClose = useStableCallback(async (row: SidebarDrag): Promise<void> => {
    if (row.kind === 'native') {
      const { chat } = row
      const title = chat.title ?? 'New chat'
      if (chat.state !== 'working' && chat.state !== 'waiting-approval') return closeChat(chat)
      setCloseConfirm({
        title: `Close ${title}?`,
        body: "A turn is running. Closing stops the agent and removes the chat from megabrain. The agent's own session stays, so Resume can still open it.",
        action: 'Close chat',
        run: () => closeChat(chat),
      })
      return
    }
    if (row.kind === 'terminal') {
      const { terminal } = row
      if (!closeNeedsConfirm(terminal)) return closeTerminal(terminal)
      setCloseConfirm({
        title: `Close ${terminalLabel(terminal)}?`,
        body: terminal.engine === 'tmux'
          ? 'Closing the terminal ends its tmux session and whatever runs in it.'
          : 'Its process may still be running. Closing the terminal ends it.',
        action: 'Close terminal',
        run: () => closeTerminal(terminal),
      })
      return
    }
    const { session } = row
    const close = closeOf(session)
    if (close === null) return
    if (close.kind === 'chat') {
      const chat = nativeChats.find((entry) => entry.id === close.chatId)
      if (chat !== undefined) return requestClose({ kind: 'native', chat })
      return api.removeChat(close.chatId).then(() => dropChat(close.chatId))
    }
    if (close.kind === 'dispatch') {
      if (session.status === 'ended') return api.closeDispatch(close.dispatchId)
      setCloseConfirm({
        title: `Close ${session.title}?`,
        body: 'Closing ends the agent running this lane and takes it out of the list.',
        action: 'Close',
        run: () => api.closeDispatch(close.dispatchId),
      })
      return
    }
    if (session.status === 'ended') return api.releaseSession(close.sessionId)
    setCloseConfirm({
      title: `Close ${session.title}?`,
      body: "Closing ends the agent running this conversation and takes it out of the list. The agent's own session stays on disk, so Resume can still open it.",
      action: 'Close',
      run: () => api.releaseSession(close.sessionId),
    })
  })
  const closeFocused = useStableCallback((): Promise<void> => {
    const focusedItem = paneList(panes.root).find((leaf) => leaf.id === panes.focused)?.item ?? null
    const focusedParsed = focusedItem === null ? null : parseItem(focusedItem)
    if (focusedParsed?.kind === 'native') {
      const chat = nativeChats.find((entry) => entry.id === focusedParsed.id) ?? (startedChat?.id === focusedParsed.id ? startedChat : null)
      if (chat !== null) return requestClose({ kind: 'native', chat })
    }
    if (focusedParsed?.kind === 'terminal') {
      const terminal = terminals.find((entry) => entry.id === focusedParsed.id)
      if (terminal !== undefined) return requestClose({ kind: 'terminal', terminal })
    }
    if (focusedParsed?.kind === 'session') {
      const found = findSession(focusedParsed.id)
      if (found !== null && closable(found.session)) return requestClose({ kind: 'session', session: found.session })
    }
    closePaneById(panes.focused)
    return Promise.resolve()
  })
  return { requestClose, closeFocused }
}
