import type { AppApi } from '@/api/adapter'
import { createMockApi } from '@/api/mock'
import { createTauriApi } from '@/api/tauri'
import { mockWorktreeApi, tauriWorktreeApi } from '@/api/worktree-create'
import { mockOrchestrationApi, tauriOrchestrationApi } from '@/native-chat/orchestration/orchestration-api'
import { announceAction } from '@/lib/app-events'
import { isIncompatible, reportIncompatible } from '@/native-chat/chatd-reconnect'
import { native } from '@/lib/surface'

const webBridge = Boolean(import.meta.env.VITE_MEGABRAIN_BRIDGE)

// The calls that change what status and projects report; the reads refresh once one settles.
const actions = ['reply', 'setHidden', 'removeProject', 'removeWorktree', 'unqueue', 'sendToSession', 'releaseSession', 'ownSession', 'removeChat', 'importFolder', 'importClone', 'setProjectScripts', 'setProjectAppearance', 'archiveWorktree', 'unarchiveWorktree', 'createWorktree', 'setPrState', 'setPrReady', 'stackRun'] as const

function announcingActions(base: AppApi): AppApi {
  const wrapped: AppApi = { ...base }
  for (const name of actions) {
    const call = base[name] as (...args: unknown[]) => Promise<unknown>
    ;(wrapped as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const done = call.apply(base, args)
      done.then(announceAction, announceAction)
      return done
    }
  }
  return wrapped
}

// A call refused because chatd speaks a protocol this CLI cannot is the reconnect watcher's signal.
function reportingIncompatible(base: AppApi): AppApi {
  const wrapped: AppApi = { ...base }
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'function') continue
    ;(wrapped as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const result: unknown = (value as (...args: unknown[]) => unknown).apply(base, args)
      if (result instanceof Promise) result.catch((caught: unknown) => isIncompatible(caught) && reportIncompatible())
      return result
    }
  }
  return wrapped
}

export const api: AppApi = reportingIncompatible(announcingActions(native || webBridge ? { ...createTauriApi(), ...tauriWorktreeApi(), ...tauriOrchestrationApi() } : { ...createMockApi(), ...mockWorktreeApi(), ...mockOrchestrationApi() }))
