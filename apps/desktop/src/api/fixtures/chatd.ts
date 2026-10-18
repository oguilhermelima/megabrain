import type { ChatDaemonStatus } from '@/api/schema'

// The chatd the mock app finds on start, chosen with ?chatd=older|incompatible in the URL (the
// current one otherwise). Retiring an older daemon lets its chats finish over a few seconds; draining
// stops it once its turns end. Either way the next status reads a fresh daemon of the app's version.
const PROTOCOL = { version: 3, min: 2, max: 3 }
const runningStatus = (daemonVersion: string, compatible: boolean, liveChats: number, protocol = PROTOCOL): ChatDaemonStatus => ({
  running: true, pid: 4210, protocol, daemonVersion, superseded: false, liveChats, compatible,
  build: 1, draining: false, working: [],
})

export function createMockChatd(appVersion: string, scenario = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('chatd')) {
  let status: ChatDaemonStatus =
    scenario === 'older'
      ? runningStatus('0.2.3', true, 2)
      : scenario === 'incompatible'
        ? runningStatus('0.1.8', false, 2, { version: 1, min: 1, max: 1 })
        : runningStatus(appVersion, true, 0)
  const fresh = runningStatus(appVersion, true, 0)
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  return {
    status: async () => status,
    retire: async () => {
      if (!status.running) return { running: false as const }
      status = { ...status, superseded: true }
      // The mock's older chats keep going for a minute, long enough to look at the notice.
      setTimeout(() => (status = fresh), 60_000)
      return { running: true as const, retired: true as const, waitedMs: 0 }
    },
    drain: async () => {
      await wait(2500)
      status = fresh
    },
  }
}
