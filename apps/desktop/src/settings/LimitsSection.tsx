import { useState } from 'react'
import { Button, Card, Check, ErrorNote } from '@/components/ui'
import { policyFromForm, policyToForm, type PolicyForm } from '@/settings/settings-model'
import type { AdmissionPolicy, Settings } from '@/api/schema'

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

  return (
    <div className="grid gap-4">
      <Card title="Max chats">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-[12.5px] text-ink-400">
            Max agents at once
            <input value={form.maxAgents} onChange={(event) => set('maxAgents')(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1.5 text-ink-100" />
          </label>
          <label className="grid gap-1 text-[12.5px] text-ink-400">
            Min free memory (MiB)
            <input value={form.minAvailableMib} onChange={(event) => set('minAvailableMib')(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1.5 text-ink-100" />
          </label>
          <label className="grid gap-1 text-[12.5px] text-ink-400">
            Max memory pressure
            <select value={form.maxPressure} onChange={(event) => set('maxPressure')(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1.5 text-ink-100">
              <option value="">Any</option>
              <option value="normal">Normal</option>
              <option value="elevated">Elevated</option>
            </select>
          </label>
          <label className="grid gap-1 text-[12.5px] text-ink-400">
            Max container suites
            <input value={form.maxContainerSuites} onChange={(event) => set('maxContainerSuites')(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1.5 text-ink-100" />
          </label>
        </div>
        {formError !== null && <div className="mt-3"><ErrorNote error={formError} /></div>}
        {error !== null && <div className="mt-3"><ErrorNote error={error} /></div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onOff}>
            Turn off
          </Button>
          <Button variant="primary" onClick={save}>
            Save
          </Button>
        </div>
      </Card>
      <Card title="Resource history">
        <Check checked={historyEnabled} onChange={onToggleHistory}>
          <span className="text-[13px] text-ink-200">Record machine load, memory and dispatch counts over time.</span>
        </Check>
      </Card>
    </div>
  )
}
