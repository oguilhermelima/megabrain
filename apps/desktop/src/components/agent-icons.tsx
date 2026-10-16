import { createContext, type CSSProperties, type ReactNode } from 'react'
import { agentMarkLook, type AgentActivity } from '@/components/agent-activity'

// Simple monochrome marks that say which agent a chat runs, drawn for this app: a spark for Claude,
// a hexagon knot for Codex, a slash for Grok and a four-point star for agy. They take currentColor.
// Given an activity, the mark also says what its chat does (see agent-activity.ts): Claude, Codex and
// agy turn in their colour while they work, Grok's mark carries a wave of colour, and a mark waiting
// for the person pulses amber. Reduced motion keeps the colour and drops the movement (styles.css).

const marks: Record<string, ReactNode> = {
  claude: (
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
    </g>
  ),
  codex: (
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M8 1.8 13.4 4.9v6.2L8 14.2 2.6 11.1V4.9Z" />
      <path d="M8 5.2 10.4 6.6v2.8L8 10.8 5.6 9.4V6.6Z" />
      <path d="M8 1.8v3.4M13.4 11.1l-3-1.7M2.6 11.1l3-1.7" />
    </g>
  ),
  grok: (
    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M11.5 2.5 4.5 13.5" />
      <path d="M3 5.5h3" />
    </g>
  ),
  agy: <path fill="currentColor" d="M8 1.5c.5 3.4 3.1 6 6.5 6.5-3.4.5-6 3.1-6.5 6.5-.5-3.4-3.1-6-6.5-6.5 3.4-.5 6-3.1 6.5-6.5Z" />,
}

const motionClass = { spin: 'agent-mark-spin', wave: 'agent-mark-wave', pulse: 'agent-mark-pulse' }

export function AgentIcon({ agent, size = 14, className = '', activity = 'idle' }: { agent: string; size?: number; className?: string; activity?: AgentActivity }) {
  const look = agentMarkLook(agent, activity)
  const style: CSSProperties | undefined = look.color === null ? undefined : { color: look.color === 'amber' ? 'var(--color-warn)' : look.color }
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} role="img" aria-label={activity === 'idle' ? agent : `${agent}, ${activity}`} style={style} className={`shrink-0 ${look.motion === null ? '' : motionClass[look.motion]} ${className}`}>
      <title>{agent}</title>
      {marks[agent] ?? <circle cx="8" cy="8" r="3" fill="currentColor" />}
    </svg>
  )
}

/** The agent a conversation view runs, so its working rows show that agent's mark instead of megabrain's orb. */
export const ConversationAgent = createContext<string | null>(null)
