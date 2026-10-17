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

// Claude's brand orange and agy's blue; Codex and Grok, whose marks are monochrome, take the near-white ink.
const working: Record<string, AgentMarkLook> = {
  claude: { color: '#D97757', motion: 'spin' },
  codex: { color: 'var(--color-ink-100)', motion: 'spin' },
  agy: { color: '#4C8DF6', motion: 'spin' },
  grok: { color: 'var(--color-ink-100)', motion: 'wave' },
}

const fallbackColor = 'var(--color-accent)'

/** An agent's own colour, the one its mark turns while it works; an agent the app does not know takes the accent. */
export const agentColor = (agent: string): string => working[agent]?.color ?? fallbackColor

/**
 * `tint` is the project's colour, when the person gave it one: it replaces the grey while idle and
 * the brand colour while working, keeping each agent's motion. Waiting stays amber, the one state
 * that asks for the person and must read the same in every project.
 */
export function agentMarkLook(agent: string, activity: AgentActivity, tint: string | null = null): AgentMarkLook {
  if (activity === 'idle') return { color: tint, motion: null }
  if (activity === 'waiting') return { color: 'amber', motion: 'pulse' }
  const look = working[agent] ?? { color: fallbackColor, motion: 'spin' }
  return tint === null ? look : { ...look, color: tint }
}
