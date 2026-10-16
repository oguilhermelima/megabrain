import type { Settings } from '@/api/schema'
import { agentModels, groupModels } from '@/chat/composer-status'

// Chat summaries: an agent the person picks reads a native chat every few messages or minutes,
// writes a short summary and, when allowed, retitles the chat. Saved as JSON through
// `megabrain settings set chat-summaries`; off until the person turns it on.

type Models = Settings['models']

export const summaryAgents = ['claude', 'codex', 'grok', 'agy'] as const
export type SummaryAgent = (typeof summaryAgents)[number]

export interface ChatSummaries {
  enabled: boolean
  agent: SummaryAgent
  /** The model id; empty until one is chosen, which leaves the agent's default. */
  model: string
  /** The reasoning level; null is the model's default. */
  effort: string | null
  everyMessages: number
  everyMinutes: number
  /** Summaries may rename the chat; a title the person set is never replaced. */
  retitle: boolean
}

export const defaultChatSummaries: ChatSummaries = { enabled: false, agent: 'claude', model: '', effort: null, everyMessages: 6, everyMinutes: 10, retitle: true }

const isAgent = (value: unknown): value is SummaryAgent => typeof value === 'string' && (summaryAgents as readonly string[]).includes(value)
const count = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback)

/** What `settings get chat-summaries` printed; a field that is missing or unusable takes its default. */
export function parseChatSummaries(raw: unknown): ChatSummaries {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return defaultChatSummaries
  const saved = raw as Record<string, unknown>
  const fallback = defaultChatSummaries
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : fallback.enabled,
    agent: isAgent(saved.agent) ? saved.agent : fallback.agent,
    model: typeof saved.model === 'string' ? saved.model : fallback.model,
    effort: typeof saved.effort === 'string' && saved.effort !== '' ? saved.effort : null,
    everyMessages: count(saved.everyMessages, fallback.everyMessages),
    everyMinutes: count(saved.everyMinutes, fallback.everyMinutes),
    retitle: typeof saved.retitle === 'boolean' ? saved.retitle : fallback.retitle,
  }
}

export const serialiseChatSummaries = (saved: ChatSummaries): string => JSON.stringify(saved)

/** The agent's models as the composer's picker groups them: the current generation, then the older ones. */
export function summaryModels(models: Models, agent: SummaryAgent): { current: Models; older: Models } {
  return groupModels(agentModels(models, agent))
}

/** Another agent: its first current model, at that model's default effort. */
export function withAgent(saved: ChatSummaries, agent: SummaryAgent, models: Models): ChatSummaries {
  const groups = summaryModels(models, agent)
  const first = groups.current[0] ?? groups.older[0]
  return { ...saved, agent, model: first?.model ?? '', effort: null }
}

/** Another model: an effort it does not offer goes back to the default. */
export function withModel(saved: ChatSummaries, model: string, models: Models): ChatSummaries {
  const levels = effortLevels(models, saved.agent, model)
  return { ...saved, model, effort: saved.effort !== null && levels.includes(saved.effort) ? saved.effort : null }
}

/** The reasoning levels the chosen model offers; none for a model the registry does not list. */
export function effortLevels(models: Models, agent: SummaryAgent, model: string): string[] {
  return models.find((entry) => entry.agent === agent && entry.model === model)?.reasoning.levels ?? []
}
