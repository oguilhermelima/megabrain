import { createContext, useContext } from 'react'
import type { RunAction, WorktreePanel } from '@/run-panel/run-model'

/** What a chat's top bar needs to run its worktree's commands; null where nothing can run. */
export interface RunControls {
  /** The worktree the open chat belongs to. */
  root: string
  panel: WorktreePanel
  run: (action: RunAction, command: string) => void
  showPanel: () => void
  /** Opens Settings on the project's commands; `repo` is the repository the scripts belong to. */
  editCommands: (repo: string) => void
}

export const RunContext = createContext<RunControls | null>(null)

export const useRunControls = () => useContext(RunContext)
