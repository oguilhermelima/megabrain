import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import { agentMarkLook, type AgentActivity } from '@/components/agent-activity'

// Simple monochrome marks that say which agent a chat runs. They take currentColor. The spark for
// Claude and the four-point star for agy are drawn for this app. The OpenAI blossom for Codex and the
// xAI mark for Grok come from @lobehub/icons-static-svg 1.95.1 (icons/openai.svg, icons/grok.svg),
// MIT licensed, copyright LobeHub (https://github.com/lobehub/lobe-icons); drawn on a 24px grid, they
// are scaled onto this 16px one.
// Given an activity, the mark also says what its chat does (see agent-activity.ts): Claude, Codex and
// agy turn in their colour while they work, Grok's mark carries a wave of colour, and a mark waiting
// for the person pulses amber. Reduced motion keeps the colour and drops the movement (styles.css).

const marks: Record<string, ReactNode> = {
  claude: (
    <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
    </g>
  ),
  codex: <path fill="currentColor" fillRule="evenodd" transform="scale(0.6667)" d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />,
  grok: <path fill="currentColor" fillRule="evenodd" transform="scale(0.6667)" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />,
  agy: <path fill="currentColor" d="M8 1.5c.5 3.4 3.1 6 6.5 6.5-3.4.5-6 3.1-6.5 6.5-.5-3.4-3.1-6-6.5-6.5 3.4-.5 6-3.1 6.5-6.5Z" />,
}

/** A project's colour for the marks inside it (the sidebar sets it per project); null keeps the agents' own colours. */
export const AgentTint = createContext<string | null>(null)

const motionClass = { spin: 'agent-mark-spin', wave: 'agent-mark-wave', pulse: 'agent-mark-pulse' }

export function AgentIcon({ agent, size = 14, className = '', activity = 'idle' }: { agent: string; size?: number; className?: string; activity?: AgentActivity }) {
  const look = agentMarkLook(agent, activity, useContext(AgentTint))
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
