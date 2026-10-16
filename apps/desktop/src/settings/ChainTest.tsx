import { useState } from 'react'
import { api } from '@/api'
import type { ChainExplain, ChainExplainInput } from '@/api/schema'
import { ErrorNote, Spinner } from '@/components/ui'
import { stepText, type ModelInfo } from '@/settings/settings-model'
import { field, quiet, SettingsGroup } from '@/settings/settings-ui'

// Imagines a dispatch and asks the CLI (`chain explain`) which chain it would get and why, and which
// of that chain's steps would run or be skipped.

export function ChainTest({ models }: { models: ModelInfo[] }) {
  const [input, setInput] = useState<ChainExplainInput>({})
  const [result, setResult] = useState<ChainExplain | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [running, setRunning] = useState(false)
  const agents = [...new Set(models.map((model) => model.agent))]
  const agentModels = models.filter((model) => input.parentAgent === undefined || model.agent === input.parentAgent)
  const levels = models.find((model) => model.model === input.parentModel)?.reasoning.levels ?? []
  const set = (key: keyof ChainExplainInput, value: string) => {
    const { [key]: _old, ...rest } = input
    const next: ChainExplainInput = value === '' ? rest : { ...rest, [key]: value }
    // A model of another agent, or an effort the model lacks, goes with the change that ruled it out.
    if (key === 'parentAgent' && next.parentModel !== undefined && !models.some((model) => model.agent === value && model.model === next.parentModel)) delete next.parentModel
    if ((key === 'parentAgent' || key === 'parentModel') && next.parentEffort !== undefined && !(models.find((model) => model.model === next.parentModel)?.reasoning.levels.includes(next.parentEffort) ?? false)) delete next.parentEffort
    setInput(next)
  }
  const explain = async () => {
    setRunning(true)
    try {
      setResult(await api.chainExplain(input))
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setRunning(false)
    }
  }

  return (
    <SettingsGroup title="Test a dispatch">
      <form
        className="grid gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault()
          void explain()
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Parent agent" value={input.parentAgent ?? ''} onChange={(event) => set('parentAgent', event.target.value)} className={field}>
            <option value="">any parent agent</option>
            {agents.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
          <select aria-label="Parent model" value={input.parentModel ?? ''} onChange={(event) => set('parentModel', event.target.value)} className={`${field} max-w-52`}>
            <option value="">any model</option>
            {agentModels.map((model) => (
              <option key={model.model} value={model.model}>
                {model.name ?? model.model}
              </option>
            ))}
          </select>
          <select aria-label="Parent effort" value={input.parentEffort ?? ''} onChange={(event) => set('parentEffort', event.target.value)} className={field} disabled={levels.length === 0}>
            <option value="">any effort</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Repo" value={input.repo ?? ''} onChange={(event) => set('repo', event.target.value)} placeholder="Repo" className={`${field} flex-1`} />
          <input aria-label="Branch" value={input.branch ?? ''} onChange={(event) => set('branch', event.target.value)} placeholder="Branch" className={`${field} flex-1`} />
          <input aria-label="Label" value={input.label ?? ''} onChange={(event) => set('label', event.target.value)} placeholder="Label" className={`${field} flex-1`} />
          <button type="submit" disabled={running} className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}>
            {running ? <Spinner /> : 'Explain'}
          </button>
        </div>
        {error !== null && <ErrorNote error={error} />}
        {result !== null && <Explanation result={result} />}
      </form>
    </SettingsGroup>
  )
}

function Explanation({ result }: { result: ChainExplain }) {
  const chosen = result.candidates.find((candidate) => candidate.name === result.chosen)
  return (
    <div className="grid gap-3 border-t border-white/[0.06] pt-3" aria-live="polite">
      <p className="text-[13px] text-ink-100">
        {chosen === undefined ? (
          'No chain matches; the dispatch runs on the agent it names.'
        ) : (
          <>
            <span className="font-semibold">{chosen.name}</span> wins
            <span className="text-ink-400">
              {' '}
              (priority {chosen.priority}, specificity {chosen.specificity})
            </span>
          </>
        )}
      </p>
      <ul className="grid gap-1">
        {result.candidates.map((candidate) => (
          <li key={candidate.name} className="grid gap-0.5 rounded-[10px] bg-white/[0.03] px-3 py-2">
            <span className="flex items-center gap-2 text-[12.5px]">
              <span className={candidate.matched ? 'text-ok' : 'text-ink-500'}>{candidate.matched ? 'matches' : 'no match'}</span>
              <span className={`font-medium ${candidate.name === result.chosen ? 'text-ink-100' : 'text-ink-300'}`}>{candidate.name}</span>
              <span className="text-[11.5px] text-ink-500">
                priority {candidate.priority} · specificity {candidate.specificity}
              </span>
            </span>
            {candidate.reasons.length > 0 && <span className="text-[12px] text-ink-400">{candidate.reasons.join('; ')}</span>}
          </li>
        ))}
      </ul>
      {result.steps.length > 0 && (
        <ol className="grid gap-1">
          {result.steps.map((step) => (
            <li key={step.index} className={`flex items-baseline gap-2 text-[12.5px] ${step.skipped ? 'text-ink-500' : 'text-ink-200'}`}>
              <span className="w-4 shrink-0 tabular-nums">{step.index + 1}</span>
              <span className={step.skipped ? 'line-through' : ''}>{stepText(step.step)}</span>
              <span className="text-[11.5px]">{step.skipped ? 'skipped' : 'runs'}</span>
              {step.reason !== null && step.reason !== undefined && step.reason !== '' && <span className="text-[11.5px] text-ink-500">— {step.reason}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
