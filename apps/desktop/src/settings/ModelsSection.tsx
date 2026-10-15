import { useState } from 'react'
import { Button, Card, ErrorNote, Spinner } from '@/components/ui'
import type { Settings } from '@/api/schema'

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

export function ModelsSection({
  models,
  terminal,
  error,
  onRefresh,
  onSetTerminal,
}: {
  models: Settings['models']
  terminal: Settings['terminal']
  error: unknown
  onRefresh: (agent: string) => Promise<void>
  onSetTerminal: (name: string | null) => void
}) {
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
    <div className="grid gap-4">
      {grouped.map((group) => (
        <Card
          key={group.agent}
          title={group.agent}
          aside={
            <Button variant="ghost" className="h-7 px-3 text-[12px]" disabled={refreshing === group.agent} onClick={() => void refresh(group.agent)}>
              {refreshing === group.agent ? <Spinner /> : 'Refresh'}
            </Button>
          }
        >
          <ul className="grid gap-1.5">
            {group.models.map((model) => (
              <li key={model.model} className="flex items-baseline justify-between text-[13px]">
                <span className="text-ink-100">{model.model}</span>
                <span className="text-ink-500">{model.reasoning.levels.join(', ')}</span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <Card title="Default terminal">
        <select
          value={terminal.default ?? ''}
          onChange={(event) => onSetTerminal(event.target.value === '' ? null : event.target.value)}
          className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1.5 text-[13px] text-ink-100"
        >
          <option value="">Automatic ({terminal.detected ?? 'none detected'})</option>
          {terminal.available.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Card>
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}
