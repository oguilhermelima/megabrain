import { useId, useState } from 'react'
import { api } from '@/api'
import { Checkbox } from '@/components/Checkbox'
import { Dialog } from '@/components/Dialog'
import { Button, ErrorNote } from '@/components/ui'
import { dispatchInputs, dispatchValues, type DispatchInput, type GithubActionWorkflow } from '@/github/actions-model'
import { usePresence } from '@/lib/usePresence'

// Run workflow for a workflow with a workflow_dispatch trigger: which workflow (when the page has no
// one picked), the branch or tag it runs on, and a form for its inputs from the workflow file, each
// starting from its default. `github workflow-dispatch` sends it; gh's message shows when it fails.

const field =
  'mt-1.5 h-9 w-full rounded-[12px] border border-white/[0.1] bg-ink-900 px-3 text-[13px] text-ink-100 outline-none placeholder:text-ink-500 focus:border-accent/60 aria-invalid:border-bad/60'

export interface RunWorkflowRequest {
  workflows: GithubActionWorkflow[]
  workflow: GithubActionWorkflow
  ref: string
  branches: string[]
}

export function RunWorkflowDialog({ root, request, onStarted, onClose }: { root: string; request: RunWorkflowRequest | null; onStarted: () => void; onClose: () => void }) {
  const { shown, leaving } = usePresence(request)
  if (shown === null) return null
  return <RunWorkflowCard root={root} request={shown} leaving={leaving} onStarted={onStarted} onClose={onClose} />
}

function InputField({ input, value, onChange, invalid }: { input: DispatchInput; value: string; onChange: (value: string) => void; invalid: boolean }) {
  const id = useId()
  const label = (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-ink-200">{input.name}</span>
      {input.required && <span className="text-[11.5px] text-ink-500">required</span>}
    </span>
  )
  const hint = input.description !== null && input.description !== '' && <span className="mt-0.5 block text-[12px] font-normal text-ink-500">{input.description}</span>
  if (input.type === 'boolean')
    return (
      <Checkbox checked={value === 'true'} onChange={(checked) => onChange(checked ? 'true' : 'false')}>
        <span className="text-[12.5px] font-medium text-ink-300">
          {label}
          {hint}
        </span>
      </Checkbox>
    )
  return (
    <label htmlFor={id} className="block text-[12.5px] font-medium text-ink-300">
      {label}
      {hint}
      {input.type === 'choice' ? (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)} style={{ colorScheme: 'dark' }} className={field}>
          {(input.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} value={value} inputMode={input.type === 'number' ? 'decimal' : undefined} onChange={(event) => onChange(event.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={invalid} className={field} />
      )}
    </label>
  )
}

function RunWorkflowCard({ root, request, leaving, onStarted, onClose }: { root: string; request: RunWorkflowRequest; leaving: boolean; onStarted: () => void; onClose: () => void }) {
  const [workflowId, setWorkflowId] = useState(request.workflow.id)
  const workflow = request.workflows.find((entry) => entry.id === workflowId) ?? request.workflow
  const [ref, setRef] = useState(request.ref)
  const [values, setValues] = useState(() => dispatchValues(workflow.inputs))
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const listId = useId()
  const refId = useId()
  const workflowFieldId = useId()
  const result = dispatchInputs(workflow.inputs, values)
  const refError = ref.trim() === '' ? 'Pick the branch or tag to run on.' : null
  const wrong = result.ok ? [] : 'missing' in result ? result.missing : result.invalid
  const problem = refError ?? (result.ok ? null : 'missing' in result ? `Fill in ${result.missing.join(', ')}.` : `${result.invalid.join(', ')} must be a number.`)

  const pick = (id: number) => {
    const next = request.workflows.find((entry) => entry.id === id)
    setWorkflowId(id)
    setValues(dispatchValues(next?.inputs ?? []))
    setTried(false)
  }
  const submit = () => {
    setTried(true)
    if (busy || !result.ok || refError !== null) return
    setBusy(true)
    setError(null)
    api.githubWorkflowDispatch(root, String(workflow.id), ref.trim(), result.inputs).then(
      () => {
        setBusy(false)
        onStarted()
      },
      (cause: unknown) => {
        setBusy(false)
        setError(cause)
      },
    )
  }

  return (
    <Dialog title={`Run ${workflow.name}`} busy={busy} leaving={leaving} onCancel={onClose} onSubmit={submit}>
      <div className="mt-4 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {request.workflows.length > 1 && (
          <label htmlFor={workflowFieldId} className="block text-[12.5px] font-medium text-ink-300">
            Workflow
            <select id={workflowFieldId} value={workflowId} onChange={(event) => pick(Number(event.target.value))} style={{ colorScheme: 'dark' }} className={field}>
              {request.workflows.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label htmlFor={refId} className="block text-[12.5px] font-medium text-ink-300">
          Use workflow from
          <input id={refId} data-autofocus list={listId} value={ref} onChange={(event) => setRef(event.target.value)} placeholder="main" spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-invalid={tried && refError !== null} className={`${field} font-mono`} />
          <datalist id={listId}>
            {request.branches.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        {workflow.inputs.map((input) => (
          <InputField key={`${workflow.id}-${input.name}`} input={input} value={values[input.name] ?? ''} invalid={tried && wrong.includes(input.name)} onChange={(value) => setValues((current) => ({ ...current, [input.name]: value }))} />
        ))}
        {workflow.inputs.length === 0 && <p className="text-[12.5px] text-ink-400">This workflow takes no inputs.</p>}
      </div>
      {tried && problem !== null && (
        <p role="alert" className="mt-3 text-[12px] text-bad">
          {problem}
        </p>
      )}
      {error !== null && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy ? 'Starting…' : 'Run workflow'}
        </Button>
      </div>
    </Dialog>
  )
}
