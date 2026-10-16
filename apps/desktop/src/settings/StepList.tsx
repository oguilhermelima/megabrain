import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { ChainStep } from '@/api/schema'
import { Button } from '@/components/ui'
import { builderFromRule, ruleFromBuilder, stepRuleSummary, stepWithAgent, stepWithModel } from '@/settings/chain-rules'
import { RuleEditor } from '@/settings/RuleBuilder'
import { stepText, type ModelInfo } from '@/settings/settings-model'
import { field, ghostIcon, quiet } from '@/settings/settings-ui'

// A chain's steps as an ordered list: click a step to edit it in place, drag its handle or press
// Alt+Up/Down to move it, remove it, add one at the end. The owner decides where a change goes: the
// chain editor keeps it until Save, the chain card sends it to the CLI at once.

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function StepForm({ step, models, providers, action, onSave, onCancel }: { step: ChainStep; models: ModelInfo[]; providers: string[]; action: string; onSave: (step: ChainStep) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(step)
  const [builder, setBuilder] = useState(() => (step.when === undefined ? null : builderFromRule(step.when)))
  const agents = [...new Set([...models.map((model) => model.agent), draft.agent])]
  const agentModels = models.filter((model) => model.agent === draft.agent)
  const modelChoices = draft.model === undefined || agentModels.some((model) => model.model === draft.model) ? agentModels.map((model) => model.model) : [draft.model, ...agentModels.map((model) => model.model)]
  const levels = models.find((model) => model.agent === draft.agent && model.model === draft.model)?.reasoning.levels ?? []
  const effortChoices = draft.effort === undefined || levels.includes(draft.effort) ? levels : [draft.effort, ...levels]

  const submit = () => {
    const { when: _when, ...rest } = draft
    onSave(builder === null ? rest : { ...rest, when: ruleFromBuilder(builder) })
  }

  return (
    <div className="grid gap-3 rounded-[12px] border border-white/[0.08] bg-white/[0.02] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Agent" value={draft.agent} onChange={(event) => setDraft(stepWithAgent(draft, event.target.value, models))} className={field}>
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
        <select aria-label="Model" value={draft.model ?? ''} onChange={(event) => event.target.value !== '' && setDraft(stepWithModel(draft, event.target.value, models))} className={`${field} max-w-56`}>
          {draft.model === undefined && <option value="">default model</option>}
          {modelChoices.map((model) => (
            <option key={model} value={model}>
              {models.find((item) => item.model === model)?.name ?? model}
            </option>
          ))}
        </select>
        {effortChoices.length > 0 && (
          <select aria-label="Effort" value={draft.effort ?? ''} onChange={(event) => setDraft({ ...draft, effort: event.target.value })} className={field}>
            {effortChoices.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-400">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft.until !== undefined}
            onChange={(event) => {
              const { until: _until, ...rest } = draft
              setDraft(event.target.checked ? { ...rest, until: { usedPercent: 95, window: '5h' } } : rest)
            }}
          />
          Until
        </label>
        {draft.until !== undefined && (
          <>
            <select aria-label="Until window" value={draft.until.window} onChange={(event) => draft.until !== undefined && setDraft({ ...draft, until: { ...draft.until, window: event.target.value } })} className={`${field} h-7`}>
              <option value="5h">5h</option>
              <option value="weekly">weekly</option>
            </select>
            at
            <input
              aria-label="Until percent"
              inputMode="numeric"
              value={draft.until.usedPercent}
              onChange={(event) => {
                const usedPercent = Number(event.target.value)
                if (draft.until !== undefined && Number.isFinite(usedPercent)) setDraft({ ...draft, until: { ...draft.until, usedPercent } })
              }}
              className={`${field} h-7 w-14`}
            />
            % used
          </>
        )}
      </div>
      <div className="grid gap-2">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-400">
          <input type="checkbox" checked={builder !== null} onChange={(event) => setBuilder(event.target.checked ? { join: 'all', groups: [] } : null)} />
          Only when a condition holds (skipped otherwise)
        </label>
        {builder !== null && <RuleEditor builder={builder} models={models} providers={providers} issues={[]} onChange={setBuilder} compact />}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-8 px-4 text-[13px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" className="h-8 px-4 text-[13px]" onClick={submit}>
          {action}
        </Button>
      </div>
    </div>
  )
}

/** Where a step dragged to `y` lands: the number of other rows whose middle is above it. */
function dropIndex(rows: Element[], from: number, y: number): number {
  return rows.filter((row, index) => {
    if (index === from) return false
    const rect = row.getBoundingClientRect()
    return (rect.top + rect.bottom) / 2 < y
  }).length
}

/** The release that ends a drag must not also open the step it lands on. */
function swallowNextClick() {
  const swallow = (event: globalThis.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

export function StepList({
  steps,
  models,
  providers,
  busy = false,
  onEdit,
  onMove,
  onRemove,
  onAdd,
}: {
  steps: ChainStep[]
  models: ModelInfo[]
  providers: string[]
  busy?: boolean
  onEdit: (index: number, step: ChainStep) => void
  onMove: (from: number, to: number) => void
  onRemove: (index: number) => void
  onAdd: (step: ChainStep) => void
}) {
  const [open, setOpen] = useState<number | 'new' | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const rows = () => [...(list.current?.querySelectorAll('[data-step-row]') ?? [])]

  const startDrag = (event: PointerEvent<HTMLElement>, from: number) => {
    if (event.button !== 0 || busy) return
    const startY = event.clientY
    let moving = false
    let to = from
    const stop = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', stop)
      setDrag(null)
    }
    const onPointerMove = (move: globalThis.PointerEvent) => {
      if (!moving && Math.abs(move.clientY - startY) < 4) return
      moving = true
      to = dropIndex(rows(), from, move.clientY)
      setDrag({ from, to })
    }
    const onPointerUp = () => {
      stop()
      if (!moving) return
      swallowNextClick()
      if (to !== from) onMove(from, to)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', stop)
  }

  const moveBy = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (busy || target < 0 || target >= steps.length) return
    onMove(index, target)
    // The row re-renders at its new place; keep the focus on it.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-step-row="${target}"] [data-step-open]`)?.focus())
  }
  const onKey = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    event.preventDefault()
    moveBy(index, event.key === 'ArrowUp' ? -1 : 1)
  }

  const first = models[0]
  const blank: ChainStep = first === undefined ? { agent: 'codex' } : stepWithAgent({ agent: first.agent }, first.agent, models)

  return (
    <div className="grid gap-2">
      {steps.length === 0 ? (
        <p className="text-[12.5px] text-ink-400">No steps yet. Add the first agent below.</p>
      ) : (
        <ol ref={list} className="grid gap-1">
          {steps.map((step, index) => (
            <li key={`${index}-${step.agent}-${step.model ?? ''}`} data-step-row={index} className="grid gap-1">
              {drag !== null && drag.to === index && drag.from > index && <span aria-hidden="true" className="h-0.5 rounded-full bg-accent" />}
              <div className={`flex items-center gap-1.5 rounded-[10px] bg-white/[0.04] py-1 pr-1 pl-1 ${drag?.from === index ? 'opacity-50' : ''}`}>
                <span onPointerDown={(event) => startDrag(event, index)} title="Drag to reorder" className="grid size-7 shrink-0 cursor-grab touch-none place-items-center text-ink-500 select-none hover:text-ink-300 active:cursor-grabbing">
                  <Glyph>
                    <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" strokeWidth="2.2" />
                  </Glyph>
                </span>
                <span className="w-4 shrink-0 text-[12px] text-ink-500 tabular-nums">{index + 1}</span>
                <button
                  type="button"
                  data-step-open
                  aria-expanded={open === index}
                  title="Edit this step (Alt+Up/Down moves it)"
                  onClick={() => setOpen(open === index ? null : index)}
                  onKeyDown={(event) => onKey(event, index)}
                  className="min-w-0 flex-1 truncate rounded-[6px] px-1 text-left text-[13px] text-ink-100 hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/25"
                >
                  {stepText(step)}
                  {step.when !== undefined && <span className="text-ink-500"> · {stepRuleSummary(step.when, models)}</span>}
                </button>
                <button type="button" aria-label="Move up" title="Move up" className={ghostIcon} disabled={busy || index === 0} onClick={() => moveBy(index, -1)}>
                  <Glyph>
                    <path d="m4 10 4-4 4 4" />
                  </Glyph>
                </button>
                <button type="button" aria-label="Move down" title="Move down" className={ghostIcon} disabled={busy || index === steps.length - 1} onClick={() => moveBy(index, 1)}>
                  <Glyph>
                    <path d="m4 6 4 4 4-4" />
                  </Glyph>
                </button>
                <button type="button" aria-label="Remove step" title="Remove step" className={`${ghostIcon} hover:text-bad`} disabled={busy} onClick={() => onRemove(index)}>
                  <Glyph>
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </Glyph>
                </button>
              </div>
              {drag !== null && drag.to === index && drag.from < index && <span aria-hidden="true" className="h-0.5 rounded-full bg-accent" />}
              {open === index && (
                <StepForm
                  step={step}
                  models={models}
                  providers={providers}
                  action="Save step"
                  onCancel={() => setOpen(null)}
                  onSave={(next) => {
                    setOpen(null)
                    onEdit(index, next)
                  }}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      {open === 'new' ? (
        <StepForm
          step={blank}
          models={models}
          providers={providers}
          action="Add step"
          onCancel={() => setOpen(null)}
          onSave={(next) => {
            setOpen(null)
            onAdd(next)
          }}
        />
      ) : (
        <button type="button" disabled={busy} className={`${quiet} justify-self-start border border-white/[0.1] bg-white/[0.04]`} onClick={() => setOpen('new')}>
          Add step
        </button>
      )}
    </div>
  )
}
