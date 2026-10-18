import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { api } from '@/api'
import type { NativeChat, Project, ProjectSession } from '@/api/schema'
import { chatPaneStays, readyToPrune } from '@/advanced/restore-panes'
import type { Layout } from '@/panes/split-groups'
import { newLauncher, newPaneId, panesKey } from '@/advanced/usePaneState'
import { keepsPane, restoreAppTerminals, terminalSessionIds, type AppTerminal } from '@/terminal/terminal-list'
import { parseGithubItemId } from '@/github/review-model'
import { parseItem } from '@/panes/pane-model'
import { pruneLayout, serialiseLayout } from '@/panes/split-groups'

const terminalIdsKey = 'megabrain.terminals.ids'

function storedTerminalIds(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(terminalIdsKey) ?? '{}') as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
}

export function usePanePersistence({
  status, projectsLoaded, chatsLoaded, projects, nativeChats, startedChat, terminals, terminalsRestored, setTerminals, setTerminalsRestored, findSession, paneLayout, pruned, setPruned, setLayout,
}: {
  status: { dispatches: { dispatchId: string }[] } | null
  projectsLoaded: boolean
  chatsLoaded: boolean
  projects: Project[]
  nativeChats: NativeChat[]
  startedChat: NativeChat | null
  terminals: AppTerminal[]
  terminalsRestored: boolean
  setTerminals: Dispatch<SetStateAction<AppTerminal[]>>
  setTerminalsRestored: Dispatch<SetStateAction<boolean>>
  findSession: (id: string) => { session: ProjectSession; worktreePath: string } | null
  paneLayout: Layout
  pruned: boolean
  setPruned: Dispatch<SetStateAction<boolean>>
  setLayout: Dispatch<SetStateAction<Layout>>
}) {
  // The tmux terminals a past run left come back once, at launch; a failed list restores none.
  useEffect(() => {
    let current = true
    api
      .listAppTerminals()
      .then((listings) => {
        if (current) setTerminals((list) => restoreAppTerminals(list, listings, storedTerminalIds()))
      })
      .catch(() => {})
      .finally(() => {
        if (current) setTerminalsRestored(true)
      })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    if (!terminalsRestored) return
    try {
      localStorage.setItem(terminalIdsKey, JSON.stringify(terminalSessionIds(terminals)))
    } catch {
      // Without the ids a restored terminal still lists; only its place in the layout is lost.
    }
  }, [terminals, terminalsRestored])

  const listsLoaded = readyToPrune({ status: status !== null, projects: projectsLoaded, terminals: terminalsRestored, chats: chatsLoaded })
  const itemExists = (item: string): boolean => {
    const parsed = parseItem(item)
    if (parsed === null) return false
    switch (parsed.kind) {
      case 'dispatch':
        return status?.dispatches.some((entry) => entry.dispatchId === parsed.id) ?? false
      case 'session':
        return findSession(parsed.id) !== null
      case 'native':
        return chatPaneStays(nativeChats, parsed.id) || startedChat?.id === parsed.id
      case 'terminal':
        return keepsPane(terminals, parsed.id)
      case 'launcher':
      case 'code':
      case 'knowledge':
      case 'artifact':
      case 'tasks':
        return true
      case 'github':
        return parseGithubItemId(parsed.id) !== null
      case 'project':
        return projects.some((project) => project.path === parsed.id)
    }
  }

  useEffect(() => {
    if (pruned || !listsLoaded) return
    setPruned(true)
    setLayout((current) => pruneLayout(current, itemExists, { id: newPaneId(), item: newLauncher() }))
  }, [pruned, listsLoaded])

  useEffect(() => {
    try {
      localStorage.setItem(panesKey, serialiseLayout(paneLayout))
    } catch {
      // A remembered layout is a convenience; the next launch starts with one pane.
    }
  }, [paneLayout])

  return { listsLoaded }
}
