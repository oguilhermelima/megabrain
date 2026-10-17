import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { AgentDefaults } from '@/api/schema'

// Each agent's configured default and the login shell, read once per app run and shared by every
// caller; null until the report arrives, or when it cannot be read.
let agentDefaults: Promise<AgentDefaults | null> | null = null

export function useAgentDefaults(): AgentDefaults | null {
  const [defaults, setDefaults] = useState<AgentDefaults | null>(null)
  useEffect(() => {
    let stopped = false
    agentDefaults ??= api.agentDefaults().catch(() => null)
    void agentDefaults.then((report) => {
      if (!stopped) setDefaults(report)
    })
    return () => {
      stopped = true
    }
  }, [])
  return defaults
}
