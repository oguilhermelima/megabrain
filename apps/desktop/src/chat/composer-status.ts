import type { Settings, UsageReading } from '@/api/schema'

// What the row under the composer's text shows: the chat's context, the agent's usage limits and
// the models it can switch to.

const compact = (value: number) => String(Number(value.toFixed(1)))

/** 412000 as 412k and 1500000 as 1.5M. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${compact(tokens / 1_000_000)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(tokens)
}

export type LimitTone = 'normal' | 'amber' | 'red'

export function limitTone(usedPercent: number): LimitTone {
  if (usedPercent > 95) return 'red'
  if (usedPercent > 80) return 'amber'
  return 'normal'
}

type Models = Settings['models']

const oneMillionSuffix = '[1m]'
const dateSuffix = /-\d{8}$/
const versionPart = /^\d+(\.\d+)*$/

interface ModelParts {
  family: string
  version: number[]
  words: string[]
}

/** An id read as family, version and the words after it: claude-3-7-sonnet-20250219 is sonnet 3.7. */
function modelParts(id: string): ModelParts {
  const segments = id.replace(oneMillionSuffix, '').replace(dateSuffix, '').split('-').filter((segment) => segment !== '')
  if (segments[0] === 'claude' && segments.length > 1) segments.shift()
  const words: string[] = []
  const version: number[] = []
  let versionDone = false
  for (const segment of segments) {
    if (versionPart.test(segment) && !versionDone) {
      version.push(...segment.split('.').map(Number))
      continue
    }
    if (version.length > 0) versionDone = true
    words.push(segment)
  }
  const [family = id, ...rest] = words
  return { family, version, words: rest }
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1)

/** A model id as people say it: claude-opus-4-5-20251101 is Opus 4.5 and gpt-6-luna is GPT-6 Luna. */
export function modelName(id: string): string {
  const { family, version, words } = modelParts(id)
  const versionText = version.join('.')
  const head = family === 'gpt' ? `GPT${versionText === '' ? '' : `-${versionText}`}` : [capitalise(family), versionText].filter((part) => part !== '').join(' ')
  return [head, ...words.map(capitalise)].join(' ')
}

/** What the model selector shows: the model's name and the effort when set, or Default. */
export function modelLabel(id: string | null, effort: string | null | undefined): string {
  if (id === null || id === '') return 'Default'
  const name = modelName(id)
  return effort === null || effort === undefined || effort === '' ? name : `${name} · ${effort}`
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const retiredStatuses = new Set(['retired', 'deprecated'])

/**
 * The models the menu shows first, the newest version of each family, and the older ones it folds
 * away; the registry's current flag decides when it is there, and a model it marks retired or
 * deprecated is always older. Both keep registry order.
 */
export function groupModels(models: Models): { current: Models; older: Models } {
  const active = models.filter((model) => typeof model.status !== 'string' || !retiredStatuses.has(model.status))
  const newest = new Map<string, number[]>()
  for (const model of active) {
    const { family, version } = modelParts(model.model)
    const known = newest.get(family)
    if (known === undefined || compareVersions(version, known) > 0) newest.set(family, version)
  }
  const isCurrent = (model: Models[number]) => {
    if (!active.includes(model)) return false
    if (typeof model.current === 'boolean') return model.current
    const { family, version } = modelParts(model.model)
    return compareVersions(version, newest.get(family) ?? []) === 0
  }
  return { current: models.filter(isCurrent), older: models.filter((model) => !isCurrent(model)) }
}

export function agentModels(models: Models, agent: string | null): Models {
  return agent === null ? [] : models.filter((model) => model.agent === agent)
}

export type ContextChoice = 'standard' | '1m'

const isOneMillion = (id: string) => id.endsWith(oneMillionSuffix)

/** The model id for a context window: Claude takes the 1M window as the id with a [1m] suffix. */
export function withContextWindow(id: string, choice: ContextChoice): string {
  const base = isOneMillion(id) ? id.slice(0, -oneMillionSuffix.length) : id
  return choice === '1m' ? `${base}${oneMillionSuffix}` : base
}

export interface ContextWindow {
  tokens: number
  /** True when the chat did not report it and it comes from the model instead. */
  derived: boolean
}

const defaultWindows: Record<string, number> = { claude: 200_000, codex: 272_000 }

/**
 * The context window the chat is measured against: the one it reports, else the model's: the 1M
 * suffix, the registry's window, then the agent's usual one; null when nothing says.
 */
export function contextWindow(reported: number | null | undefined, agent: string | null, model: string | null, models: Models): ContextWindow | null {
  if (reported !== null && reported !== undefined && reported > 0) return { tokens: reported, derived: false }
  if (model !== null && isOneMillion(model)) return { tokens: 1_000_000, derived: true }
  const listed = model === null ? undefined : models.find((item) => item.model === model && (agent === null || item.agent === agent))?.contextWindow
  if (typeof listed === 'number' && listed > 0) return { tokens: listed, derived: true }
  const fallback = agent === null ? undefined : defaultWindows[agent]
  return fallback === undefined ? null : { tokens: fallback, derived: true }
}

/** The windows a model supports, the default first: the registry's list, else 200k and 1M for Claude, else its one window. */
export function modelWindows(entry: Models[number] | undefined, agent: string | null): number[] {
  const listed = entry?.contextWindows?.filter((tokens) => tokens > 0) ?? []
  if (listed.length > 0) return listed
  if (agent === 'claude') return [200_000, 1_000_000]
  if (typeof entry?.contextWindow === 'number' && entry.contextWindow > 0) return [entry.contextWindow]
  const fallback = agent === null ? undefined : defaultWindows[agent]
  return fallback === undefined ? [] : [fallback]
}

/** The registry entry for a model id, whatever its window suffix. */
export function findModel(models: Models, id: string | null): Models[number] | undefined {
  if (id === null || id === '') return undefined
  const base = withContextWindow(id, 'standard')
  return models.find((item) => item.model === base)
}

/** The model's name: the registry's when it has a real one, else read from the id. */
export function displayName(id: string, models: Models): string {
  const entry = findModel(models, id)
  const name = entry?.name
  // The CLI fills a missing name with the id itself, which is no name at all.
  return name === undefined || name === '' || name === entry?.model ? modelName(id) : name
}

/**
 * The menu's groups for the model in use: the current ones, the older ones folded away, and the
 * model in use on its own when it is an older one, taken out of the fold so it shows while closed.
 */
export function menuGroups(models: Models, id: string | null): { current: Models; selected: Models[number] | null; older: Models } {
  const groups = groupModels(models)
  const entry = findModel(models, id)
  const selected = entry !== undefined && groups.older.includes(entry) ? entry : null
  return { current: groups.current, selected, older: groups.older.filter((model) => model !== selected) }
}

const familyHints: Record<string, string> = { haiku: 'Fastest', sonnet: 'Balanced', opus: 'Most capable' }
const fastWords = new Set(['mini', 'nano', 'flash', 'fast', 'spark'])

/** One line on what a model is for, by family; null for a family it does not know. */
export function modelHint(id: string): string | null {
  const { family, words } = modelParts(id)
  if (words.some((word) => fastWords.has(word))) return 'Fastest'
  return familyHints[family] ?? null
}

/** What the model picker shows: name, window and effort, each only when known. */
export function pickerLabel(name: string | null, window: number | null, effort: string | null | undefined): string {
  return [name ?? 'Default', window === null ? null : formatTokens(window), effort === undefined || effort === '' ? null : effort].filter((part) => part !== null).join(' · ')
}

const windowChoice = (window: number | null): ContextChoice => (window !== null && window >= 1_000_000 ? '1m' : 'standard')

/** The command that switches a running session: /model with the id, [1m] for the 1M window. */
export function modelCommand(id: string, window: number | null): string {
  return `/model ${withContextWindow(id, windowChoice(window))}`
}

// Agents whose running sessions take /effort <level>; Codex has no such command.
const effortAgents = new Set(['claude'])

/** The command that sets a running session's effort; null for an agent without one. */
export function effortCommand(agent: string | null, level: string): string | null {
  return agent !== null && effortAgents.has(agent) ? `/effort ${level}` : null
}

/**
 * The effort levels the picker offers for a model: the registry's, when the chat sets effort itself
 * (native) or the agent takes a command for it; none otherwise.
 */
export function effortLevels(entry: Models[number] | undefined, agent: string | null, native: boolean): string[] {
  if (!native && (agent === null || !effortAgents.has(agent))) return []
  return entry?.reasoning.levels ?? []
}

/** What switches a running session to a pick: /effort when only the effort changes, else /model; null when the agent cannot. */
export function sessionCommand(agent: string | null, current: string | null, pick: { model: string; window: number | null; effort: string | undefined }): string | null {
  if (current === pick.model) return pick.effort === undefined ? null : effortCommand(agent, pick.effort)
  return modelCommand(pick.model, pick.window)
}

/** The id and window a picked model runs with: the window in use when it supports it, else its first. */
export function switchTarget(id: string, windows: number[], currentWindow: number | null): { model: string; window: number | null } {
  const window = currentWindow !== null && windows.includes(currentWindow) ? currentWindow : (windows[0] ?? null)
  return { model: window === null ? id : withContextWindow(id, windowChoice(window)), window }
}

/**
 * Switching drops the prompt cache, so it asks first once the chat holds context and the model really
 * changes. An effort change alone does not ask: Claude sends effort per turn and keeps the cache.
 */
export function switchNeedsConfirm(from: string | null, to: string, contextTokens: number | null | undefined): boolean {
  return contextTokens !== null && contextTokens !== undefined && contextTokens > 0 && from !== to
}

export function contextChoice(window: ContextWindow | null): ContextChoice {
  return window !== null && window.tokens >= 1_000_000 ? '1m' : 'standard'
}

export interface ContextUsage {
  label: string
  /** Share of the window used, 0 to 1; null when the window is unknown. */
  fraction: number | null
  tone: LimitTone
}

/** The context used, of the window when it is known; null hides it. */
export function contextUsage(tokens: number | null | undefined, window: number | null | undefined): ContextUsage | null {
  if (tokens === null || tokens === undefined) return null
  if (window === null || window === undefined || window <= 0) return { label: formatTokens(tokens), fraction: null, tone: 'normal' }
  const fraction = Math.min(1, tokens / window)
  return { label: `${formatTokens(tokens)} / ${formatTokens(window)}`, fraction, tone: limitTone(fraction * 100) }
}

const exact = (tokens: number) => tokens.toLocaleString('en-US')

export interface ContextMeter {
  /** Always shown: used of the window, the count alone without one, a dash when unknown. */
  text: string
  /** Share of the window used, 0 to 1; null when either side is unknown. */
  fraction: number | null
  tone: LimitTone
  /** The exact tokens and where the window came from, for the tooltip. */
  title: string
}

/** The context used as the toolbar shows it at all times, a dash while the chat has not reported it. */
export function contextMeter(tokens: number | null | undefined, size: ContextWindow | null): ContextMeter {
  const usage = contextUsage(tokens, size?.tokens)
  if (usage === null || tokens === null || tokens === undefined) return { text: '—', fraction: null, tone: 'normal', title: 'Context used: not reported yet' }
  if (size === null || usage.fraction === null) return { text: usage.label, fraction: null, tone: usage.tone, title: `Context used: ${exact(tokens)} tokens. Window unknown.` }
  const derived = size.derived ? '. Window from the model; the chat does not report it.' : ''
  return {
    text: usage.label,
    fraction: usage.fraction,
    tone: usage.tone,
    title: `Context used: ${exact(tokens)} of ${exact(size.tokens)} tokens (${Math.round(usage.fraction * 100)}%)${derived}`,
  }
}

const effortNames: Record<string, string> = { xhigh: 'X-High' }

/** An effort level as the menu labels it: xhigh is X-High, the rest capitalised. */
export function effortName(level: string): string {
  return effortNames[level] ?? capitalise(level)
}

const unixSeconds = /^\d+(\.\d+)?$/
// JavaScriptCore reads at most three digits of a second's fraction; Python writes six.
const longFraction = /(\.\d{3})\d+/

/** When a limit resets: Codex reports unix seconds in a string and Claude an ISO date; null otherwise. */
export function parseResetsAt(value: string | null): Date | null {
  if (value === null) return null
  const text = value.trim()
  if (text === '') return null
  const time = unixSeconds.test(text) ? Number(text) * 1000 : Date.parse(text.replace(longFraction, '$1'))
  return Number.isFinite(time) ? new Date(time) : null
}

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** A reset as a short phrase: hours and minutes within a day, the weekday beyond it. */
export function resetText(at: Date, now: Date = new Date()): string {
  const milliseconds = at.getTime() - now.getTime()
  if (milliseconds <= 0) return 'resets now'
  const minutes = Math.ceil(milliseconds / 60_000)
  if (minutes >= 24 * 60) return `resets ${weekdays[at.getDay()] ?? ''}`
  const hours = Math.floor(minutes / 60)
  return `resets ${hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`
}

export interface AgentLimit {
  window: string
  usedPercent: number
  tone: LimitTone
  /** Short reset text, or null when the reading has no reset time anyone can read. */
  resets: string | null
  resetsAt: Date | null
}

/** The usage windows the row shows, in order. */
export const limitWindows = ['5h', 'weekly']

/** The agent's 5-hour and weekly usage, leaving out a window with no reading. */
export function agentLimits(readings: UsageReading[], agent: string, now: Date = new Date()): AgentLimit[] {
  return limitWindows.flatMap((window) => {
    const reading = readings.find((item) => item.provider === agent && item.window === window)
    if (reading === undefined || reading.usedPercent === null) return []
    const resetsAt = parseResetsAt(reading.resetsAt)
    return [{ window, usedPercent: reading.usedPercent, tone: limitTone(reading.usedPercent), resets: resetsAt === null ? null : resetText(resetsAt, now), resetsAt }]
  })
}
