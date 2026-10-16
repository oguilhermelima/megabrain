import { useState } from 'react'
import { api } from '@/api'
import type { PendingConfirm } from '@/components/ConfirmDialog'
import { closeTab, isRunning, markExited, markStarted, panelFor, runActionLabel, selectTab, setPanelOpen, startRun, type RunAction, type RunPanels, type RunTab } from '@/run-panel/run-model'

const folder = (path: string) => path.split('/').filter((part) => part !== '').pop() ?? path

/**
 * The run panels of every worktree for as long as the app runs, so switching chats keeps each
 * worktree's terminals. Re-running, stopping or closing an action that still runs waits for a confirmation.
 */
export function useRunPanels() {
  const [panels, setPanels] = useState<RunPanels>({})
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)

  const tabOf = (worktree: string, action: RunAction): RunTab | undefined => panelFor(panels, worktree).tabs.find((tab) => tab.action === action)

  // Closing the terminal ends the command (native) or detaches from it (tmux); either way the tab is done.
  const stopTab = async (worktree: string, tab: RunTab) => {
    if (tab.terminalId !== null) await api.closeTerminal(tab.terminalId).catch(() => {})
    setPanels((current) => {
      const now = panelFor(current, worktree).tabs.find((item) => item.action === tab.action)
      return now?.generation === tab.generation && now.status.kind !== 'exited' ? markExited(current, worktree, tab.action, tab.generation, null) : current
    })
  }

  const restart = async (worktree: string, action: RunAction, command: string) => {
    const tab = tabOf(worktree, action)
    if (tab !== undefined && tab.status.kind !== 'exited') await stopTab(worktree, tab)
    setPanels((current) => startRun(current, worktree, action, command))
  }

  const close = async (worktree: string, tab: RunTab) => {
    await stopTab(worktree, tab)
    setPanels((current) => closeTab(current, worktree, tab.action))
  }

  return {
    panels,
    /** The run, stop or close waiting for the person's yes. */
    confirm,
    dismissConfirm: () => setConfirm(null),
    run(worktree: string, action: RunAction, command: string) {
      if (!isRunning(panels, worktree, action)) {
        setPanels((current) => startRun(current, worktree, action, command))
        return
      }
      setConfirm({
        title: `Restart ${runActionLabel[action]}?`,
        body: `${command} is still running in ${folder(worktree)}. Restarting stops it and runs the command again.`,
        action: 'Restart',
        run: () => restart(worktree, action, command),
      })
    },
    restart: (worktree: string, tab: RunTab) => void restart(worktree, tab.action, tab.command),
    stop: (worktree: string, tab: RunTab) => {
      if (tab.status.kind === 'exited') return
      setConfirm({
        title: `Stop ${runActionLabel[tab.action]}?`,
        body: `${tab.command} is running in ${folder(worktree)}. Stopping ends it; its output stays in the tab.`,
        action: 'Stop',
        run: () => stopTab(worktree, tab),
      })
    },
    close: (worktree: string, tab: RunTab) => {
      if (tab.status.kind === 'exited') {
        void close(worktree, tab)
        return
      }
      setConfirm({
        title: `Close ${runActionLabel[tab.action]}?`,
        body: `${tab.command} is still running in ${folder(worktree)}. Closing the tab stops it.`,
        action: 'Close tab',
        run: () => close(worktree, tab),
      })
    },
    select: (worktree: string, action: RunAction) => setPanels((current) => selectTab(current, worktree, action)),
    setOpen: (worktree: string, open: boolean) => setPanels((current) => setPanelOpen(current, worktree, open)),
    started: (worktree: string, tab: RunTab, terminalId: string) => setPanels((current) => markStarted(current, worktree, tab.action, tab.generation, terminalId)),
    exited: (worktree: string, tab: RunTab, code: number | null) => setPanels((current) => markExited(current, worktree, tab.action, tab.generation, code)),
  }
}

export type RunPanelsState = ReturnType<typeof useRunPanels>
