import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api'
import type { InstallPlan } from '@/api/schema'
import { AgentIcon } from '@/components/agent-icons'
import { Bone } from '@/components/Skeleton'
import { ErrorNote, Segmented, Spinner } from '@/components/ui'
import { AgentUpdatesGroup, type AgentUpdates } from '@/settings/AgentUpdates'
import { agentNames, agentRows, builtInCommands, defaultAgentSettings, parseAgentSettings, serialiseAgentSettings, startCommandError, withCommand, withDefault, withEnabled, withMode, type AgentRow, type AgentSettings } from '@/settings/agents-model'
import { quiet, SettingsGroup, Switch } from '@/settings/settings-ui'

type Plan = InstallPlan['agents']

/** The install report, the saved choice, and each installed agent's launch command, read together; Refresh reads them again. */
function useAgents(generation: number) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [commands, setCommands] = useState<Record<string, string[] | null | undefined>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let stopped = false
    setLoading(true)
    setCommands({})
    Promise.all([api.installPlan(), api.agentSettings()]).then(
      ([report, saved]) => {
        if (stopped) return
        setPlan(report.agents)
        setSettings(parseAgentSettings(saved))
        setError(null)
        setLoading(false)
        for (const entry of report.agents) {
          if (!entry.installed) continue
          api.agentCommand(entry.agent).then(
            (argv) => !stopped && setCommands((current) => ({ ...current, [entry.agent]: argv })),
            () => !stopped && setCommands((current) => ({ ...current, [entry.agent]: null })),
          )
        }
      },
      (caught: unknown) => {
        if (stopped) return
        setError(caught)
        setLoading(false)
      },
    )
    return () => {
      stopped = true
    }
  }, [generation])
  return { plan, settings, setSettings, commands, loading, error }
}

const pill = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40'

function DefaultPicker({ rows, value, onChange }: { rows: AgentRow[]; value: string | null; onChange: (agent: string | null) => void }) {
  const options: { agent: string | null; label: string; usable: boolean }[] = [{ agent: null, label: 'Auto', usable: true }, ...rows.map((row) => ({ agent: row.agent, label: agentNames[row.agent] ?? row.agent, usable: row.installed && row.enabled }))]
  return (
    <div role="radiogroup" aria-label="Default agent" className="flex flex-wrap gap-2 px-4 py-3.5">
      {options.map((option) => {
        const checked = option.agent === value
        return (
          <button
            key={option.agent ?? 'auto'}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={!option.usable && !checked}
            onClick={() => onChange(option.agent)}
            className={`${pill} ${checked ? 'border-accent/60 bg-accent/15 text-ink-100' : 'border-white/10 bg-white/[0.04] text-ink-300 hover:bg-white/[0.08] hover:text-ink-100'}`}
          >
            {option.agent === null ? (
              <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9M11.9 1.8v2.3H9.6M4.1 14.2v-2.3h2.3" />
              </svg>
            ) : (
              <AgentIcon agent={option.agent} size={14} />
            )}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function Subsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-t border-white/[0.06] px-4 py-3">
      <p className="mb-2 text-[11.5px] font-semibold tracking-wide text-ink-400 uppercase">{title}</p>
      {children}
    </div>
  )
}

function StartCommand({ row, onSave }: { row: AgentRow; onSave: (command: string | null) => Promise<boolean> }) {
  const builtIn = builtInCommands[row.agent] ?? row.agent
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const error = draft === null ? null : startCommandError(row.agent, draft)
  const finish = async (command: string | null) => {
    setSaving(true)
    const saved = await onSave(command)
    setSaving(false)
    if (saved) setDraft(null)
  }
  if (draft === null)
    return (
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all text-ink-300 select-text">
          {row.command === undefined ? <Bone width="w-[60%]" className="mt-1 h-2.5" /> : (row.command ?? <span className="font-sans text-ink-500">No launch command</span>)}
        </p>
        <button type="button" className={quiet} onClick={() => setDraft(row.custom ?? builtIn)} aria-label={`Edit the ${row.label} start command`}>
          Edit
        </button>
      </div>
    )
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={2}
        spellCheck={false}
        aria-label={`${row.label} start command`}
        aria-invalid={error !== null}
        className="w-full min-w-0 resize-y rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 font-mono text-[11.5px] break-all text-ink-100 focus-visible:border-accent/60 focus-visible:outline-none"
      />
      {error !== null && <p className="text-[12px] text-bad">{error}</p>}
      <p className="font-mono text-[11px] break-all text-ink-500">
        <span className="font-sans">Built-in: </span>
        {builtIn}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={quiet} disabled={saving || error !== null} onClick={() => void finish(draft)}>
          Save
        </button>
        <button type="button" className={quiet} disabled={saving} onClick={() => setDraft(null)}>
          Cancel
        </button>
        <button type="button" className={quiet} disabled={saving || row.custom === undefined} onClick={() => void finish(null)}>
          Reset to default
        </button>
      </div>
    </div>
  )
}

function AgentCard({ row, onEnabled, onDefault, onMode, onCommand }: { row: AgentRow; onEnabled: (enabled: boolean) => void; onDefault: () => void; onMode: (mode: AgentRow['mode']) => void; onCommand: (command: string | null) => Promise<boolean> }) {
  const [open, setOpen] = useState(false)
  const body = `agent-${row.agent}-settings`
  return (
    <div className="min-w-0">
      <div className="flex min-h-14 min-w-0 items-center gap-2 pr-4">
        <button type="button" aria-expanded={open} aria-controls={body} onClick={() => setOpen((value) => !value)} className="flex min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/25">
          <svg viewBox="0 0 16 16" className={`size-3.5 shrink-0 text-ink-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" />
          </svg>
          <span className={`grid size-8 shrink-0 place-items-center rounded-[10px] bg-white/[0.06] ${row.installed ? 'text-ink-100' : 'text-ink-500'}`}>
            <AgentIcon agent={row.agent} size={16} />
          </span>
          <span className="truncate text-[13.5px] font-medium text-ink-100" title={row.label}>
            {row.label}
          </span>
          {row.isDefault && <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">Default</span>}
          {!row.installed && <span className="shrink-0 rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-ink-400">Not installed</span>}
        </button>
        <Switch checked={row.enabled} onChange={onEnabled} label={`${row.label} enabled`} />
      </div>
      {open && (
        <div id={body} className="min-w-0 pb-1">
          <Subsection title="Default view">
            <div role="group" aria-label={`${row.label} opens new chats as`}>
              <Segmented
                value={row.mode}
                options={[
                  { value: 'chat', label: 'Chat' },
                  { value: 'terminal', label: 'Terminal' },
                ]}
                onChange={onMode}
              />
            </div>
          </Subsection>
          <Subsection title="Default agent">
            {row.isDefault ? (
              <p className="text-[12.5px] text-ink-300">New chat starts with {row.label}.</p>
            ) : row.installed && row.enabled ? (
              <button type="button" className={quiet} onClick={onDefault} aria-label={`Make ${row.label} the default`}>
                Set default
              </button>
            ) : (
              <p className="text-[12.5px] text-ink-500">{row.installed ? 'Enable it to make it the default.' : 'Install it to make it the default.'}</p>
            )}
          </Subsection>
          <Subsection title="Start command">
            {row.installed ? <StartCommand row={row} onSave={onCommand} /> : <p className="text-[12.5px] text-ink-500">Install it to start it from the app.</p>}
            <p className="mt-2 text-[11.5px] text-ink-500">Used by the agent’s terminal and terminal chats. Lanes started by orchestrate keep megabrain’s own command.</p>
          </Subsection>
        </div>
      )}
    </div>
  )
}

/** `updates` is read by the Settings window, which shows its badge on the Agents entry. */
export function AgentsSection({ updates }: { updates: AgentUpdates }) {
  const [generation, setGeneration] = useState(0)
  const { plan, settings, setSettings, commands, loading, error } = useAgents(generation)
  const [saveError, setSaveError] = useState<unknown>(null)

  const save = useCallback(
    async (next: AgentSettings): Promise<boolean> => {
      const previous = settings
      setSettings(next)
      try {
        await api.setAgentSettings(serialiseAgentSettings(next))
        setSaveError(null)
        return true
      } catch (caught) {
        setSettings(previous)
        setSaveError(caught)
        return false
      }
    },
    [settings, setSettings],
  )

  const current = settings ?? defaultAgentSettings
  const rows = agentRows(plan, current, commands)
  const detected = plan?.filter((entry) => entry.installed).length ?? null

  return (
    <>
      <SettingsGroup title="Default agent">
        <div>
          <p className="px-4 pt-3 text-[12.5px] text-ink-400">The agent New chat starts with. Auto starts the one you used last.</p>
          {settings === null && loading ? (
            <div className="flex gap-2 px-4 py-3.5">
              {[0, 1, 2, 3, 4].map((index) => (
                <Bone key={index} width="w-20" className="h-8" />
              ))}
            </div>
          ) : (
            <DefaultPicker rows={rows} value={current.default} onChange={(agent) => void save(withDefault(current, agent))} />
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Installed"
        aside={
          <div className="flex items-center gap-3">
            {detected !== null && <span className="text-[12px] text-ink-500 tabular-nums">{detected} detected</span>}
            <button type="button" className={quiet} disabled={loading} onClick={() => setGeneration((value) => value + 1)}>
              {loading ? (
                <Spinner />
              ) : (
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
                </svg>
              )}
              Refresh
            </button>
          </div>
        }
      >
        {rows.map((row) => (
          <AgentCard
            key={row.agent}
            row={row}
            onEnabled={(enabled) => void save(withEnabled(current, row.agent, enabled))}
            onDefault={() => void save(withDefault(current, row.agent))}
            onMode={(mode) => void save(withMode(current, row.agent, mode))}
            onCommand={async (command) => {
              const saved = await save(withCommand(current, row.agent, command))
              // The CLI builds the command shown, so read it again.
              if (saved) setGeneration((value) => value + 1)
              return saved
            }}
          />
        ))}
      </SettingsGroup>
      <p className="px-1 text-[12px] text-ink-500">A disabled agent stays installed; New chat just does not offer it. Default view is how a new chat with that agent opens; the switch in a chat’s header changes only that chat. The start command is what the app runs to start the agent’s own terminal.</p>
      <AgentUpdatesGroup updates={updates} />
      {error !== null && <ErrorNote error={error} />}
      {saveError !== null && <ErrorNote error={saveError} />}
    </>
  )
}
