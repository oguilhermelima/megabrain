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

/** The context meter's tone: amber above 80 percent, red above 95. */
export function limitTone(usedPercent: number): LimitTone {
  if (usedPercent > 95) return 'red'
  if (usedPercent > 80) return 'amber'
  return 'normal'
}

/** A usage limit's tone: warning (amber) above 70 percent, critical (red) above 90. */
export function usageLimitTone(usedPercent: number): LimitTone {
  if (usedPercent > 90) return 'red'
  if (usedPercent > 70) return 'amber'
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
  return effort === null || effort === undefined || effort === '' ? name : `${name} · ${effortName(effort)}`
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

const retiredStatuses = new Set(['retired', 'deprecated'])
const fastWords = new Set(['mini', 'nano', 'flash', 'fast', 'spark'])

/**
 * The models the menu shows first and the older ones it folds away. The registry says which is
 * which: current, or older and deprecated. A model it says neither of, from a CLI older than those
 * statuses, is placed by rule instead. A model's line is its family with the words after its
 * version (gpt-6-luna is the gpt luna line, gemini-3.8-flash the gemini flash line), and its class
 * is the family split into a standard and a fast tier (flash, mini, fast...), since a fast tier
 * ships on its own clock. Such a model is main when it is the newest of its line and its line's
 * generation, the major version, is the newest of its class; one marked retired, or with no version
 * to rank, is older. Both groups come in the curated order (sortModels).
 */
export function groupModels(models: Models): { current: Models; older: Models } {
  const ranked = models.flatMap((model) => {
    if (model.status === 'current' || model.status === 'older' || (typeof model.status === 'string' && retiredStatuses.has(model.status))) return []
    const { family, version, words } = modelParts(model.model)
    if (version.length === 0) return []
    const tier = words.some((word) => fastWords.has(word)) ? 'fast' : 'standard'
    return [{ model, version, line: [family, ...words].join(' '), kind: `${family} ${tier}` }]
  })
  const newestInLine = new Map<string, number[]>()
  const newestGeneration = new Map<string, number>()
  for (const { version, line, kind } of ranked) {
    const known = newestInLine.get(line)
    if (known === undefined || compareVersions(version, known) > 0) newestInLine.set(line, version)
    newestGeneration.set(kind, Math.max(newestGeneration.get(kind) ?? 0, version[0] ?? 0))
  }
  const main = new Set(ranked.filter((item) => compareVersions(item.version, newestInLine.get(item.line) ?? []) === 0 && item.version[0] === newestGeneration.get(item.kind)).map((item) => item.model))
  const isCurrent = (model: Models[number]) => model.status === 'current' || main.has(model)
  const sorted = sortModels(models)
  return { current: sorted.filter(isCurrent), older: sorted.filter((model) => !isCurrent(model)) }
}

// Each agent's tiers, most capable first; a tier is a family (opus) or the word after a version (sol).
const tierRanks: Record<string, number> = { fable: 4, opus: 3, sonnet: 2, haiku: 1, astra: 4, sol: 3, terra: 2, luna: 1 }
const claudeFamilies = new Set(['fable', 'opus', 'sonnet', 'haiku', 'mythos'])

function tierOf({ family, words }: ModelParts): string | undefined {
  return [family, ...words].find((word) => tierRanks[word] !== undefined)
}

/**
 * The models in the order a person choosing reads them: newest generation first, and within one the
 * most capable tier first, a fast variant (flash, mini, fast...) after its standard one. The
 * generation is the registry's, else the version in the id. An agent offering several makers' models
 * (agy) keeps each maker together, in the order the registry first names them; a model with no
 * version comes last of its maker.
 */
export function sortModels(models: Models): Models {
  const makers: string[] = []
  const keyed = models.map((model, index) => {
    const parts = modelParts(model.model)
    const maker = claudeFamilies.has(parts.family) ? 'claude' : parts.family
    if (!makers.includes(maker)) makers.push(maker)
    const generation = typeof model.generation === 'string' && versionPart.test(model.generation) ? model.generation.split('.').map(Number) : parts.version
    const tier = tierOf(parts)
    const rank = (tier === undefined ? 0 : (tierRanks[tier] ?? 0)) - (parts.words.some((word) => fastWords.has(word)) ? 1 : 0)
    return { model, index, maker, generation, rank }
  })
  keyed.sort((left, right) => {
    if (left.maker !== right.maker) return makers.indexOf(left.maker) - makers.indexOf(right.maker)
    if (left.generation.length === 0 || right.generation.length === 0) return right.generation.length - left.generation.length || left.index - right.index
    return compareVersions(right.generation, left.generation) || right.rank - left.rank || left.index - right.index
  })
  return keyed.map((item) => item.model)
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

/** The window a model starts on: 1M wherever it supports it, else its first; null when none is known. */
export function defaultWindow(windows: number[]): number | null {
  return windows.find((tokens) => tokens >= 1_000_000) ?? windows[0] ?? null
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
  // The CLI fills a missing name with the id itself, which is no name at all, and some agents name a
  // model by its version alone ("4.7" for grok-4.7, "3.7 Sonnet"), which drops the family.
  return name === undefined || name === '' || name === entry?.model || /^\d/.test(name) ? modelName(id) : name
}

/**
 * The menu's groups for the model in use: the current ones, the older ones folded away, and the
 * model in use on its own when it is an older one, taken out of the fold so it shows while closed.
 */
export function menuGroups(models: Models, id: string | null): { current: Models; selected: Models[number] | null; older: Models } {
  const entry = findModel(models, id)
  // Settings > Models turns models off; the one in use stays, so the menu still says what runs.
  const groups = groupModels(models.filter((model) => model.enabled !== false || model === entry))
  const selected = entry !== undefined && (groups.older.includes(entry) || entry.enabled === false) ? entry : null
  return { current: groups.current.filter((model) => model !== selected), selected, older: groups.older.filter((model) => model !== selected) }
}

// One line per tier on what it is for, the same for every generation of it, so the list reads evenly.
const tierHints: Record<string, string> = {
  fable: 'The hardest problems, when quality matters most',
  opus: 'Most capable, for long and hard work',
  sonnet: 'Everyday coding, fast and capable',
  haiku: 'Quick edits and simple questions',
  astra: 'The hardest problems and architecture',
  sol: 'Everyday coding and long tasks',
  terra: 'Plain work, balanced and cheaper',
  luna: 'Quick edits and simple tasks',
}

/** One line on what a model's tier is for; null for one it does not know. */
export function modelHint(id: string): string | null {
  const tier = tierOf(modelParts(id))
  return tier === undefined ? null : (tierHints[tier] ?? null)
}

/** The one line under a model's name: its tier's line, else the registry's own description; null when neither says. */
export function modelDescriptor(entry: Models[number]): string | null {
  return modelHint(entry.model) ?? (typeof entry.description === 'string' && entry.description !== '' ? entry.description : null)
}

/**
 * The effort a chat runs at: the one it set, else the agent's configured default when the model takes
 * that level (any level for a model the registry does not know), else the model's own default.
 */
export function effortInUse(chosen: string | undefined, entry: Models[number] | undefined, configured: string | null): string | undefined {
  if (chosen !== undefined) return chosen
  if (entry === undefined) return configured ?? undefined
  if (configured !== null && entry.reasoning.levels.includes(configured)) return configured
  return entry.reasoning.default ?? undefined
}

/** What the model picker shows: name, window and effort, each only when known. */
export function pickerLabel(name: string | null, window: number | null, effort: string | null | undefined): string {
  return [name ?? 'Default', effort == null || effort === '' ? null : effortName(effort), window === null ? null : formatTokens(window)].filter((part) => part !== null).join(' · ')
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
/** The level an arrow, Home or End moves the effort slider to; null for any other key or no levels. */
export function effortStep(levels: string[], current: string | undefined, key: string): string | null {
  if (levels.length === 0) return null
  const index = current === undefined ? -1 : levels.indexOf(current)
  const at = (position: number) => levels[Math.min(Math.max(position, 0), levels.length - 1)] ?? null
  if (key === 'ArrowRight' || key === 'ArrowUp') return at(index + 1)
  if (key === 'ArrowLeft' || key === 'ArrowDown') return at(index - 1)
  if (key === 'Home') return at(0)
  if (key === 'End') return at(levels.length - 1)
  return null
}

export function effortName(level: string): string {
  return effortNames[level] ?? capitalise(level)
}

const effortHints: Record<string, string> = {
  none: 'No extra thinking, the plain model',
  minimal: 'Barely thinks; the fastest answers',
  low: 'Quick answers with light thinking',
  medium: 'Balances speed and depth',
  high: 'Thinks harder on complex problems',
  xhigh: 'Deep thinking for hard, long tasks',
  max: 'Deepest thinking; slowest and costliest',
  ultra: 'Deepest thinking, with helper agents',
  thinking: 'Extended thinking turned on',
}

/** One line on what an effort level means for the answer; empty for a level it does not know. */
export function effortHint(level: string): string {
  return effortHints[level] ?? ''
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

/** How far away a reset is: minutes, hours and minutes within a day, days and hours beyond it. */
export function resetDistance(at: Date, now: Date = new Date()): string {
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`
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

/** The limit closest to running out, the first on a tie; the ring shows it. */
export function highestLimit(limits: AgentLimit[]): AgentLimit | null {
  return limits.reduce<AgentLimit | null>((highest, limit) => (highest === null || limit.usedPercent > highest.usedPercent ? limit : highest), null)
}

/** A reading as a limit, or null when it has no share. */
function readingLimit(reading: UsageReading, now: Date): AgentLimit | null {
  if (reading.usedPercent === null) return null
  const resetsAt = parseResetsAt(reading.resetsAt)
  return { window: reading.window, usedPercent: reading.usedPercent, tone: usageLimitTone(reading.usedPercent), resets: resetsAt === null ? null : resetText(resetsAt, now), resetsAt }
}

export interface ProviderUsage {
  agent: string
  /** Every window with a share: 5-hour, weekly, then any other in the order the readings give them. */
  limits: AgentLimit[]
  /** The window closest to running out, which the summary shows. */
  highest: AgentLimit
  /** Unix seconds of the provider's newest reading, or null when none says. */
  fetchedAt: number | null
  /** Set when the CLI could not ask the provider and shows its last good readings: why, and when it tries again. */
  stale: { reason: string; retryAt: number | null } | null
}

const windowRank = (window: string) => {
  const rank = limitWindows.indexOf(window)
  return rank === -1 ? limitWindows.length : rank
}

/** Each provider with a share, in the order the readings first name them, for the sidebar's usage summary and its details. */
export function providerUsage(readings: UsageReading[], now: Date = new Date()): ProviderUsage[] {
  const agents = [...new Set(readings.map((reading) => reading.provider))]
  return agents.flatMap((agent) => {
    const own = readings.filter((reading) => reading.provider === agent)
    // A stable sort keeps the readings' own order among windows of the same rank.
    const limits = own
      .flatMap((reading) => {
        const limit = readingLimit(reading, now)
        return limit === null ? [] : [limit]
      })
      .sort((a, b) => windowRank(a.window) - windowRank(b.window))
    const highest = highestLimit(limits)
    if (highest === null) return []
    const times = own.flatMap((reading) => (reading.fetchedAt === null ? [] : [reading.fetchedAt]))
    const lapsed = own.find((reading) => reading.status === 'stale')
    const stale = lapsed === undefined ? null : { reason: lapsed.reason, retryAt: lapsed.retryAt ?? null }
    return [{ agent, limits, highest, fetchedAt: times.length === 0 ? null : Math.max(...times), stale }]
  })
}

/** How long ago a reading taken at these unix seconds is: just now under a minute, then minutes, hours, days. */
export function readingAge(fetchedAt: number | null, now: Date = new Date()): string | null {
  if (fetchedAt === null) return null
  const minutes = Math.floor((now.getTime() / 1000 - fetchedAt) / 60)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** What the usage details say of a provider whose readings are the last good ones: "rate limited, retrying in 4m". */
export function staleNote(stale: ProviderUsage['stale'], now: Date = new Date()): string | null {
  if (stale === null) return null
  const cause = /\b429\b/.test(stale.reason) ? 'rate limited' : 'unavailable'
  const seconds = stale.retryAt === null ? null : stale.retryAt - now.getTime() / 1000
  if (seconds === null || seconds <= 0) return `${cause}, retrying`
  return `${cause}, retrying in ${Math.ceil(seconds / 60)}m`
}
