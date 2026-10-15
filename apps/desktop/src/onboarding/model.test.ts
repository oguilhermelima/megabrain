import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installPlanSchema, type InstallEvent, type InstallPlan } from '@/api/schema'
import { emptyProgress, groupModules, initialSelection, installArgs, moduleRetryArgs, reduceInstall, removals } from '@/onboarding/model'

const captured = installPlanSchema.parse(JSON.parse(readFileSync(join(import.meta.dir, '..', 'api', 'fixtures', 'captured', 'install-plan.json'), 'utf8')))

function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return { ...captured, ...overrides }
}

describe('initialSelection', () => {
  test('takes the CLI defaults as they are', () => {
    expect(initialSelection(captured)).toEqual({
      agents: captured.defaults.agents,
      skill: captured.defaults.skill,
      tmux: captured.defaults.tmux,
      modules: captured.defaults.modules,
    })
  })
  test('leaves the opt-in resource hooks off', () => {
    expect(initialSelection(captured).modules).not.toContain('resource-hooks')
  })
  test('never selects a module the CLI marks unavailable, even when a default names it', () => {
    const modules = captured.modules.map((module) =>
      module.module === 'tv-adb' ? { ...module, unavailable: true, reason: 'adb is not on PATH', selectedByDefault: false } : module,
    )
    const selection = initialSelection(plan({ modules, defaults: { ...captured.defaults, modules: [...captured.defaults.modules, 'tv-adb'] } }))
    expect(selection.modules).not.toContain('tv-adb')
  })
})

describe('removals', () => {
  test('lists modules installed before and now unselected', () => {
    const previous = { agents: ['claude'], skill: 'global' as const, tmux: 'yes' as const, modules: ['worktree', 'orchestration', 'simulator-web'] }
    expect(removals(plan({ previous }), { ...initialSelection(captured), modules: ['orchestration'] })).toEqual(['worktree', 'simulator-web'])
  })
  test('ignores tmux-runtime, which is the tmux answer and not a module choice', () => {
    const previous = { agents: [], skill: 'none' as const, tmux: 'yes' as const, modules: ['tmux-runtime'] }
    expect(removals(plan({ previous }), { ...initialSelection(captured), modules: [] })).toEqual([])
  })
  test('is empty on a first install', () => {
    expect(removals(plan({ previous: null }), { ...initialSelection(captured), modules: [] })).toEqual([])
  })
})

describe('installArgs', () => {
  const selection = { agents: ['claude', 'codex'], skill: 'global' as const, tmux: 'yes' as const, modules: ['orchestration', 'worktree'] }
  test('passes every choice explicitly and asks for JSON', () => {
    expect(installArgs(selection, false)).toEqual([
      'install', '--json', '--agents', 'claude,codex', '--skill', 'global', '--tmux', 'yes', '--modules', 'orchestration,worktree',
    ])
  })
  test('says none for empty lists', () => {
    expect(installArgs({ ...selection, agents: [], modules: [] }, false)).toEqual([
      'install', '--json', '--agents', 'none', '--skill', 'global', '--tmux', 'yes', '--modules', 'none',
    ])
  })
  test('adds --yes only when the person confirmed the removals', () => {
    expect(installArgs(selection, false)).not.toContain('--yes')
    expect(installArgs(selection, true).at(-1)).toBe('--yes')
  })
  test('retries one module on its own', () => {
    expect(moduleRetryArgs('worktree')).toEqual(['install', 'worktree', '--json'])
  })
})

describe('groupModules', () => {
  test('keeps the CLI order inside each group, groups in order of first appearance', () => {
    const groups = groupModules(captured)
    expect(groups.map((group) => group.group)).toEqual(['Agents', 'Testing'])
    expect(groups.flatMap((group) => group.modules.map((module) => module.module))).toEqual(captured.modules.map((module) => module.module))
  })
})

describe('reduceInstall', () => {
  const run = (events: InstallEvent[]) => events.reduce(reduceInstall, emptyProgress)

  test('tracks a module step from start to done', () => {
    const progress = run([
      { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'start' },
      { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'done', message: 'ok' },
    ])
    expect(progress.steps).toEqual([{ key: 'worktree', module: 'worktree', label: 'Setting up Shared worktrees', state: 'done', message: 'ok' }])
  })
  test('keeps the failure message of a failed step', () => {
    const progress = run([
      { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'start' },
      { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'fail', message: 'superset CLI is not on PATH' },
    ])
    expect(progress.steps[0]).toMatchObject({ state: 'failed', message: 'superset CLI is not on PATH' })
  })
  test('keys a step without a module by its label', () => {
    const progress = run([
      { type: 'step', label: 'Installing the skill', state: 'start' },
      { type: 'step', module: 'worktree', label: 'Setting up Shared worktrees', state: 'start' },
      { type: 'step', label: 'Installing the skill', state: 'done' },
    ])
    expect(progress.steps.map((step) => [step.key, step.state])).toEqual([
      ['Installing the skill', 'done'],
      ['worktree', 'running'],
    ])
  })
  test('collects info, warn and confirm in order, and the result', () => {
    const result = { type: 'result', ok: true, message: 'done', configured: ['worktree'], failed: [] } as const
    const progress = run([
      { type: 'info', message: 'one' },
      { type: 'warn', message: 'two' },
      { type: 'confirm', message: 'Remove simulator-web?', answer: false },
      result,
    ])
    expect(progress.log).toEqual([
      { level: 'info', message: 'one' },
      { level: 'warn', message: 'two' },
      { level: 'confirm', message: 'Remove simulator-web? (kept)' },
    ])
    expect(progress.result).toEqual(result)
  })
  test('ignores the intro', () => {
    expect(run([{ type: 'intro', version: '0.2.4', hosts: { orca: false, superset: false, tmux: true }, agents: [] }])).toEqual(emptyProgress)
  })
})
