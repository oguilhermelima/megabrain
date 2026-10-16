import { useState } from 'react'
import type { Settings } from '@/api/schema'
import { ErrorNote, Spinner } from '@/components/ui'
import { quiet, SettingsGroup } from '@/settings/settings-ui'

function groupModelsByAgent(models: Settings['models']): { agent: string; models: Settings['models'] }[] {
  const order: string[] = []
  const byAgent = new Map<string, Settings['models']>()
  for (const model of models) {
    const existing = byAgent.get(model.agent)
    if (existing === undefined) {
      byAgent.set(model.agent, [model])
      order.push(model.agent)
    } else existing.push(model)
  }
  return order.map((agent) => ({ agent, models: byAgent.get(agent) ?? [] }))
}

export function ModelsSection({ models, error, onRefresh }: { models: Settings['models']; error: unknown; onRefresh: (agent: string) => Promise<void> }) {
  const [refreshing, setRefreshing] = useState<string | null>(null)
  const grouped = groupModelsByAgent(models)

  const refresh = async (agent: string) => {
    setRefreshing(agent)
    try {
      await onRefresh(agent)
    } finally {
      setRefreshing(null)
    }
  }

  return (
    <>
      {grouped.length === 0 && <p className="px-1 text-[13px] text-ink-400">No models registered yet.</p>}
      {grouped.map((group) => (
        <SettingsGroup
          key={group.agent}
          title={group.agent}
          aside={
            <button type="button" className={quiet} disabled={refreshing === group.agent} onClick={() => void refresh(group.agent)}>
              {refreshing === group.agent ? <Spinner /> : (
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13 8a5 5 0 1 1-1.5-3.6" />
                  <path d="M13 2.5v3h-3" />
                </svg>
              )}
              Refresh
            </button>
          }
        >
          {group.models.map((model) => (
            <div key={model.model} className="flex min-h-11 items-center justify-between gap-4 px-4 py-2.5">
              <span className="min-w-0 truncate font-mono text-[12.5px] text-ink-100 select-text">{model.model}</span>
              <span className="flex shrink-0 flex-wrap justify-end gap-1">
                {model.reasoning.levels.map((level) => (
                  <span key={level} className="rounded-full bg-white/[0.05] px-2 py-0.5 text-[11.5px] text-ink-300">
                    {level}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </SettingsGroup>
      ))}
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
