import type { Dispatch } from '@/api/schema'
import type { ChatState } from '@/advanced/model'

const agentColors: Record<string, string> = {
  codex: 'bg-[#a7f3d0]',
  claude: 'bg-[#fcd9b6]',
  grok: 'bg-[#c7d2fe]',
  agy: 'bg-[#fbcfe8]',
}

const agentLetters: Record<string, string> = { codex: 'CX', claude: 'CL', grok: 'GK', agy: 'AG' }

export function AgentBadge({ agent, size = 'md' }: { agent: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-9 rounded-[12px] text-[12px]' : 'size-7 rounded-[9px] text-[10.5px]'
  return (
    <span className={`grid shrink-0 place-items-center font-bold text-accent-ink ${box} ${agentColors[agent] ?? 'bg-ink-400'}`} aria-label={agent}>
      {agentLetters[agent] ?? agent.slice(0, 2).toUpperCase()}
    </span>
  )
}

export function chatName(chat: Dispatch): string {
  return chat.chatName ?? chat.branch ?? chat.dispatchId.slice(-8)
}

const dot: Record<ChatState, string> = {
  'needs-you': 'bg-warn',
  working: 'bg-ok shadow-[0_0_8px_#34d399]',
  queued: 'bg-accent',
  ended: 'bg-ink-500',
}

const stateLabel: Record<ChatState, string> = { 'needs-you': 'needs you', working: 'working', queued: 'queued', ended: 'ended' }

export function StateDot({ state }: { state: ChatState }) {
  return <span className={`size-2 shrink-0 rounded-full ${dot[state]}`} aria-label={stateLabel[state]} />
}

export function StateChip({ state }: { state: ChatState }) {
  const tone = state === 'needs-you' ? 'text-warn bg-warn/[0.12]' : state === 'working' ? 'text-ok bg-ok/[0.12]' : state === 'queued' ? 'text-accent bg-accent/[0.12]' : 'text-ink-400 bg-white/[0.06]'
  return <span className={`rounded-full px-3 py-1 text-[12px] font-semibold whitespace-nowrap ${tone}`}>{stateLabel[state]}</span>
}
