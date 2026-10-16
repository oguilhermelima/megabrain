import type { NativeChat, ProjectSession } from '@/api/schema'

// What an agent's mark shows about its chat or session: still and grey while idle, in the agent's
// colour and moving while it works, amber and pulsing while it waits for the person.

export type AgentActivity = 'working' | 'waiting' | 'idle'

/** The activity of a native chat state or a projects session status. */
export function activityOf(state: NativeChat['state'] | ProjectSession['status'] | 'unknown'): AgentActivity {
  if (state === 'working' || state === 'starting') return 'working'
  if (state === 'waiting' || state === 'waiting-approval') return 'waiting'
  return 'idle'
}

export interface AgentMarkLook {
  /** A CSS colour, 'amber' for the theme's warning tone, or null for the row's own grey. */
  color: string | null
  /** spin turns the mark, wave sweeps a band of colour across it, pulse fades it in and out. */
  motion: 'spin' | 'wave' | 'pulse' | null
}

// Claude's brand orange; the others take a tint of their own marks' usual colours.
const working: Record<string, AgentMarkLook> = {
  claude: { color: '#D97757', motion: 'spin' },
  codex: { color: '#7C8CFF', motion: 'spin' },
  agy: { color: '#4C8DF6', motion: 'spin' },
  grok: { color: '#5EC8F2', motion: 'wave' },
}

export function agentMarkLook(agent: string, activity: AgentActivity): AgentMarkLook {
  if (activity === 'idle') return { color: null, motion: null }
  if (activity === 'waiting') return { color: 'amber', motion: 'pulse' }
  return working[agent] ?? { color: 'var(--color-accent)', motion: 'spin' }
}
