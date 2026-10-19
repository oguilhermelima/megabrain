import { useState } from 'react'
import type { AdmissionPolicy, Settings } from '@/api/schema'
import { Button, ErrorNote, Segmented } from '@/components/ui'
import { policyFromForm, policyToForm, type PolicyForm } from '@/settings/settings-model'
import { field, quiet, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'

/** Whether the watcher runs, when a new agent may start, resource history, and the way back into setup. */
export function SupervisorSection({
  running,
  pid,
  policy,
  historyEnabled,
  error,
  onToggle,
  onSavePolicy,
  onPolicyOff,
  onToggleHistory,
  onSetup,
}: {
  running: boolean
  pid: number | null
  policy: Settings['resources']['policy']
  historyEnabled: boolean
  error: unknown
  onToggle: (running: boolean) => void
  onSavePolicy: (policy: AdmissionPolicy) => void
  onPolicyOff: () => void
  onToggleHistory: (enabled: boolean) => void
  onSetup: () => void
}) {
  const [form, setForm] = useState<PolicyForm>(() => policyToForm(policy))
  const [formError, setFormError] = useState<unknown>(null)

  const set = (field: keyof PolicyForm) => (value: string) => setForm((current) => ({ ...current, [field]: value }))

  const save = () => {
    try {
      onSavePolicy(policyFromForm(form))
      setFormError(null)
    } catch (caught) {
      setFormError(caught)
    }
  }

  const number = `${field} w-24 text-right tabular-nums`

  return (
    <>
      <SettingsGroup title="Watcher">
        <SettingRow
          label={
            <span className="flex items-center gap-2">
              <span className={`size-1.5 rounded-full ${running ? 'bg-ok' : 'bg-bad'}`} aria-hidden="true" />
              Watcher {running ? 'on' : 'off'}
              <span className="font-normal text-ink-400">{running ? `pid ${pid ?? '?'}` : 'stopped'}</span>
            </span>
          }
          description="Watches your dispatches and reports a stuck, finished or dead child back to you."
        >
          <Switch label="Watcher" checked={running} onChange={onToggle} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Admission">
        <SettingRow label="Max agents at once" description="New agents wait while this many are running. Empty: no limit." htmlFor="limit-agents">
          <input id="limit-agents" inputMode="numeric" placeholder="Any" value={form.maxAgents} onChange={(event) => set('maxAgents')(event.target.value)} className={number} />
        </SettingRow>
        <SettingRow label="Min free memory" description="In MiB. Agents wait while less is available." htmlFor="limit-memory">
          <input id="limit-memory" inputMode="numeric" placeholder="Any" value={form.minAvailableMib} onChange={(event) => set('minAvailableMib')(event.target.value)} className={number} />
        </SettingRow>
        <SettingRow label="Max memory pressure" description="The highest pressure at which a new agent may start.">
          <Segmented
            value={form.maxPressure}
            options={[
              { value: '', label: 'Any' },
              { value: 'normal', label: 'Normal' },
              { value: 'elevated', label: 'Elevated' },
            ]}
            onChange={(value) => set('maxPressure')(value)}
          />
        </SettingRow>
        <SettingRow label="Max container suites" description="Container test suites allowed to run at once." htmlFor="limit-suites">
          <input id="limit-suites" inputMode="numeric" placeholder="Any" value={form.maxContainerSuites} onChange={(event) => set('maxContainerSuites')(event.target.value)} className={number} />
        </SettingRow>
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <Button variant="ghost" className="h-8 px-4 text-[13px]" onClick={onPolicyOff}>
            Turn off
          </Button>
          <Button variant="primary" className="h-8 px-4 text-[13px]" onClick={save}>
            Save
          </Button>
        </div>
      </SettingsGroup>
      {formError !== null && <ErrorNote error={formError} />}
      <SettingsGroup title="Resource history">
        <SettingRow label="Resource history" description="Record machine load, memory and dispatch counts over time.">
          <Switch label="Resource history" checked={historyEnabled} onChange={onToggleHistory} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Setup">
        <SettingRow label="Run setup again" description="Install or update megabrain for your agents.">
          <button type="button" onClick={onSetup} className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}>
            Run setup
          </button>
        </SettingRow>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
