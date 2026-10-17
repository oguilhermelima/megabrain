import type { Settings } from '@/api/schema'
import { displayName, effortName, formatTokens, groupModels } from '@/chat/composer-status'

// Settings > Models: which models the picker offers and each agent's default for a new chat, saved
// with `settings get|set models` as { version: 1, models: { 'agent/model': on }, defaults: { agent:
// { model, effort } } }. Only what the person changed is saved; the CLI says which models are on.

export interface ModelSettings {
  version: 1
  models: Record<string, boolean>
  defaults: Record<string, { model: string; effort: string | null }>
}

export const defaultModelSettings: ModelSettings = { version: 1, models: {}, defaults: {} }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Reads what `settings get models` printed; anything unusable is dropped entry by entry. */
export function parseModelSettings(value: unknown): ModelSettings {
  if (!isRecord(value)) return defaultModelSettings
  const models = isRecord(value.models) ? Object.fromEntries(Object.entries(value.models).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')) : {}
  const defaults = isRecord(value.defaults)
    ? Object.fromEntries(
        Object.entries(value.defaults).flatMap(([agent, entry]) =>
          isRecord(entry) && typeof entry.model === 'string' && entry.model !== '' ? [[agent, { model: entry.model, effort: typeof entry.effort === 'string' ? entry.effort : null }]] : [],
        ),
      )
    : {}
  return { version: 1, models, defaults }
}

export function serialiseModelSettings(settings: ModelSettings): string {
  return JSON.stringify(settings)
}

/** Turns a model on or off; turning off the model an agent starts with clears that default. */
export function withModelEnabled(settings: ModelSettings, agent: string, model: string, enabled: boolean): ModelSettings {
  const defaults = !enabled && settings.defaults[agent]?.model === model ? Object.fromEntries(Object.entries(settings.defaults).filter(([key]) => key !== agent)) : settings.defaults
  return { ...settings, models: { ...settings.models, [`${agent}/${model}`]: enabled }, defaults }
}

/** Sets the model and effort an agent's new chats start with, or clears them with a null model. */
export function withAgentDefault(settings: ModelSettings, agent: string, model: string | null, effort: string | null): ModelSettings {
  const others = Object.fromEntries(Object.entries(settings.defaults).filter(([key]) => key !== agent))
  return { ...settings, defaults: model === null ? others : { ...others, [agent]: { model, effort } } }
}

/** What a new chat with this agent starts on before the person picks: its saved default, or nothing. */
export function startPick(settings: ModelSettings, agent: string | null): { model: string; effort: string | null } | null {
  return agent === null ? null : (settings.defaults[agent] ?? null)
}

type Models = Settings['models']

export interface ModelCard {
  agent: string
  /** The models the agent's makers call current, then the older and deprecated ones, each in registry order. */
  current: Models
  older: Models
  /** Over every model of the agent, whatever the search shows. */
  counts: { enabled: number; total: number }
}

const agentOrder = ['claude', 'codex', 'grok', 'agy']
const rank = (agent: string) => {
  const index = agentOrder.indexOf(agent)
  return index === -1 ? agentOrder.length : index
}

/** A model the CLI did not mark is on: an older CLI says nothing about it. */
export const isEnabled = (model: Models[number]) => model.enabled !== false

/** The words a search looks in: the name, the id and the best-for line. */
const searchText = (model: Models[number]) => [displayName(model.model, [model]), model.model, model.description ?? ''].join(' ').toLowerCase()

/**
 * One card per agent, claude, codex, grok and agy first: its current models, its older ones, and
 * how many are on. A search keeps the models whose name, id or best-for line holds it, and drops an
 * agent with none left.
 */
export function modelCards(models: Models, query: string): ModelCard[] {
  const needle = query.trim().toLowerCase()
  const agents = [...new Set(models.map((model) => model.agent))].sort((left, right) => rank(left) - rank(right))
  return agents.flatMap((agent) => {
    const own = models.filter((model) => model.agent === agent)
    const shown = needle === '' ? own : own.filter((model) => searchText(model).includes(needle))
    if (shown.length === 0) return []
    const { current, older } = groupModels(shown)
    return [{ agent, current, older, counts: { enabled: own.filter(isEnabled).length, total: own.length } }]
  })
}

/** Effort levels as a person reads them: Low · Medium · High. */
export function levelList(levels: string[]): string {
  return levels.length === 0 ? 'No effort setting' : levels.map(effortName).join(' · ')
}

/** Context windows as short sizes, 200k · 1M; null when none is known. */
export function windowList(windows: number[]): string | null {
  return windows.length === 0 ? null : windows.map(formatTokens).join(' · ')
}
