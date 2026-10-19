import { useEffect, useMemo, useState } from 'react'
import { api } from '@/api'
import type { OrchestrationGraph, OrchestrationNode, OrchestrationTarget } from '@/api/schema'
import { chatLanes } from '@/native-chat/activity-tray'
import { onVisibility, windowShows } from '@/lib/app-events'
import { createSharedFollow } from '@/lib/shared-follow'

// The app's one live follow of each orchestration tree: the Orchestration view and the activity tray
// of a shown chat read the same CLI follow, which pauses while the window is hidden.

const targetKey = (target: OrchestrationTarget) => ('chatId' in target ? `chat:${target.chatId}` : `session:${target.sessionId}`)
const keyTarget = (key: string): OrchestrationTarget => (key.startsWith('chat:') ? { chatId: key.slice('chat:'.length) } : { sessionId: key.slice('session:'.length) })

const shared = createSharedFollow<OrchestrationGraph>({
  start: (key, onGraph, onEnd) => api.followOrchestration(keyTarget(key), onGraph, onEnd),
  visible: windowShows,
  onVisibility,
})

/** As api.followOrchestration, shared with every other reader of the same tree. */
export function followOrchestration(target: OrchestrationTarget, onGraph: (graph: OrchestrationGraph) => void, onEnd?: (error: string | null) => void): Promise<() => void> {
  return shared(targetKey(target), onGraph, onEnd)
}

/** The live lanes a chat started, from the shared follow of its tree; none until the first graph or when there is no follow to be had. */
export function useChatLanes(chatId: string): OrchestrationNode[] {
  const [graph, setGraph] = useState<OrchestrationGraph | null>(null)
  useEffect(() => {
    let stopped = false
    let stop: (() => void) | null = null
    setGraph(null)
    followOrchestration({ chatId }, (next) => !stopped && setGraph(next)).then(
      (cancel) => {
        if (stopped) cancel()
        else stop = cancel
      },
      // The tray shows the rest without lanes.
      () => {},
    )
    return () => {
      stopped = true
      stop?.()
    }
  }, [chatId])
  return useMemo(() => chatLanes(graph), [graph])
}
