import { useRef, useState } from 'react'
import { api } from '@/api'
import type { ScriptPort } from '@/api/schema'
import type { PendingConfirm } from '@/components/ConfirmDialog'
import { addressInUse, portConflict, type PortConflict } from '@/run-panel/port-conflict'
import { closeTab, isRunning, markExited, markStarted, panelFor, runActionLabel, selectTab, setConflict, setPanelOpen, startRun, type RunAction, type RunPanels, type RunTab } from '@/run-panel/run-model'
import { base64ToBytes } from '@/terminal/terminal-model'

const folder = (path: string) => path.split('/').filter((part) => part !== '').pop() ?? path

/** What an action was asked to run, before any move to another port, and the port it binds. */
interface Launch {
  command: string
  port: ScriptPort | null
}

// Enough of the end of a run's output to find an address-in-use error in.
const TAIL = 4096
const decoder = new TextDecoder()
const plain = (base64: string) => decoder.decode(base64ToBytes(base64)).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

/** A port read from output alone, with nothing known about how the command picks it. */
const portFromOutput = (port: number): ScriptPort => ({ port, framework: null, source: 'default', detail: '', fragment: null, override: null })

/** The choice to offer when `port`'s port is taken by someone; null when it is free or the check fails. */
async function checkPort(worktree: string, command: string, port: ScriptPort): Promise<PortConflict | null> {
  const who = await api.portWho(port.port)
  if (who.listeners.length === 0) return null
  const free = await api.portFree(port.port + 1).catch(() => null)
  return portConflict({ worktree, command, found: port, listeners: who.listeners, free, now: Date.now() })
}

/**
 * The run panels of every worktree for as long as the app runs, so switching chats keeps each
 * worktree's terminals. Re-running, stopping or closing an action that still runs waits for a
 * confirmation, and so does Run on a port something else holds.
 */
export function useRunPanels() {
  const [panels, setPanels] = useState<RunPanels>({})
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const launches = useRef(new Map<string, Launch>())
  const outputs = useRef(new Map<string, string>())

  const launchKey = (worktree: string, action: RunAction) => `${worktree}\n${action}`
  const outputKey = (worktree: string, tab: RunTab) => `${worktree}\n${tab.action}\n${tab.generation}`
  const tabOf = (worktree: string, action: RunAction): RunTab | undefined => panelFor(panels, worktree).tabs.find((tab) => tab.action === action)

  // Closing the terminal ends the command (native) or detaches from it (tmux); either way the tab is done.
  const stopTab = async (worktree: string, tab: RunTab) => {
    if (tab.terminalId !== null) await api.closeTerminal(tab.terminalId).catch(() => {})
    setPanels((current) => {
      const now = panelFor(current, worktree).tabs.find((item) => item.action === tab.action)
      return now?.generation === tab.generation && now.status.kind !== 'exited' ? markExited(current, worktree, tab.action, tab.generation, null) : current
    })
  }

  const restart = async (worktree: string, action: RunAction, command: string, movedTo: number | null = null) => {
    const tab = tabOf(worktree, action)
    if (tab !== undefined && tab.status.kind !== 'exited') await stopTab(worktree, tab)
    setPanels((current) => startRun(current, worktree, action, command, movedTo))
  }

  const close = async (worktree: string, tab: RunTab) => {
    await stopTab(worktree, tab)
    setPanels((current) => closeTab(current, worktree, tab.action))
  }

  /** Kill it and run (or Restart): stop the holder, then run the command as asked. */
  const takePort = async (worktree: string, action: RunAction, conflict: PortConflict, command: string) => {
    await api.portKill(conflict.port)
    await restart(worktree, action, command)
  }

  /** Use 3001: run the command moved to the free port. */
  const movePort = async (worktree: string, action: RunAction, conflict: PortConflict) => {
    if (conflict.alternative === null) return
    await restart(worktree, action, conflict.alternative.command, conflict.alternative.port)
  }

  const askAboutPort = (worktree: string, action: RunAction, command: string, conflict: PortConflict) => {
    const alternative = conflict.alternative
    setConfirm({
      title: conflict.title,
      body: conflict.body,
      action: conflict.primaryLabel,
      run: () => takePort(worktree, action, conflict, command),
      ...(alternative === null ? {} : { alternative: { label: alternative.label, run: () => movePort(worktree, action, conflict) } }),
    })
  }

  // A run that failed on a taken address gets the same choice, inline in its tab.
  const afterFailure = (worktree: string, tab: RunTab, output: string) => {
    const hit = addressInUse(output)
    if (hit === null) return
    const launch = launches.current.get(launchKey(worktree, tab.action)) ?? { command: tab.command, port: null }
    const port = launch.port !== null && (hit.port === null || hit.port === launch.port.port) ? launch.port : hit.port === null ? null : portFromOutput(hit.port)
    if (port === null) return
    checkPort(worktree, launch.command, port).then(
      (conflict) => {
        if (conflict !== null) setPanels((current) => setConflict(current, worktree, tab.action, tab.generation, conflict))
      },
      () => {},
    )
  }

  return {
    panels,
    /** The run, stop or close waiting for the person's yes. */
    confirm,
    dismissConfirm: () => setConfirm(null),
    run(worktree: string, action: RunAction, command: string, port?: ScriptPort | null) {
      launches.current.set(launchKey(worktree, action), { command, port: port ?? null })
      if (isRunning(panels, worktree, action)) {
        setConfirm({
          title: `Restart ${runActionLabel[action]}?`,
          body: `${command} is still running in ${folder(worktree)}. Restarting stops it and runs the command again.`,
          action: 'Restart',
          run: () => restart(worktree, action, command),
        })
        return
      }
      if (port === undefined || port === null) {
        setPanels((current) => startRun(current, worktree, action, command))
        return
      }
      // A failed check never blocks the run; at worst it fails on the port and offers the choice then.
      checkPort(worktree, command, port).then(
        (conflict) => (conflict === null ? setPanels((current) => startRun(current, worktree, action, command)) : askAboutPort(worktree, action, command, conflict)),
        () => setPanels((current) => startRun(current, worktree, action, command)),
      )
    },
    /** The inline choice of a tab whose run failed on a taken port. */
    resolveConflict: async (worktree: string, tab: RunTab, choice: 'primary' | 'alternative') => {
      if (tab.conflict === null) return
      if (choice === 'primary') await takePort(worktree, tab.action, tab.conflict, launches.current.get(launchKey(worktree, tab.action))?.command ?? tab.command)
      else await movePort(worktree, tab.action, tab.conflict)
    },
    dismissConflict: (worktree: string, tab: RunTab) => setPanels((current) => setConflict(current, worktree, tab.action, tab.generation, null)),
    restart: (worktree: string, tab: RunTab) => void restart(worktree, tab.action, tab.command, tab.movedTo),
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
    /** A chunk of a run's output, base64; only its tail is kept. */
    output: (worktree: string, tab: RunTab, data: string) => {
      const key = outputKey(worktree, tab)
      outputs.current.set(key, `${outputs.current.get(key) ?? ''}${plain(data)}`.slice(-TAIL))
    },
    exited: (worktree: string, tab: RunTab, code: number | null) => {
      setPanels((current) => markExited(current, worktree, tab.action, tab.generation, code))
      const key = outputKey(worktree, tab)
      const output = outputs.current.get(key) ?? ''
      outputs.current.delete(key)
      if (code !== null && code !== 0) afterFailure(worktree, tab, output)
    },
  }
}

export type RunPanelsState = ReturnType<typeof useRunPanels>
