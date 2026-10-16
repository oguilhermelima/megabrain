import { useState, type ReactNode } from 'react'
import type { Chain, ChainStep } from '@/api/schema'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Button, ErrorNote } from '@/components/ui'
import { conditionText, emptyChain, moveStep, stepText, withoutStep, withStep, type ModelInfo } from '@/settings/settings-model'
import { field, ghostIcon, quiet, SettingsGroup } from '@/settings/settings-ui'

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function StepEditor({ models, onAdd }: { models: ModelInfo[]; onAdd: (step: ChainStep) => void }) {
  const agents = [...new Set(models.map((model) => model.agent))]
  const [agent, setAgent] = useState(agents[0] ?? '')
  const agentModels = models.filter((model) => model.agent === agent)
  const [model, setModel] = useState(agentModels[0]?.model ?? '')
  const levels = models.find((item) => item.agent === agent && item.model === model)?.reasoning.levels ?? []
  const [effort, setEffort] = useState(levels[0] ?? '')

  const changeAgent = (nextAgent: string) => {
    setAgent(nextAgent)
    const firstModel = models.find((item) => item.agent === nextAgent)
    setModel(firstModel?.model ?? '')
    setEffort(firstModel?.reasoning.levels[0] ?? '')
  }
  const changeModel = (nextModel: string) => {
    setModel(nextModel)
    setEffort(models.find((item) => item.agent === agent && item.model === nextModel)?.reasoning.levels[0] ?? '')
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Agent" value={agent} onChange={(event) => changeAgent(event.target.value)} className={field}>
        {agents.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <select aria-label="Model" value={model} onChange={(event) => changeModel(event.target.value)} className={`${field} max-w-56`}>
        {agentModels.map((item) => (
          <option key={item.model} value={item.model}>
            {item.model}
          </option>
        ))}
      </select>
      {levels.length > 0 && (
        <select aria-label="Effort" value={effort} onChange={(event) => setEffort(event.target.value)} className={field}>
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}
        onClick={() => {
          if (agent === '' || model === '') return
          onAdd({ agent, model, effort: effort === '' ? undefined : effort })
        }}
      >
        Add step
      </button>
    </div>
  )
}

function ChainEditor({ chain, models, onChange, onSave, onCancel }: { chain: Chain; models: ModelInfo[]; onChange: (chain: Chain) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="grid gap-3 px-4 py-3">
      {chain.steps.length === 0 ? (
        <p className="text-[12.5px] text-ink-400">No steps yet. Add the first agent below.</p>
      ) : (
        <ol className="grid gap-1">
          {chain.steps.map((step, index) => (
            <li key={`${step.agent}-${step.model}-${index}`} className="flex items-center gap-2 rounded-[10px] bg-white/[0.04] py-1 pr-1 pl-3">
              <span className="w-4 shrink-0 text-[12px] text-ink-500 tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-100">{stepText(step)}</span>
              <button type="button" aria-label="Move up" title="Move up" className={ghostIcon} disabled={index === 0} onClick={() => onChange({ ...chain, steps: moveStep(chain.steps, index, -1) })}>
                <Glyph>
                  <path d="m4 10 4-4 4 4" />
                </Glyph>
              </button>
              <button type="button" aria-label="Move down" title="Move down" className={ghostIcon} disabled={index === chain.steps.length - 1} onClick={() => onChange({ ...chain, steps: moveStep(chain.steps, index, 1) })}>
                <Glyph>
                  <path d="m4 6 4 4 4-4" />
                </Glyph>
              </button>
              <button type="button" aria-label="Remove" title="Remove" className={`${ghostIcon} hover:text-bad`} onClick={() => onChange({ ...chain, steps: withoutStep(chain.steps, index) })}>
                <Glyph>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </Glyph>
              </button>
            </li>
          ))}
        </ol>
      )}
      <StepEditor models={models} onAdd={(step) => onChange({ ...chain, steps: withStep(chain.steps, step) })} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="h-8 px-4 text-[13px]" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" className="h-8 px-4 text-[13px]" onClick={onSave}>
          Save
        </Button>
      </div>
    </div>
  )
}

export function ChainsSection({
  chains,
  models,
  error,
  onSave,
  onDelete,
}: {
  chains: Chain[]
  models: ModelInfo[]
  error: unknown
  onSave: (chain: Chain) => void
  onDelete: (name: string) => void
}) {
  const [editing, setEditing] = useState<Chain | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creatingName, setCreatingName] = useState('')
  const [creatingParent, setCreatingParent] = useState('')

  return (
    <>
      {confirmDelete !== null && (
        <ConfirmDialog
          confirm={{
            title: `Delete ${confirmDelete}?`,
            body: 'The chain is removed for good; a dispatch that names it no longer finds it.',
            action: 'Delete chain',
            run: async () => onDelete(confirmDelete),
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
      {chains.map((chain) => (
        <SettingsGroup
          key={chain.name}
          title={chain.name}
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
          <p className="px-4 pt-3 text-[12.5px] text-ink-400">{conditionText(chain.when)}</p>
          {editing?.name === chain.name ? (
            <ChainEditor
              chain={editing}
              models={models}
              onChange={setEditing}
              onSave={() => {
                onSave(editing)
                setEditing(null)
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <ol className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-3">
              {chain.steps.map((step, index) => (
                <li key={`${step.agent}-${index}`} className="flex items-center gap-1.5">
                  {index > 0 && (
                    <svg viewBox="0 0 16 16" className="size-3 text-ink-500" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m6 4 4 4-4 4" />
                    </svg>
                  )}
                  <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-[12px] text-ink-200">{stepText(step)}</span>
                </li>
              ))}
            </ol>
          )}
        </SettingsGroup>
      ))}
      {editing !== null && !chains.some((chain) => chain.name === editing.name) && (
        <SettingsGroup title={editing.name}>
          <p className="px-4 pt-3 text-[12.5px] text-ink-400">{conditionText(editing.when)}</p>
          <ChainEditor
            chain={editing}
            models={models}
            onChange={setEditing}
            onSave={() => {
              onSave(editing)
              setEditing(null)
            }}
            onCancel={() => setEditing(null)}
          />
        </SettingsGroup>
      )}
      <SettingsGroup title="New chain">
        <form
          className="flex flex-wrap items-center gap-2 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (creatingName.trim() === '') return
            setEditing(emptyChain(creatingName.trim(), creatingParent.trim()))
            setCreatingName('')
            setCreatingParent('')
          }}
        >
          <input aria-label="Chain name" value={creatingName} onChange={(event) => setCreatingName(event.target.value)} placeholder="Name" className={`${field} flex-1`} />
          <input aria-label="Parent agent" value={creatingParent} onChange={(event) => setCreatingParent(event.target.value)} placeholder="Parent agent (optional)" className={`${field} flex-1`} />
          <button type="submit" disabled={creatingName.trim() === ''} className={`${quiet} border border-white/[0.1] bg-white/[0.04]`}>
            Create
          </button>
        </form>
      </SettingsGroup>
      {error !== null && <ErrorNote error={error} />}
    </>
  )
}
