import { useState, type ReactNode } from 'react'
import type { TimeCondition, UsageCondition } from '@/api/schema'
import { ContextMenu, type OpenMenu } from '@/components/ContextMenu'
import { MultiSelect } from '@/components/MultiSelect'
import {
  builderFromRule,
  effortsFor,
  emptyCondition,
  modelGroups,
  modelsForAgents,
  parseRuleJson,
  ruleFromBuilder,
  ruleSummary,
  validateRule,
  weekDays,
  type BuilderGroup,
  type ConditionDraft,
  type Join,
  type RuleBuilder as Builder,
  type RuleIssue,
} from '@/settings/chain-rules'
import type { ModelInfo } from '@/settings/settings-model'
import { field, ghostIcon, quiet } from '@/settings/settings-ui'

// The rule editor: groups joined by Any of / All of, each group a condition drawn as rows of dropdowns, or
// one more level of conditions; deeper rules are shown read-only and edited in the JSON view.

const joinOptions: { value: Join; label: string }[] = [
  { value: 'any', label: 'Any of' },
  { value: 'all', label: 'All of' },
]

const joinWord = (join: Join) => (join === 'any' ? 'or' : 'and')

/** Any of / All of as a small two-way toggle. */
function JoinToggle({ value, onChange, label }: { value: Join; onChange: (join: Join) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 gap-0.5 rounded-[9px] bg-white/[0.06] p-[3px]">
      {joinOptions.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={`h-6 rounded-[6px] px-2.5 text-[12.5px] transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/30 motion-reduce:transition-none ${option.value === value ? 'bg-white/[0.15] font-medium text-ink-100 shadow-[0_1px_3px_rgba(0,0,0,0.35)]' : 'text-ink-400 hover:text-ink-200'}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** "or" or "and" between two groups, on a rule across the column. */
function JoinDivider({ join }: { join: Join }) {
  return (
    <div aria-hidden="true" className="flex items-center gap-2 py-0.5">
      <span className="h-px flex-1 bg-white/[0.06]" />
      <span className="text-[11px] font-semibold tracking-[0.06em] text-ink-500 uppercase">{joinWord(join)}</span>
      <span className="h-px flex-1 bg-white/[0.06]" />
    </div>
  )
}

type ConditionKey = 'parent' | 'repo' | 'branch' | 'label' | 'usage' | 'time'
const conditionLabels: Record<ConditionKey, string> = { parent: 'Parent', repo: 'Repo', branch: 'Branch', label: 'Label', usage: 'Usage', time: 'Time' }

function usedKeys(draft: ConditionDraft): Set<ConditionKey> {
  const keys = new Set<ConditionKey>()
  if (draft.parentAgent.length + draft.parentModel.length + draft.parentEffort.length > 0) keys.add('parent')
  if (draft.repo.length > 0) keys.add('repo')
  if (draft.branch.length > 0) keys.add('branch')
  if (draft.label.length > 0) keys.add('label')
  if (draft.usage !== null) keys.add('usage')
  if (draft.time !== null) keys.add('time')
  return keys
}

function cleared(draft: ConditionDraft, key: ConditionKey): ConditionDraft {
  if (key === 'parent') return { ...draft, parentAgent: [], parentModel: [], parentEffort: [] }
  if (key === 'usage' || key === 'time') return { ...draft, [key]: null }
  return { ...draft, [key]: [] }
}

export function Cross() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  )
}

/** One field of a condition: its label in a fixed column, its controls, and a remove button. */
function Row({ label, onRemove, children }: { label: string; onRemove: () => void; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] items-start gap-3">
      <span className="pt-1.5 text-[13px] leading-5 font-medium text-ink-400">{label}</span>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      <button type="button" aria-label={`Remove ${label.toLowerCase()} condition`} title="Remove condition" className={`${ghostIcon} mt-0.5`} onClick={onRemove}>
        <Cross />
      </button>
    </div>
  )
}

/** A control in a condition row: the settings field at the app's value size. */
const control = `${field} text-[14px]`
const inlineLabel = 'flex items-center gap-1.5 text-[13px] text-ink-400'

function GlobInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (next: string[]) => void; placeholder: string; label: string }) {
  return <input aria-label={label} value={value.join(',')} onChange={(event) => onChange(event.target.value.split(','))} placeholder={placeholder} className={`${control} w-full max-w-[420px]`} />
}

function percentValue(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function UsageEditor({ usage, providers, onChange }: { usage: UsageCondition; providers: string[]; onChange: (next: UsageCondition) => void }) {
  const choices = providers.includes(usage.provider) ? providers : [usage.provider, ...providers]
  const bound = (key: 'below' | 'above', text: string) => {
    const { [key]: _old, ...rest } = usage
    const value = percentValue(text)
    onChange(value === undefined ? rest : { ...rest, [key]: value })
  }
  return (
    <>
      <select aria-label="Usage provider" value={usage.provider} onChange={(event) => onChange({ ...usage, provider: event.target.value })} className={`${control} w-28`}>
        {choices.map((provider) => (
          <option key={provider} value={provider}>
            {provider}
          </option>
        ))}
      </select>
      <select aria-label="Usage window" value={usage.window} onChange={(event) => onChange({ ...usage, window: event.target.value === 'weekly' ? 'weekly' : '5h' })} className={`${control} w-24`}>
        <option value="5h">5h</option>
        <option value="weekly">weekly</option>
      </select>
      <label className={inlineLabel}>
        below
        <input aria-label="Usage below percent" inputMode="numeric" value={usage.below?.toString() ?? ''} onChange={(event) => bound('below', event.target.value)} placeholder="—" className={`${control} w-14 text-center`} />%
      </label>
      <label className={inlineLabel}>
        above
        <input aria-label="Usage above percent" inputMode="numeric" value={usage.above?.toString() ?? ''} onChange={(event) => bound('above', event.target.value)} placeholder="—" className={`${control} w-14 text-center`} />%
      </label>
    </>
  )
}

function TimeEditor({ time, onChange }: { time: TimeCondition; onChange: (next: TimeCondition) => void }) {
  const set = (key: 'from' | 'to', value: string) => {
    const { [key]: _old, ...rest } = time
    onChange(value === '' ? rest : { ...rest, [key]: value })
  }
  const days = time.days ?? []
  return (
    <>
      <MultiSelect
        label="Days"
        groups={[{ options: weekDays.map((day) => ({ value: day, label: day.charAt(0).toUpperCase() + day.slice(1) })) }]}
        chosen={days}
        plural="days"
        any="Every day"
        className={`${control} w-36`}
        onChange={(chosen) => {
          const next = [...chosen].sort((left, right) => weekDays.indexOf(left as (typeof weekDays)[number]) - weekDays.indexOf(right as (typeof weekDays)[number]))
          const { days: _days, ...rest } = time
          onChange(next.length === 0 ? rest : { ...rest, days: next })
        }}
      />
      <label className={inlineLabel}>
        from
        <input aria-label="From time" type="time" value={time.from ?? ''} onChange={(event) => set('from', event.target.value)} className={control} />
      </label>
      <label className={inlineLabel}>
        to
        <input aria-label="To time" type="time" value={time.to ?? ''} onChange={(event) => set('to', event.target.value)} className={control} />
      </label>
    </>
  )
}

/** One condition: a row per constrained field, and an Add menu for the rest. */
export function ConditionEditor({ draft, models, providers, onChange }: { draft: ConditionDraft; models: ModelInfo[]; providers: string[]; onChange: (next: ConditionDraft) => void }) {
  const [opened, setOpened] = useState<Set<ConditionKey>>(new Set())
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const shown = new Set([...usedKeys(draft), ...opened])
  const hidden = (Object.keys(conditionLabels) as ConditionKey[]).filter((key) => !shown.has(key))
  const agents = [...new Set([...models.map((model) => model.agent), ...draft.parentAgent])]
  const efforts = effortsFor(models, draft.parentAgent, draft.parentModel)
  const remove = (key: ConditionKey) => {
    setOpened((current) => new Set([...current].filter((item) => item !== key)))
    onChange(cleared(draft, key))
  }
  const add = (key: ConditionKey) => {
    setOpened((current) => new Set([...current, key]))
    if (key === 'usage') onChange({ ...draft, usage: { provider: providers[0] ?? 'codex', window: '5h', below: 95 } })
    if (key === 'time') onChange({ ...draft, time: { days: ['mon', 'tue', 'wed', 'thu', 'fri'] } })
  }

  return (
    <div className="grid gap-2">
      {shown.size === 0 && <p className="py-1 text-[13px] text-ink-500">No condition: always matches.</p>}
      {shown.has('parent') && (
        <Row label="Parent" onRemove={() => remove('parent')}>
          <MultiSelect
            label="Agent"
            groups={[{ options: agents.map((agent) => ({ value: agent, label: agent })) }]}
            chosen={draft.parentAgent}
            plural="agents"
            any="Any agent"
            empty="No agents in the registry."
            className={`${control} w-36`}
            onChange={(parentAgent) => {
              // Models of agents no longer chosen go with them.
              const kept = parentAgent.length === 0 ? draft.parentModel : draft.parentModel.filter((model) => modelsForAgents(models, parentAgent).some((item) => item.model === model) || !models.some((item) => item.model === model))
              onChange({ ...draft, parentAgent, parentModel: kept })
            }}
          />
          <MultiSelect label="Model" groups={modelGroups(models, draft.parentAgent)} chosen={draft.parentModel} plural="models" any="Any model" empty="No models in the registry." className={`${control} w-56`} onChange={(parentModel) => onChange({ ...draft, parentModel })} />
          <MultiSelect
            label="Effort"
            groups={[{ options: efforts.map((effort) => ({ value: effort, label: effort })) }]}
            chosen={draft.parentEffort}
            plural="levels"
            any="Any effort"
            empty="The chosen models take no effort level."
            className={`${control} w-36`}
            onChange={(parentEffort) => onChange({ ...draft, parentEffort })}
          />
        </Row>
      )}
      {shown.has('repo') && (
        <Row label="Repo" onRemove={() => remove('repo')}>
          <GlobInput label="Repo glob" value={draft.repo} onChange={(repo) => onChange({ ...draft, repo })} placeholder="megabrain, ~/Workspaces/* (any of, comma separated)" />
        </Row>
      )}
      {shown.has('branch') && (
        <Row label="Branch" onRemove={() => remove('branch')}>
          <GlobInput label="Branch glob" value={draft.branch} onChange={(branch) => onChange({ ...draft, branch })} placeholder="feat/*, fix/*" />
        </Row>
      )}
      {shown.has('label') && (
        <Row label="Label" onRemove={() => remove('label')}>
          <GlobInput label="Label glob" value={draft.label} onChange={(label) => onChange({ ...draft, label })} placeholder="docs*, ui*" />
        </Row>
      )}
      {shown.has('usage') && draft.usage !== null && (
        <Row label="Usage" onRemove={() => remove('usage')}>
          <UsageEditor usage={draft.usage} providers={providers} onChange={(usage) => onChange({ ...draft, usage })} />
        </Row>
      )}
      {shown.has('time') && draft.time !== null && (
        <Row label="Time" onRemove={() => remove('time')}>
          <TimeEditor time={draft.time} onChange={(time) => onChange({ ...draft, time })} />
        </Row>
      )}
      {hidden.length > 0 && (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          className={`${quiet} -ml-2 justify-self-start text-[13px]`}
          onClick={(event) => {
            const { left, top, right, bottom } = event.currentTarget.getBoundingClientRect()
            setMenu({ anchor: { left, top, right, bottom }, gap: 4, sections: [hidden.map((key) => ({ label: conditionLabels[key], onSelect: () => add(key) }))] })
          }}
        >
          + Add field
        </button>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  )
}

function GroupCard({ title, onRemove, children }: { title: ReactNode; onRemove: () => void; children: ReactNode }) {
  return (
    <div className="grid gap-3 rounded-[12px] border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-ink-200">{title}</span>
        <button type="button" aria-label="Remove group" title="Remove group" className={`${ghostIcon} hover:text-bad`} onClick={onRemove}>
          <Cross />
        </button>
      </div>
      {children}
    </div>
  )
}

function GroupEditor({ group, index, models, providers, onChange, onRemove, onEditJson }: { group: BuilderGroup; index: number; models: ModelInfo[]; providers: string[]; onChange: (next: BuilderGroup) => void; onRemove: () => void; onEditJson: () => void }) {
  if (group.kind === 'condition')
    return (
      <GroupCard title={`Condition ${index + 1}`} onRemove={onRemove}>
        <ConditionEditor draft={group.condition} models={models} providers={providers} onChange={(condition) => onChange({ ...group, condition })} />
      </GroupCard>
    )
  if (group.kind === 'raw')
    return (
      <GroupCard title={`Group ${index + 1} (read-only)`} onRemove={onRemove}>
        <p className="text-[13px] text-ink-300">{ruleSummary(group.rule, models)}</p>
        <pre className="max-h-32 overflow-auto rounded-[8px] bg-black/20 p-2 font-mono text-[12px] text-ink-400">{JSON.stringify(group.rule, null, 2)}</pre>
        <p className="text-[13px] text-ink-500">
          Nested deeper than the builder shows.{' '}
          <button type="button" className="font-semibold text-ink-300 underline-offset-2 hover:underline" onClick={onEditJson}>
            Edit JSON
          </button>
        </p>
      </GroupCard>
    )
  return (
    <GroupCard
      title={
        <>
          Group {index + 1}
          <JoinToggle label="Group join" value={group.join} onChange={(join) => onChange({ ...group, join })} />
        </>
      }
      onRemove={onRemove}
    >
      {group.conditions.map((condition, position) => (
        <div key={position} className="grid gap-2">
          {position > 0 && <JoinDivider join={group.join} />}
          <div className="flex items-start gap-2 rounded-[10px] bg-white/[0.03] p-3">
            <div className="min-w-0 flex-1">
              <ConditionEditor draft={condition} models={models} providers={providers} onChange={(next) => onChange({ ...group, conditions: group.conditions.map((item, at) => (at === position ? next : item)) })} />
            </div>
            <button type="button" aria-label="Remove condition" title="Remove condition" className={ghostIcon} onClick={() => onChange({ ...group, conditions: group.conditions.filter((_, at) => at !== position) })}>
              <Cross />
            </button>
          </div>
        </div>
      ))}
      <button type="button" className={`${quiet} -ml-2 justify-self-start text-[13px]`} onClick={() => onChange({ ...group, conditions: [...group.conditions, emptyCondition()] })}>
        + Add condition to this group
      </button>
    </GroupCard>
  )
}

/** The builder or the JSON view of one rule; `issues` are the CLI's own, shown under both. */
export function RuleEditor({
  builder,
  models,
  providers,
  issues,
  onChange,
  compact = false,
}: {
  builder: Builder
  models: ModelInfo[]
  providers: string[]
  issues: RuleIssue[]
  onChange: (next: Builder) => void
  /** A step's rule: no JSON toggle header text, smaller spacing. */
  compact?: boolean
}) {
  const [json, setJson] = useState<string | null>(null)
  const [jsonIssues, setJsonIssues] = useState<RuleIssue[]>([])
  const openJson = () => {
    setJson(JSON.stringify(ruleFromBuilder(builder), null, 2))
    setJsonIssues([])
  }
  const editJson = (text: string) => {
    setJson(text)
    const parsed = parseRuleJson(text)
    if ('issues' in parsed) return setJsonIssues(parsed.issues)
    const local = validateRule(parsed.rule, models)
    setJsonIssues(local)
    if (local.length === 0) onChange(builderFromRule(parsed.rule))
  }
  const shownIssues = json === null ? issues : [...jsonIssues, ...issues.filter((issue) => !jsonIssues.some((local) => local.path === issue.path))]

  return (
    <div className={`grid ${compact ? 'gap-2' : 'gap-3'}`}>
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        {json === null ? (
          <div className="flex items-center gap-2">
            <JoinToggle label="Rule join" value={builder.join} onChange={(join) => onChange({ ...builder, join })} />
            {!compact && <span className="text-[13px] text-ink-500">the conditions below</span>}
          </div>
        ) : (
          <span className="text-[13px] text-ink-400">Rule as JSON; it applies as soon as it is valid.</span>
        )}
        <button type="button" className={`${quiet} text-[13px]`} aria-pressed={json !== null} onClick={() => (json === null ? openJson() : setJson(null))}>
          {json === null ? 'Edit JSON' : 'Back to builder'}
        </button>
      </div>
      {json === null ? (
        <>
          {builder.groups.length === 0 && <p className="text-[13px] text-ink-400">No conditions: the rule always matches.</p>}
          {builder.groups.map((group, index) => (
            <div key={index} className="grid gap-2">
              {index > 0 && <JoinDivider join={builder.join} />}
              <GroupEditor
                group={group}
                index={index}
                models={models}
                providers={providers}
                onChange={(next) => onChange({ ...builder, groups: builder.groups.map((item, at) => (at === index ? next : item)) })}
                onRemove={() => onChange({ ...builder, groups: builder.groups.filter((_, at) => at !== index) })}
                onEditJson={openJson}
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={`${quiet} border border-white/[0.1] bg-white/[0.04] text-[13px]`} onClick={() => onChange({ ...builder, groups: [...builder.groups, { kind: 'condition', condition: emptyCondition() }] })}>
              + Add condition
            </button>
            <button
              type="button"
              className={`${quiet} border border-white/[0.1] bg-white/[0.04] text-[13px]`}
              onClick={() => onChange({ ...builder, groups: [...builder.groups, { kind: 'nested', join: builder.join === 'any' ? 'all' : 'any', conditions: [emptyCondition(), emptyCondition()] }] })}
            >
              + Add group
            </button>
          </div>
        </>
      ) : (
        <textarea aria-label="Rule JSON" value={json} spellCheck={false} onChange={(event) => editJson(event.target.value)} rows={10} className={`${field} h-auto py-2 font-mono text-[12.5px] leading-5`} />
      )}
      {shownIssues.length > 0 && (
        <ul className="grid gap-1 text-[13px] text-bad">
          {shownIssues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <span className="font-mono">{issue.path}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
