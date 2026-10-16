import { useState } from 'react'
import type { AdmissionPolicy, Settings } from '@/api/schema'
import { Button, ErrorNote, Segmented } from '@/components/ui'
import { policyFromForm, policyToForm, type PolicyForm } from '@/settings/settings-model'
import { field, SettingRow, SettingsGroup, Switch } from '@/settings/settings-ui'

export function LimitsSection({
  policy,
  historyEnabled,
  error,
  onSave,
  onOff,
  onToggleHistory,
}: {
  policy: Settings['resources']['policy']
  historyEnabled: boolean
  error: unknown
  onSave: (policy: AdmissionPolicy) => void
  onOff: () => void
  onToggleHistory: (enabled: boolean) => void
}) {
  const [form, setForm] = useState<PolicyForm>(() => policyToForm(policy))
  const [formError, setFormError] = useState<unknown>(null)

  const set = (field: keyof PolicyForm) => (value: string) => setForm((current) => ({ ...current, [field]: value }))

  const save = () => {
    try {
      onSave(policyFromForm(form))
      setFormError(null)
    } catch (caught) {
      setFormError(caught)
    }
  }

  const number = `${field} w-24 text-right tabular-nums`

  return (
    <>
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
          <Button variant="ghost" className="h-8 px-4 text-[13px]" onClick={onOff}>
            Turn off
          </Button>
          <Button variant="primary" className="h-8 px-4 text-[13px]" onClick={save}>
            Save
          </Button>
        </div>
      </SettingsGroup>
      {formError !== null && <ErrorNote error={formError} />}
      <SettingsGroup title="History">
        <SettingRow label="Resource history" description="Record machine load, memory and dispatch counts over time.">
          <Switch label="Resource history" checked={historyEnabled} onChange={onToggleHistory} />
        </SettingRow>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
