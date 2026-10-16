import type { ChainStep, Condition, Rule, RuleValues, StepPatch, TimeCondition, UsageCondition } from '@/api/schema'
import { displayName, groupModels } from '@/chat/composer-status'
import type { PickGroup, PickOption } from '@/components/multi-select-model'
import type { ModelInfo } from '@/settings/settings-model'

export type { Rule }

// A chain's rule as the Settings window reads, edits and checks it. The builder shows a rule as groups
// joined by Any of / All of, each group a condition, or one more level of conditions; anything deeper
// (or a not, or a field the app does not know) stays a read-only group edited as JSON, so every rule
// the CLI accepts opens and saves back unchanged.

export type Join = 'any' | 'all'

/** One condition as the builder edits it: every list empty means the field is not constrained. */
export interface ConditionDraft {
  parentAgent: string[]
  parentModel: string[]
  parentEffort: string[]
  repo: string[]
  branch: string[]
  label: string[]
  usage: UsageCondition | null
  time: TimeCondition | null
}

export type BuilderGroup = { kind: 'condition'; condition: ConditionDraft } | { kind: 'nested'; join: Join; conditions: ConditionDraft[] } | { kind: 'raw'; rule: Rule }

export interface RuleBuilder {
  join: Join
  groups: BuilderGroup[]
}

export type RuleIssue = { path: string; message: string }

export const listFields = ['parentAgent', 'parentModel', 'parentEffort', 'repo', 'branch', 'label'] as const
export type ListField = (typeof listFields)[number]
const conditionFields = new Set<string>([...listFields, 'usage', 'time'])
export const weekDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const values = (value: RuleValues | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value])
const isGroup = (rule: Rule): rule is { all: Rule[] } | { any: Rule[] } => 'all' in rule || 'any' in rule
const groupJoin = (rule: { all: Rule[] } | { any: Rule[] }): Join => ('any' in rule ? 'any' : 'all')
const groupItems = (rule: { all: Rule[] } | { any: Rule[] }): Rule[] => ('any' in rule ? rule.any : rule.all)

// ---- Summary -------------------------------------------------------------------------------------

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

function modelLabel(model: string, models: ModelInfo[]): string {
  const known = models.find((item) => item.model === model)
  if (known === undefined) return model
  const name = displayName(model, [known])
  // "Claude Opus 5.5", but "Grok 4.7" rather than "Grok Grok 4.7".
  return name.toLowerCase().startsWith(known.agent.toLowerCase()) ? name : `${capitalize(known.agent)} ${name}`
}

function usageText({ provider, window, below, above }: UsageCondition): string {
  const usage = `${provider} ${window} usage is`
  if (below !== undefined && above !== undefined) return `${usage} between ${above}% and ${below}%`
  if (below !== undefined) return `${usage} below ${below}%`
  if (above !== undefined) return `${usage} above ${above}%`
  return `${provider} ${window} usage is known`
}

function timeText({ days, from, to }: TimeCondition): string {
  const parts: string[] = []
  if (days !== undefined && days.length > 0) parts.push(`on ${days.map(capitalize).join(', ')}`)
  if (from !== undefined && to !== undefined) parts.push(`from ${from} to ${to}`)
  else if (from !== undefined) parts.push(`after ${from}`)
  else if (to !== undefined) parts.push(`before ${to}`)
  return parts.length === 0 ? 'at any time' : parts.join(' ')
}

const parentPrefix = 'the parent is '

function conditionPhrase(condition: Condition, models: ModelInfo[]): string {
  const agents = values(condition.parentAgent)
  const parentModels = values(condition.parentModel)
  const efforts = values(condition.parentEffort)
  const parts: string[] = []
  const who = parentModels.length > 0 ? parentModels.map((model) => modelLabel(model, models)).join(' or ') : agents.length > 0 ? agents.map(capitalize).join(' or ') : efforts.length > 0 ? 'any agent' : ''
  if (who !== '') parts.push(`${parentPrefix}${who}${efforts.length > 0 ? ` (${efforts.join(', ')})` : ''}`)
  const repo = values(condition.repo)
  if (repo.length > 0) parts.push(`on repo ${repo.join(' or ')}`)
  const branch = values(condition.branch)
  if (branch.length > 0) parts.push(`on branch ${branch.join(' or ')}`)
  const label = values(condition.label)
  if (label.length > 0) parts.push(`labelled ${label.join(' or ')}`)
  if (condition.usage !== undefined) parts.push(usageText(condition.usage))
  if (condition.time !== undefined) parts.push(timeText(condition.time))
  return parts.length === 0 ? 'always' : parts.join(', ')
}

function ruleText(rule: Rule, models: ModelInfo[]): string {
  if ('not' in rule) return `not (${ruleText(rule.not, models)})`
  if (!isGroup(rule)) return conditionPhrase(rule, models)
  const join = groupJoin(rule)
  const texts = groupItems(rule).map((item) => {
    const text = ruleText(item, models)
    // A group inside another reads in brackets once it has more than one member.
    return isGroup(item) && groupItems(item).length > 1 ? `(${text})` : text
  })
  if (texts.length === 0) return 'always'
  // "the parent is A or the parent is B" reads as "the parent is A or B" when each says nothing else.
  const parentOnly = (item: Rule) => editableCondition(item) && Object.keys(item).length > 0 && Object.keys(item).every((key) => key.startsWith('parent'))
  const elided = join === 'any' && groupItems(rule).every(parentOnly) ? texts.map((text, index) => (index === 0 ? text : text.slice(parentPrefix.length))) : texts
  return elided.join(join === 'any' ? ' or ' : ' and ')
}

function mentionsRepo(rule: Rule): boolean {
  if ('not' in rule) return mentionsRepo(rule.not)
  if (isGroup(rule)) return groupItems(rule).some(mentionsRepo)
  return values(rule.repo).length > 0
}

/** The rule in one plain line: "When the parent is Claude Opus 5.5 (low, medium, high) or Codex astra 6 (medium, high), on any repo". */
export function ruleSummary(rule: Rule, models: ModelInfo[]): string {
  const text = ruleText(rule, models)
  if (text === 'always') return 'Always'
  return `When ${text}${mentionsRepo(rule) ? '' : ', on any repo'}`
}

/** A step rule in one line, without the repo scope: "when codex 5h usage is below 90%". */
export function stepRuleSummary(rule: Rule, models: ModelInfo[]): string {
  const text = ruleText(rule, models)
  return text === 'always' ? 'always' : `when ${text}`
}

// ---- Builder ---------------------------------------------------------------------------------------

export function emptyCondition(): ConditionDraft {
  return { parentAgent: [], parentModel: [], parentEffort: [], repo: [], branch: [], label: [], usage: null, time: null }
}

/** A Condition the builder can edit: only the fields the app knows, each of the right shape. */
function editableCondition(rule: Rule): rule is Condition {
  if (!isRecord(rule) || 'not' in rule || isGroup(rule)) return false
  return Object.entries(rule).every(([key, value]) => {
    if ((listFields as readonly string[]).includes(key)) return typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    if (key === 'usage' || key === 'time') return isRecord(value)
    return false
  })
}

export function draftFromCondition(condition: Condition): ConditionDraft {
  return {
    parentAgent: values(condition.parentAgent),
    parentModel: values(condition.parentModel),
    parentEffort: values(condition.parentEffort),
    repo: values(condition.repo),
    branch: values(condition.branch),
    label: values(condition.label),
    usage: condition.usage ?? null,
    time: condition.time ?? null,
  }
}

/** Back to the stored shape: blank values drop out, one value is a string, several a list. */
export function conditionFromDraft(draft: ConditionDraft): Condition {
  const condition: Condition = {}
  for (const field of listFields) {
    const kept = draft[field].map((value) => value.trim()).filter((value) => value !== '')
    if (kept.length === 1) condition[field] = kept[0]
    else if (kept.length > 1) condition[field] = kept
  }
  if (draft.usage !== null) condition.usage = draft.usage
  if (draft.time !== null) condition.time = draft.time
  return condition
}

function groupFromRule(rule: Rule): BuilderGroup {
  if (editableCondition(rule)) return { kind: 'condition', condition: draftFromCondition(rule) }
  if (isGroup(rule)) {
    const items = groupItems(rule)
    if (items.every(editableCondition)) return { kind: 'nested', join: groupJoin(rule), conditions: items.map(draftFromCondition) }
  }
  return { kind: 'raw', rule }
}

export function builderFromRule(rule: Rule): RuleBuilder {
  if (isGroup(rule)) return { join: groupJoin(rule), groups: groupItems(rule).map(groupFromRule) }
  if (editableCondition(rule) && Object.keys(rule).length === 0) return { join: 'all', groups: [] }
  return { join: 'all', groups: [groupFromRule(rule)] }
}

function ruleFromGroup(group: BuilderGroup): Rule {
  if (group.kind === 'condition') return conditionFromDraft(group.condition)
  if (group.kind === 'raw') return group.rule
  const items = group.conditions.map(conditionFromDraft)
  return group.join === 'any' ? { any: items } : { all: items }
}

export function ruleFromBuilder(builder: RuleBuilder): Rule {
  if (builder.groups.length === 0) return {}
  const [only] = builder.groups
  if (builder.groups.length === 1 && builder.join === 'all' && only !== undefined) return ruleFromGroup(only)
  const items = builder.groups.map(ruleFromGroup)
  return builder.join === 'any' ? { any: items } : { all: items }
}

/** The registry's models for the chosen agents, or every model when no agent is chosen. */
export function modelsForAgents(models: ModelInfo[], agents: string[]): ModelInfo[] {
  return agents.length === 0 ? models : models.filter((model) => agents.includes(model.agent))
}

const modelOption = (model: ModelInfo): PickOption => ({ value: model.model, label: displayName(model.model, [model]), detail: model.model })

/**
 * The model dropdown: a group per agent (the chosen ones, else every one) in registry order, its
 * current models first and the older ones folded away, as the composer's model picker groups them.
 * A rule matches a model by id whatever the agent, so an id two agents list shows once, under the first.
 */
export function modelGroups(models: ModelInfo[], agents: string[]): PickGroup[] {
  const order = [...new Set(models.map((model) => model.agent))].filter((agent) => agents.length === 0 || agents.includes(agent))
  const listed = new Set<string>()
  const once = (model: ModelInfo) => {
    if (listed.has(model.model)) return false
    listed.add(model.model)
    return true
  }
  return order.flatMap((agent) => {
    const { current, older } = groupModels(models.filter((model) => model.agent === agent))
    const group = { label: agent, options: current.filter(once).map(modelOption), older: older.filter(once).map(modelOption) }
    return group.options.length + group.older.length === 0 ? [] : [group]
  })
}

/** The effort levels of the chosen models (or of the chosen agents' models), in registry order. */
export function effortsFor(models: ModelInfo[], agents: string[], chosenModels: string[]): string[] {
  const pool = modelsForAgents(models, agents).filter((model) => chosenModels.length === 0 || chosenModels.includes(model.model))
  return [...new Set(pool.flatMap((model) => model.reasoning.levels))]
}

// ---- Local validation ------------------------------------------------------------------------------

const clock = /^([01]\d|2[0-3]):[0-5]\d$/
const percent = (value: unknown) => typeof value === 'number' && value >= 0 && value <= 100

function validateCondition(rule: Record<string, unknown>, models: ModelInfo[], path: string): RuleIssue[] {
  const issues: RuleIssue[] = []
  for (const [key, value] of Object.entries(rule)) {
    const at = `${path}.${key}`
    if (!conditionFields.has(key)) issues.push({ path: at, message: 'unknown field' })
    else if (key === 'usage') {
      if (!isRecord(value)) issues.push({ path: at, message: 'expected {provider, window, below?, above?}' })
      else {
        if (typeof value.provider !== 'string' || value.provider === '') issues.push({ path: `${at}.provider`, message: 'expected a provider name' })
        if (value.window !== '5h' && value.window !== 'weekly') issues.push({ path: `${at}.window`, message: 'expected "5h" or "weekly"' })
        for (const bound of ['below', 'above'] as const) if (value[bound] !== undefined && !percent(value[bound])) issues.push({ path: `${at}.${bound}`, message: 'expected a percent from 0 to 100' })
      }
    } else if (key === 'time') {
      if (!isRecord(value)) issues.push({ path: at, message: 'expected {days?, from?, to?}' })
      else {
        if (value.days !== undefined) {
          const unknown = Array.isArray(value.days) ? value.days.find((day) => typeof day !== 'string' || !(weekDays as readonly string[]).includes(day)) : value.days
          if (unknown !== undefined) issues.push({ path: `${at}.days`, message: `unknown day ${JSON.stringify(unknown)}` })
        }
        for (const bound of ['from', 'to'] as const) if (value[bound] !== undefined && (typeof value[bound] !== 'string' || !clock.test(value[bound]))) issues.push({ path: `${at}.${bound}`, message: 'expected HH:MM' })
      }
    } else if (!(typeof value === 'string' || (Array.isArray(value) && value.every((item) => typeof item === 'string')))) {
      issues.push({ path: at, message: 'expected a string or a list of strings' })
    }
  }
  // An effort the chosen models do not offer, named the way the CLI names it.
  const parentModels = values(rule.parentModel as RuleValues | undefined)
  const efforts = values(rule.parentEffort as RuleValues | undefined)
  if (issues.length === 0) {
    for (const model of parentModels) {
      const levels = models.find((item) => item.model === model)?.reasoning.levels
      const unknown = levels === undefined ? undefined : efforts.find((effort) => !levels.includes(effort))
      if (unknown !== undefined) {
        issues.push({ path: `${path}.parentEffort`, message: `unknown effort "${unknown}" for ${model}` })
        break
      }
    }
  }
  return issues
}

/** The grammar checked locally, for instant feedback; `chain save --dry-run` stays the authority. */
export function validateRule(value: unknown, models: ModelInfo[], path = 'when'): RuleIssue[] {
  if (!isRecord(value)) return [{ path, message: 'expected a condition or all, any or not' }]
  const combinators = ['all', 'any', 'not'].filter((key) => key in value)
  if (combinators.length > 0 && Object.keys(value).length > 1) return [{ path, message: 'all, any and not stand alone in their object' }]
  const [combinator] = combinators
  if (combinator === 'not') return validateRule(value.not, models, `${path}.not`)
  if (combinator === 'all' || combinator === 'any') {
    const items = value[combinator]
    if (!Array.isArray(items)) return [{ path: `${path}.${combinator}`, message: 'expected a list of rules' }]
    return items.flatMap((item, index) => validateRule(item, models, `${path}.${combinator}[${index}]`))
  }
  return validateCondition(value, models, path)
}

export function parseRuleJson(text: string): { rule: Rule } | { issues: RuleIssue[] } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { issues: [{ path: 'when', message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] }
  }
  return isRecord(value) ? { rule: value as Rule } : { issues: [{ path: 'when', message: 'expected a condition or all, any or not' }] }
}

// ---- Steps -----------------------------------------------------------------------------------------

/** A step on another agent: its first model and that model's first effort. */
export function stepWithAgent(step: ChainStep, agent: string, models: ModelInfo[]): ChainStep {
  const first = models.find((item) => item.agent === agent)
  const { effort: _effort, ...rest } = step
  return withModel({ ...rest, agent }, first?.model, models)
}

/** A step on another model, keeping its effort when the model offers it. */
export function stepWithModel(step: ChainStep, model: string, models: ModelInfo[]): ChainStep {
  return withModel(step, model, models)
}

function withModel(step: ChainStep, model: string | undefined, models: ModelInfo[]): ChainStep {
  const { model: _model, effort, ...rest } = step
  const levels = models.find((item) => item.agent === step.agent && item.model === model)?.reasoning.levels ?? []
  const nextEffort = effort !== undefined && levels.includes(effort) ? effort : levels[0]
  return { ...rest, ...(model === undefined ? {} : { model }), ...(nextEffort === undefined ? {} : { effort: nextEffort }) }
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/**
 * What saving an edited step takes: nothing, a `chain step edit` patch, or the whole chain when the
 * change has no flag (clearing a model or an effort).
 */
export function stepEdit(before: ChainStep, after: ChainStep): { kind: 'none' } | { kind: 'patch'; patch: StepPatch } | { kind: 'replace' } {
  const patch: StepPatch = {}
  if (after.agent !== before.agent) patch.agent = after.agent
  if (after.model !== before.model) {
    if (after.model === undefined) return { kind: 'replace' }
    patch.model = after.model
  }
  if (after.effort !== before.effort) {
    if (after.effort === undefined) return { kind: 'replace' }
    patch.effort = after.effort
  }
  if (!same(after.until, before.until)) patch.until = after.until ?? null
  if (!same(after.when, before.when)) patch.when = after.when ?? null
  return Object.keys(patch).length === 0 ? { kind: 'none' } : { kind: 'patch', patch }
}

/** The step at `from` dropped at position `to`; out of range or in place is a no-op (same array). */
export function moveStepTo(steps: ChainStep[], from: number, to: number): ChainStep[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return steps
  const next = [...steps]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved as ChainStep)
  return next
}
