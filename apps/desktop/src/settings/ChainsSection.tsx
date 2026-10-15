import { useState } from 'react'
import type { Chain, ChainStep } from '@/api/schema'
import { Button, Card, ErrorNote } from '@/components/ui'
import { conditionText, emptyChain, moveStep, stepText, withoutStep, withStep, type ModelInfo } from '@/settings/settings-model'

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
      <select value={agent} onChange={(event) => changeAgent(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[13px] text-ink-100">
        {agents.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </select>
      <select value={model} onChange={(event) => changeModel(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[13px] text-ink-100">
        {agentModels.map((item) => (
          <option key={item.model} value={item.model}>
            {item.model}
          </option>
        ))}
      </select>
      {levels.length > 0 && (
        <select value={effort} onChange={(event) => setEffort(event.target.value)} className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[13px] text-ink-100">
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      )}
      <Button
        variant="secondary"
        onClick={() => {
          if (agent === '' || model === '') return
          onAdd({ agent, model, effort: effort === '' ? undefined : effort })
        }}
      >
        Add step
      </Button>
    </div>
  )
}

function ChainEditor({ chain, models, onChange, onSave, onCancel }: { chain: Chain; models: ModelInfo[]; onChange: (chain: Chain) => void; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="grid gap-3">
      <ol className="grid gap-2">
        {chain.steps.map((step, index) => (
          <li key={`${step.agent}-${step.model}-${index}`} className="flex items-center justify-between gap-2 rounded-xl bg-white/[0.05] px-3 py-2">
            <span className="text-[13px] text-ink-100">{stepText(step)}</span>
            <span className="flex gap-1">
              <Button variant="ghost" className="h-7 px-2" disabled={index === 0} onClick={() => onChange({ ...chain, steps: moveStep(chain.steps, index, -1) })}>
                ↑
              </Button>
              <Button variant="ghost" className="h-7 px-2" disabled={index === chain.steps.length - 1} onClick={() => onChange({ ...chain, steps: moveStep(chain.steps, index, 1) })}>
                ↓
              </Button>
              <Button variant="ghost" className="h-7 px-2" onClick={() => onChange({ ...chain, steps: withoutStep(chain.steps, index) })}>
                Remove
              </Button>
            </span>
          </li>
        ))}
      </ol>
      <StepEditor models={models} onAdd={(step) => onChange({ ...chain, steps: withStep(chain.steps, step) })} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onSave}>
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
    <div className="grid gap-3">
      {chains.map((chain) => (
        <Card key={chain.name} title={chain.name}>
          <p className="text-[12.5px] text-ink-400">{conditionText(chain.when)}</p>
          {editing?.name === chain.name ? (
            <div className="mt-3">
              <ChainEditor chain={editing} models={models} onChange={setEditing} onSave={() => { onSave(editing); setEditing(null) }} onCancel={() => setEditing(null)} />
            </div>
          ) : (
            <>
              <ol className="mt-3 flex flex-wrap gap-2">
                {chain.steps.map((step, index) => (
                  <li key={`${step.agent}-${index}`} className="rounded-full bg-white/[0.06] px-3 py-1 text-[12.5px] text-ink-200">
                    {stepText(step)}
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex justify-end gap-2">
                {confirmDelete === chain.name ? (
                  <>
                    <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                      Keep it
                    </Button>
                    <Button variant="danger" onClick={() => { onDelete(chain.name); setConfirmDelete(null) }}>
                      Delete for good
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" onClick={() => setEditing(chain)}>
                      Edit
                    </Button>
                    <Button variant="danger" onClick={() => setConfirmDelete(chain.name)}>
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </>
          )}
        </Card>
      ))}
      <Card title="New chain">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={creatingName}
            onChange={(event) => setCreatingName(event.target.value)}
            placeholder="Name"
            className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[13px] text-ink-100"
          />
          <input
            value={creatingParent}
            onChange={(event) => setCreatingParent(event.target.value)}
            placeholder="Parent agent (optional)"
            className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[13px] text-ink-100"
          />
          <Button
            variant="secondary"
            disabled={creatingName.trim() === ''}
            onClick={() => {
              setEditing(emptyChain(creatingName.trim(), creatingParent.trim()))
              setCreatingName('')
              setCreatingParent('')
            }}
          >
            Create
          </Button>
        </div>
      </Card>
      {error !== null && <ErrorNote error={error} />}
    </div>
  )
}
