import type { InstallEvent, InstallPlan, PlanModule, ResultEvent } from '@/api/schema'

export interface Selection {
  agents: string[]
  skill: InstallPlan['defaults']['skill']
  tmux: InstallPlan['defaults']['tmux']
  modules: string[]
}

export interface Step {
  /** The module when the step is one, otherwise its label. */
  key: string
  module: string | null
  label: string
  state: 'running' | 'done' | 'failed'
  message: string | null
}

export interface InstallProgress {
  steps: Step[]
  log: { level: 'info' | 'warn' | 'confirm'; message: string }[]
  result: ResultEvent | null
}

export const emptyProgress: InstallProgress = { steps: [], log: [], result: null }

/** The CLI's own defaults, minus anything it says cannot be installed here. */
export function initialSelection(plan: InstallPlan): Selection {
  const unavailable = new Set(plan.modules.filter((module) => module.unavailable).map((module) => module.module))
  return {
    agents: [...plan.defaults.agents],
    skill: plan.defaults.skill,
    tmux: plan.defaults.tmux,
    modules: plan.defaults.modules.filter((module) => !unavailable.has(module)),
  }
}

/** Modules installed before that this selection would remove. tmux-runtime follows the tmux answer. */
export function removals(plan: InstallPlan, selection: Selection): string[] {
  if (plan.previous === null) return []
  return plan.previous.modules.filter((module) => module !== 'tmux-runtime' && !selection.modules.includes(module))
}

const list = (items: string[]): string => (items.length === 0 ? 'none' : items.join(','))

/** Every choice is passed explicitly; --yes only when the person confirmed the removals. */
export function installArgs(selection: Selection, confirmRemovals: boolean): string[] {
  return [
    'install', '--json',
    '--agents', list(selection.agents),
    '--skill', selection.skill,
    '--tmux', selection.tmux,
    '--modules', list(selection.modules),
    ...(confirmRemovals ? ['--yes'] : []),
  ]
}

export function moduleRetryArgs(module: string): string[] {
  return ['install', module, '--json']
}

export function groupModules(plan: InstallPlan): { group: string; modules: PlanModule[] }[] {
  const groups = new Map<string, PlanModule[]>()
  for (const module of plan.modules) groups.set(module.group, [...(groups.get(module.group) ?? []), module])
  return [...groups].map(([group, modules]) => ({ group, modules }))
}

const stepState = { start: 'running', done: 'done', fail: 'failed' } as const

export function reduceInstall(progress: InstallProgress, event: InstallEvent): InstallProgress {
  switch (event.type) {
    case 'intro':
      return progress
    case 'step': {
      const step: Step = {
        key: event.module ?? event.label,
        module: event.module ?? null,
        label: event.label,
        state: stepState[event.state],
        message: event.message ?? null,
      }
      const index = progress.steps.findIndex((existing) => existing.key === step.key)
      const steps = index === -1 ? [...progress.steps, step] : progress.steps.map((existing, at) => (at === index ? step : existing))
      return { ...progress, steps }
    }
    case 'info':
    case 'warn':
      return { ...progress, log: [...progress.log, { level: event.type, message: event.message }] }
    case 'confirm':
      return { ...progress, log: [...progress.log, { level: 'confirm', message: `${event.message} (${event.answer ? 'removed' : 'kept'})` }] }
    case 'result':
      return { ...progress, result: event }
  }
}
