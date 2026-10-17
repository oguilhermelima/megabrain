import { useCallback, useEffect, useState } from 'react'
import { api } from '@/api'
import type { AgentUpdateEntry } from '@/api/schema'
import { AgentIcon } from '@/components/agent-icons'
import { Bone } from '@/components/Skeleton'
import { ErrorNote, Spinner } from '@/components/ui'
import { checkedLabel, defaultUpdatePolicy, kindLabels, parseUpdatePolicy, pendingBadge, serialiseUpdatePolicy, updateRows, withAgentAutoUpdate, withAutoUpdate, type UpdatePolicy, type UpdateRow, type UpdateState } from '@/settings/agent-updates-model'
import { quiet, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'

/**
 * The update report and the automatic-update policy, read once when Settings opens so the Agents
 * entry can show a badge before its page is visited. Check now reads the report again; Update now
 * runs an agent's installer and reads the report after it.
 */
export function useAgentUpdates() {
  const [report, setReport] = useState<AgentUpdateEntry[] | null>(null)
  const [policy, setPolicy] = useState<UpdatePolicy | null>(null)
  const [checking, setChecking] = useState(true)
  const [updating, setUpdating] = useState<ReadonlySet<string>>(new Set())
  const [failures, setFailures] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>(null)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setReport((await api.agentUpdates()).agents)
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
    api.agentUpdateSettings().then(
      (saved) => setPolicy(parseUpdatePolicy(saved)),
      (caught: unknown) => {
        setPolicy(defaultUpdatePolicy)
        setError(caught)
      },
    )
  }, [check])

  const savePolicy = useCallback(
    async (next: UpdatePolicy) => {
      const previous = policy
      setPolicy(next)
      try {
        await api.setAgentUpdateSettings(serialiseUpdatePolicy(next))
        setError(null)
      } catch (caught) {
        setPolicy(previous)
        setError(caught)
      }
    },
    [policy],
  )

  const update = useCallback(
    async (agent: string) => {
      setUpdating((current) => new Set([...current, agent]))
      setFailures(({ [agent]: _cleared, ...rest }) => rest)
      try {
        await api.agentUpdate(agent)
        await check()
      } catch (caught) {
        setFailures((current) => ({ ...current, [agent]: caught instanceof Error ? caught.message : String(caught) }))
      } finally {
        setUpdating((current) => new Set([...current].filter((item) => item !== agent)))
      }
    },
    [check],
  )

  const rows = updateRows(report, policy ?? defaultUpdatePolicy, updating, failures)
  return { rows, policy: policy ?? defaultUpdatePolicy, loaded: report !== null, checking, error, check, savePolicy, update, badge: report === null ? 0 : pendingBadge(rows) }
}

export type AgentUpdates = ReturnType<typeof useAgentUpdates>

const stateLabels: Record<UpdateState, string> = { 'up-to-date': 'Up to date', available: 'Update available', updating: 'Updating…', failed: 'Failed', unknown: 'Latest unknown', 'not-installed': 'Not installed' }

const stateTones: Record<UpdateState, string> = {
  'up-to-date': 'bg-ok/[0.12] text-ok',
  available: 'bg-accent/15 text-accent',
  updating: 'bg-white/[0.06] text-ink-300',
  failed: 'bg-bad/15 text-bad',
  unknown: 'bg-white/[0.06] text-ink-400',
  'not-installed': 'bg-white/[0.06] text-ink-400',
}

function UpdateLine({ row, now, onAuto, onUpdate }: { row: UpdateRow; now: number; onAuto: (enabled: boolean) => void; onUpdate: () => void }) {
  const versions = row.latest !== null && row.latest !== row.installed ? `${row.installed ?? '?'} → ${row.latest}` : (row.installed ?? '')
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-3">
      <span className={`grid size-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.06] ${row.state === 'not-installed' ? 'text-ink-500' : 'text-ink-100'}`}>
        <AgentIcon agent={row.agent} size={16} />
      </span>
      {/* Sized by the row, not its text: a long installer error truncates instead of widening the page. */}
      <div className="min-w-0 flex-1 [contain:inline-size]">
        <p className="flex items-center gap-2 text-[13.5px] font-medium text-ink-100">
          <span className="truncate">{row.label}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${stateTones[row.state]}`}>{stateLabels[row.state]}</span>
        </p>
        <p className="mt-1 min-h-4 truncate text-[11.5px] text-ink-400 select-text" title={row.error ?? undefined}>
          {row.state === 'not-installed' ? (
            <span className="text-ink-500">Install it to keep it updated from here.</span>
          ) : row.state === 'failed' ? (
            <span className="font-mono text-bad">{row.error}</span>
          ) : row.state === 'updating' ? (
            <span>Running the official installer…</span>
          ) : (
            <>
              <span className="font-mono">{versions}</span>
              <span className="text-ink-500">
                {' · '}
                {kindLabels[row.kind]} · {checkedLabel(row.checkedAt, now)}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {row.state === 'updating' ? (
          <button type="button" className={quiet} disabled>
            <Spinner />
            Updating…
          </button>
        ) : (
          row.canUpdate && (
            <button type="button" className={quiet} onClick={onUpdate} aria-label={`Update ${row.label} now`}>
              {row.state === 'failed' ? 'Try again' : 'Update now'}
            </button>
          )
        )}
        <span className="text-[12px] text-ink-500">Auto</span>
        <Switch checked={row.auto} disabled={row.state === 'not-installed'} onChange={onAuto} label={`Update ${row.label} automatically`} />
      </div>
    </div>
  )
}

export function AgentUpdatesGroup({ updates }: { updates: AgentUpdates }) {
  const { rows, policy, loaded, checking, error, check, savePolicy, update } = updates
  const now = Date.now()
  return (
    <>
      <SettingsGroup
        title="Updates"
        aside={
          <button type="button" className={quiet} disabled={checking} onClick={() => void check()}>
            {checking ? (
              <Spinner />
            ) : (
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
              </svg>
            )}
            Check now
          </button>
        }
      >
        <SettingRow label="Update agents automatically" description="megabrain checks at most every 6 h when it starts an agent, and updates it in the background without delaying it.">
          <Switch checked={policy.enabled} onChange={(enabled) => void savePolicy(withAutoUpdate(policy, enabled))} label="Update agents automatically" />
        </SettingRow>
        {loaded
          ? rows.map((row) => <UpdateLine key={row.agent} row={row} now={now} onAuto={(enabled) => void savePolicy(withAgentAutoUpdate(policy, row.agent, enabled))} onUpdate={() => void update(row.agent)} />)
          : rows.map((row) => (
              <div key={row.agent} className="flex min-h-16 items-center gap-3 px-4 py-3">
                <Bone width="w-8" className="h-8" />
                <div className="grid flex-1 gap-2">
                  <Bone width="w-24" className="h-3" />
                  <Bone width="w-[45%]" className="h-2.5" />
                </div>
              </div>
            ))}
      </SettingsGroup>
      <p className="px-1 text-[12px] text-ink-500">Update now runs the agent’s official installer, the same one it was installed with. An agent switch overrides the main one for that agent.</p>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
