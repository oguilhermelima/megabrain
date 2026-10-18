import type { NativeChat } from '@/api/schema'
import { agentNames } from '@/settings/agents-model'

// What a native chat can do depends on the agent's protocol: Claude and Codex do everything they
// always did, Grok and agy say in the record. The view hides or locks whatever the agent cannot do.

export type ChatCapabilities = NonNullable<NativeChat['capabilities']>

const nothing: ChatCapabilities = { approvals: false, interrupt: false, liveModelSwitch: false, steer: false, structuredTools: false }

// A daemon from before capabilities reported none; its Claude and Codex chats keep their behaviour.
const before: Record<string, ChatCapabilities> = {
  claude: { approvals: true, interrupt: true, liveModelSwitch: true, steer: false, structuredTools: true },
  codex: { approvals: true, interrupt: true, liveModelSwitch: true, steer: true, structuredTools: true },
}

/** The record's capabilities, else Claude's and Codex's own, else none. */
export function chatCapabilities(chat: NativeChat): ChatCapabilities {
  if (chat.capabilities !== undefined) {
    const { approvals, interrupt, liveModelSwitch, steer, structuredTools } = chat.capabilities
    return { approvals, interrupt, liveModelSwitch, steer, structuredTools }
  }
  return before[chat.agent] ?? nothing
}

export interface ChatControls {
  /** Approval cards and the waiting line. */
  approvals: boolean
  /** The stop button and Esc. */
  stop: boolean
  /** Steer on a queued message: only while a turn runs. */
  steer: boolean
  /** Send now on a queued message while a turn runs, which stops that turn first. */
  sendNowWhileBusy: boolean
  /** Why the model picker is locked; null when it switches the running chat. */
  modelLock: string | null
}

/** The controls the chat view offers for a chat now. */
export function chatControls(chat: NativeChat): ChatControls {
  const can = chatCapabilities(chat)
  const name = agentNames[chat.agent] ?? chat.agent
  return {
    approvals: can.approvals,
    stop: can.interrupt,
    steer: can.steer && chat.state === 'working',
    sendNowWhileBusy: can.interrupt,
    modelLock: can.liveModelSwitch ? null : `${name} cannot switch models in a running chat; start a new chat to use another model`,
  }
}
