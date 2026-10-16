import { createContext, useContext } from 'react'
import type { ScriptPort } from '@/api/schema'
import type { RunAction, WorktreePanel } from '@/run-panel/run-model'

/** What a chat's top bar needs to run its worktree's commands; null where nothing can run. */
export interface RunControls {
  /** The worktree the open chat belongs to. */
  root: string
  panel: WorktreePanel
  /** `port` is the port the command binds, when known; a taken one is offered a way around before running. */
  run: (action: RunAction, command: string, port?: ScriptPort | null) => void
  /** Stops the action's run, after the run panel's confirmation; nothing when it does not run. */
  stop: (action: RunAction) => void
  /** Shows or hides the run panel; hiding it leaves every run going. */
  setPanelOpen: (open: boolean) => void
  /** Opens Settings on the project's commands; `repo` is the repository the scripts belong to. */
  editCommands: (repo: string) => void
}

export const RunContext = createContext<RunControls | null>(null)

export const useRunControls = () => useContext(RunContext)
