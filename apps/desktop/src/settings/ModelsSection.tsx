import { useEffect, useId, useState } from 'react'
import { api } from '@/api'
import type { Settings } from '@/api/schema'
import { displayName, effortName, modelWindows } from '@/chat/composer-status'
import { AgentIcon } from '@/components/agent-icons'
import { ErrorNote, Spinner } from '@/components/ui'
import { appSettings } from '@/lib/app-settings'
import { agentNames } from '@/settings/agents-model'
import {
  defaultModelSettings,
  isEnabled,
  levelList,
  modelCards,
  parseModelSettings,
  serialiseModelSettings,
  windowList,
  withAgentDefault,
  withModelEnabled,
  type ModelCard,
  type ModelSettings,
} from '@/settings/models-model'
import { field, quiet, SettingsGroup, Switch } from '@/settings/settings-ui'

type Models = Settings['models']
type Model = Models[number]

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M13 8a5 5 0 1 1-1.5-3.6" />
      <path d="M13 2.5v3h-3" />
    </svg>
  )
}

/** One model: its name and id, what it is best for, its windows and levels, and whether the picker offers it. */
function ModelRow({ model, agent, onToggle }: { model: Model; agent: string; onToggle: (enabled: boolean) => void }) {
  const name = displayName(model.model, [model])
  const windows = windowList(modelWindows(model, agent))
  const enabled = isEnabled(model)
  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={`text-[13.5px] font-medium ${enabled ? 'text-ink-100' : 'text-ink-300'}`}>{name}</span>
          <span className="truncate font-mono text-[11.5px] text-ink-400 select-text">{model.model}</span>
          {model.status === 'deprecated' && <span className="rounded-full bg-warn/[0.12] px-1.5 text-[11px] leading-[18px] font-medium text-warn">Retiring</span>}
        </p>
        {typeof model.description === 'string' && model.description !== '' && <p className="mt-0.5 text-[12.5px] text-ink-300">{model.description}</p>}
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-400">
          {windows !== null && <span>{windows} context</span>}
          <span>{levelList(model.reasoning.levels)}</span>
        </p>
      </div>
      <div className="pt-0.5">
        <Switch checked={enabled} onChange={onToggle} label={`Offer ${name}`} />
      </div>
    </div>
  )
}

/** Which model and effort the agent's new chats start on; the agent's own default when unset. */
function DefaultRow({ card, models, saved, onChange }: { card: ModelCard; models: Models; saved: ModelSettings['defaults'][string] | undefined; onChange: (model: string | null, effort: string | null) => void }) {
  const id = useId()
  const offered = models.filter((model) => model.agent === card.agent && (isEnabled(model) || model.model === saved?.model))
  const chosen = offered.find((model) => model.model === saved?.model)
  const levels = chosen?.reasoning.levels ?? []
  const defaultLevel = chosen?.reasoning.default
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={`${id}-model`} className="block text-[13.5px] font-medium text-ink-100">
          New chats start on
        </label>
        <p className="mt-0.5 text-[12.5px] text-ink-400">{chosen === undefined ? `${agentNames[card.agent] ?? card.agent}'s own default, from its config.` : 'Until you pick another in the composer.'}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <select id={`${id}-model`} value={chosen?.model ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value, null)} className={`${field} max-w-48`}>
          <option value="">Agent default</option>
          {offered.map((model) => (
            <option key={model.model} value={model.model}>
              {displayName(model.model, [model])}
            </option>
          ))}
        </select>
        {chosen !== undefined && levels.length > 0 && (
          <select aria-label="Default effort" value={saved?.effort ?? ''} onChange={(event) => onChange(chosen.model, event.target.value === '' ? null : event.target.value)} className={`${field} max-w-40`}>
            <option value="">{defaultLevel === null || defaultLevel === undefined ? 'Model default' : `Model default (${effortName(defaultLevel)})`}</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {effortName(level)}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  )
}

function Subheading({ children }: { children: string }) {
  return <p className="bg-white/[0.02] px-4 py-1.5 text-[11.5px] font-semibold tracking-[0.06em] text-ink-400 uppercase">{children}</p>
}

/**
 * Settings > Models: one card per agent with its mark, how many models are on and a Refresh, the
 * model and effort its new chats start on, then its current models and, folded, the older ones;
 * each row says what the model is best for and turns it on or off for the composer's picker.
 */
export function ModelsSection({ models, error, onSaved, onRefresh }: { models: Models; error: unknown; onSaved: (run: () => Promise<void>) => Promise<boolean>; onRefresh: (agent: string) => Promise<void> }) {
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [openOlder, setOpenOlder] = useState<ReadonlySet<string>>(new Set())
  const [settings, setSettings] = useState<ModelSettings>(defaultModelSettings)
  useEffect(() => {
    let stopped = false
    api.modelSettings().then(
      (saved) => !stopped && setSettings(parseModelSettings(saved)),
      () => {},
    )
    return () => {
      stopped = true
    }
  }, [])

  const save = async (next: ModelSettings) => {
    const before = settings
    setSettings(next)
    if (!(await onSaved(() => api.setModelSettings(serialiseModelSettings(next))))) setSettings(before)
    // The composer's picker reads the same settings; it shows the change at once rather than in a minute.
    appSettings().reload()
  }
  const refresh = async (agent: string) => {
    setRefreshing(agent)
    try {
      await onRefresh(agent)
      appSettings().reload()
    } finally {
      setRefreshing(null)
    }
  }
  const toggleOlder = (agent: string) =>
    setOpenOlder((open) => {
      const next = new Set(open)
      if (next.has(agent)) next.delete(agent)
      else next.add(agent)
      return next
    })

  const cards = modelCards(models, query)
  const searching = query.trim() !== ''
  const enabled = models.filter(isEnabled).length

  return (
    <>
      <div className="flex items-center gap-3">
        <input type="search" aria-label="Search models" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name, id or use" className={`${field} flex-1`} />
        <p className="shrink-0 text-[12.5px] text-ink-400 tabular-nums">
          {enabled} of {models.length} on
        </p>
      </div>
      {models.length === 0 && <p className="px-1 text-[13px] text-ink-400">No models registered yet.</p>}
      {models.length > 0 && cards.length === 0 && <p className="px-1 text-[13px] text-ink-400">No model matches “{query.trim()}”.</p>}
      {cards.map((card) => {
        const name = agentNames[card.agent] ?? card.agent
        const olderShown = searching || openOlder.has(card.agent)
        const row = (model: Model) => <ModelRow key={model.model} model={model} agent={card.agent} onToggle={(on) => void save(withModelEnabled(settings, card.agent, model.model, on))} />
        return (
          <SettingsGroup
            key={card.agent}
            title={
              <span className="flex items-center gap-2 text-[13px] font-semibold tracking-normal text-ink-100 normal-case">
                <AgentIcon agent={card.agent} size={16} />
                {name}
                <span className="font-normal text-ink-400 tabular-nums">
                  {card.counts.enabled} of {card.counts.total} on
                </span>
              </span>
            }
            aside={
              <button type="button" className={quiet} disabled={refreshing === card.agent} onClick={() => void refresh(card.agent)} title={`Read the models ${name} offers now`}>
                {refreshing === card.agent ? <Spinner /> : <RefreshIcon />}
                Refresh
              </button>
            }
          >
            {!searching && <DefaultRow card={card} models={models} saved={settings.defaults[card.agent]} onChange={(model, effort) => void save(withAgentDefault(settings, card.agent, model, effort))} />}
            {card.current.length > 0 && (
              <div className="divide-y divide-white/[0.06]">
                <Subheading>Current</Subheading>
                {card.current.map(row)}
              </div>
            )}
            {card.older.length > 0 && (
              <div className="divide-y divide-white/[0.06]">
                <button
                  type="button"
                  aria-expanded={olderShown}
                  disabled={searching}
                  onClick={() => toggleOlder(card.agent)}
                  className="flex w-full items-center gap-1.5 bg-white/[0.02] px-4 py-1.5 text-left text-[11.5px] font-semibold tracking-[0.06em] text-ink-400 uppercase transition-colors duration-100 hover:text-ink-200 focus-visible:text-ink-200 focus-visible:outline-none disabled:cursor-default motion-reduce:transition-none"
                >
                  <svg viewBox="0 0 16 16" className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${olderShown ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                  {`Older (${card.older.length})`}
                </button>
                {olderShown && card.older.map(row)}
              </div>
            )}
          </SettingsGroup>
        )
      })}
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
