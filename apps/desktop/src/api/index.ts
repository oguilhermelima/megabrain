import type { AppApi } from '@/api/adapter'
import { createMockApi } from '@/api/mock'
import { createTauriApi } from '@/api/tauri'
import { mockWorktreeApi, tauriWorktreeApi } from '@/api/worktree-create'
import { announceAction } from '@/lib/app-events'
import { native } from '@/lib/surface'

// The calls that change what status and projects report; the reads refresh once one settles.
const actions = ['reply', 'setHidden', 'removeProject', 'removeWorktree', 'unqueue', 'sendToSession', 'releaseSession', 'importFolder', 'importClone', 'setProjectScripts', 'createWorktree'] as const

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

export const api: AppApi = announcingActions(native ? { ...createTauriApi(), ...tauriWorktreeApi() } : { ...createMockApi(), ...mockWorktreeApi() })
