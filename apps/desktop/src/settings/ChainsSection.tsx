import { useEffect, useState } from 'react'
import { api } from '@/api'
import type { Chain, ChainBody, ChainStep } from '@/api/schema'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button, ErrorNote, Spinner } from '@/components/ui'
import { builderFromRule, moveStepTo, ruleFromBuilder, ruleSummary, stepEdit, type RuleIssue } from '@/settings/chain-rules'
import { ChainTest } from '@/settings/ChainTest'
import { RuleEditor } from '@/settings/RuleBuilder'
import { withoutStep, withStep, type ModelInfo } from '@/settings/settings-model'
import { StepList } from '@/settings/StepList'
import { field, quiet, SettingsGroup } from '@/settings/settings-ui'

const sectionHeading = 'text-[12px] font-semibold tracking-[0.04em] text-ink-400 uppercase'

const priorityValue = (text: string): number | undefined => {
  const parsed = Number(text)
  return text.trim() === '' || !Number.isFinite(parsed) || parsed === 0 ? undefined : parsed
}

/** Checks the chain with the CLI (`chain save --dry-run`) 400 ms after the last change. */
function useChainValidation(name: string, body: ChainBody): { issues: RuleIssue[]; checking: boolean } {
  const [issues, setIssues] = useState<RuleIssue[]>([])
  const [checking, setChecking] = useState(false)
  const key = JSON.stringify(body)
  useEffect(() => {
    let cancelled = false
    setChecking(true)
    const timer = setTimeout(() => {
      api.validateChain(name, JSON.parse(key) as ChainBody).then(
        (result) => {
          if (cancelled) return
          setIssues(result.errors)
          setChecking(false)
        },
        (caught: unknown) => {
          if (cancelled) return
          setIssues([{ path: 'chain', message: caught instanceof Error ? caught.message : String(caught) }])
          setChecking(false)
        },
      )
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [name, key])
  return { issues, checking }
}

function ChainEditor({ chain, models, providers, onSave, onCancel }: { chain: Chain; models: ModelInfo[]; providers: string[]; onSave: (name: string, body: ChainBody) => Promise<void>; onCancel: () => void }) {
  const [builder, setBuilder] = useState(() => builderFromRule(chain.when))
  const [steps, setSteps] = useState(chain.steps)
  const [priority, setPriority] = useState(chain.priority?.toString() ?? '')
  const [saving, setSaving] = useState(false)
  const [saveIssues, setSaveIssues] = useState<RuleIssue[] | null>(null)
  const body: ChainBody = { when: ruleFromBuilder(builder), steps, ...(priorityValue(priority) === undefined ? {} : { priority: priorityValue(priority) }) }
  const { issues, checking } = useChainValidation(chain.name, body)
  const shown = saveIssues ?? issues
  const ruleIssues = shown.filter((issue) => issue.path === 'when' || issue.path.startsWith('when.') || issue.path.startsWith('when['))
  const otherIssues = shown.filter((issue) => !ruleIssues.includes(issue))

  const changeSteps = (next: ChainStep[]) => {
    setSaveIssues(null)
    setSteps(next)
  }

  const save = async () => {
    setSaving(true)
    try {
      // The CLI is the authority: a chain it refuses is not saved, and its reasons stay on screen.
      const checked = await api.validateChain(chain.name, body)
      if (!checked.ok) return setSaveIssues(checked.errors)
      await onSave(chain.name, body)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-5 px-4 py-4">
      <label className="flex flex-wrap items-center gap-3 text-[13px] font-medium text-ink-400">
        Priority
        <input aria-label="Priority" inputMode="numeric" value={priority} onChange={(event) => setPriority(event.target.value)} placeholder="0" className={`${field} w-20 text-[14px]`} />
        <span className="font-normal text-ink-500">When several chains match, the highest wins.</span>
      </label>
      <section className="grid gap-2">
        <h4 className={sectionHeading}>When</h4>
        <RuleEditor
          builder={builder}
          models={models}
          providers={providers}
          issues={ruleIssues}
          onChange={(next) => {
            setSaveIssues(null)
            setBuilder(next)
          }}
        />
      </section>
      <section className="grid gap-2">
        <h4 className={sectionHeading}>Steps</h4>
        <StepList
          steps={steps}
          models={models}
          providers={providers}
          onEdit={(index, step) => changeSteps(steps.map((item, at) => (at === index ? step : item)))}
          onMove={(from, to) => changeSteps(moveStepTo(steps, from, to))}
          onRemove={(index) => changeSteps(withoutStep(steps, index))}
          onAdd={(step) => changeSteps(withStep(steps, step))}
        />
      </section>
      {otherIssues.length > 0 && (
        <ul className="grid gap-1 text-[13px] text-bad">
          {otherIssues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <span className="font-mono">{issue.path}</span>: {issue.message}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-end gap-2">
        {checking && <span className="mr-auto text-[13px] text-ink-500">Checking…</span>}
        <Button variant="ghost" className="h-8 px-4 text-[13px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" className="h-8 px-4 text-[13px]" disabled={saving || shown.length > 0} onClick={() => void save()}>
          {saving ? <Spinner /> : 'Save'}
        </Button>
      </div>
    </div>
  )
}

/** A saved chain's steps, each change sent to the CLI at once: an edit or a move in place, anything else as the whole chain. */
function SavedSteps({ chain, models, providers, run }: { chain: Chain; models: ModelInfo[]; providers: string[]; run: (task: () => Promise<void>) => Promise<boolean> }) {
  const [busy, setBusy] = useState(false)
  const send = async (task: () => Promise<void>) => {
    setBusy(true)
    try {
      await run(task)
    } finally {
      setBusy(false)
    }
  }
  const saveSteps = (steps: ChainStep[]) => send(() => api.saveChain(chain.name, { when: chain.when, steps, ...(chain.priority === undefined ? {} : { priority: chain.priority }) }))
  return (
    <div className="px-4 pt-2 pb-3">
      <StepList
        steps={chain.steps}
        models={models}
        providers={providers}
        busy={busy}
        onEdit={(index, step) => {
          const before = chain.steps[index]
          if (before === undefined) return
          const edit = stepEdit(before, step)
          if (edit.kind === 'patch') void send(() => api.editStep(chain.name, index, edit.patch))
          else if (edit.kind === 'replace') void saveSteps(chain.steps.map((item, at) => (at === index ? step : item)))
        }}
        onMove={(from, to) => void send(() => api.moveStep(chain.name, from, to))}
        onRemove={(index) => void saveSteps(withoutStep(chain.steps, index))}
        onAdd={(step) => void saveSteps(withStep(chain.steps, step))}
        onRepair={(index, suggested) => void send(() => api.editStep(chain.name, index, { model: suggested.model, ...(suggested.effort === undefined ? {} : { effort: suggested.effort }) }))}
      />
    </div>
  )
}

export function ChainsSection({ chains, models, providers, error, run }: { chains: Chain[]; models: ModelInfo[]; providers: string[]; error: unknown; run: (task: () => Promise<void>) => Promise<boolean> }) {
  const [editing, setEditing] = useState<Chain | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creatingName, setCreatingName] = useState('')
  const [creatingPriority, setCreatingPriority] = useState('')
  const nameTaken = chains.some((chain) => chain.name === creatingName.trim())

  const save = async (name: string, body: ChainBody) => {
    // A refused save keeps the editor open with the person's changes; the error shows below.
    if (await run(() => api.saveChain(name, body))) setEditing(null)
  }
  const editor = (chain: Chain) => <ChainEditor key={chain.name} chain={chain} models={models} providers={providers} onSave={save} onCancel={() => setEditing(null)} />

  return (
    <>
      <ConfirmDialog
        confirm={
          confirmDelete === null
            ? null
            : {
                title: `Delete ${confirmDelete}?`,
                body: 'The chain is removed for good; a dispatch that names it no longer finds it.',
                action: 'Delete chain',
                run: async () => void (await run(() => api.deleteChain(confirmDelete))),
              }
        }
        onClose={() => setConfirmDelete(null)}
      />
      {chains.map((chain) => (
        <SettingsGroup
          key={chain.name}
          title={
            <span className="flex items-center gap-2">
              {chain.name}
              {chain.priority !== undefined && chain.priority !== 0 && <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] tracking-normal text-ink-300 normal-case">priority {chain.priority}</span>}
            </span>
          }
          aside={
            editing?.name === chain.name ? undefined : (
              <span className="flex gap-1">
                <button type="button" className={quiet} onClick={() => setEditing(chain)}>
                  Edit
                </button>
                <button type="button" className={`${quiet} hover:text-bad`} onClick={() => setConfirmDelete(chain.name)}>
                  Delete
                </button>
              </span>
            )
          }
        >
          <p className="px-4 pt-3 text-[12.5px] text-ink-400">{ruleSummary(chain.when, models)}</p>
          {editing?.name === chain.name ? editor(editing) : <SavedSteps chain={chain} models={models} providers={providers} run={run} />}
        </SettingsGroup>
      ))}
      {editing !== null && !chains.some((chain) => chain.name === editing.name) && <SettingsGroup title={editing.name}>{editor(editing)}</SettingsGroup>}
      <ChainTest models={models} />
      <SettingsGroup title="New chain">
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            const name = creatingName.trim()
            if (name === '' || nameTaken) return
            const priority = priorityValue(creatingPriority)
            setEditing({ name, when: {}, steps: [], ...(priority === undefined ? {} : { priority }) })
            setCreatingName('')
            setCreatingPriority('')
          }}
        >
          <input aria-label="Chain name" value={creatingName} onChange={(event) => setCreatingName(event.target.value)} placeholder="Name" className={`${field} flex-1`} />
          <input aria-label="New chain priority" inputMode="numeric" value={creatingPriority} onChange={(event) => setCreatingPriority(event.target.value)} placeholder="Priority (0)" className={`${field} w-28`} />
          <button type="submit" disabled={creatingName.trim() === '' || nameTaken} className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}>
            Create
          </button>
          {nameTaken && <span className="w-full text-[12px] text-bad">A chain named {creatingName.trim()} already exists.</span>}
        </form>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
