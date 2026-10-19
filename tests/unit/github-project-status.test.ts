import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessAdapter, type ProcessAdapter, type ProcessOutput } from '../../src/adapters/proc.js'
import { executeGithub } from '../../src/cli/commands/github.js'
import { failed, ok, type Result } from '../../src/core/result.js'
import { assertUnitStateDirectory } from './state-db-guard.js'

type GhCall = readonly string[]
let root = ''
let env: Record<string, string>
let calls: GhCall[] = []
let answer: (args: GhCall) => Result<ProcessOutput> = () => failed('gh was not expected')
const real = createProcessAdapter()
const fakeGh: ProcessAdapter = {
  run: async (command, args, options) => {
    if (command !== 'gh') return real.run(command, args, options)
    calls.push(args)
    return answer(args)
  },
  startDetached: async () => failed('unexpected detached process'),
  invocationCount: () => calls.length,
}
const stdout = (value: unknown): Result<ProcessOutput> => ok({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 })
const query = (args: GhCall) => (args.find((arg) => arg.startsWith('query=')) ?? '').slice(6)
const variables = (args: GhCall): Record<string, string> => Object.fromEntries(args.flatMap((arg, i) => {
  if ((arg !== '-f' && arg !== '-F') || !args[i + 1]) return []
  const [key, ...value] = args[i + 1]!.split('=')
  return key === 'query' ? [] : [[key!, value.join('=')]]
}))
const project = { id: 'PVT_1', number: 7, title: 'Roadmap', url: 'https://github.com/orgs/operator/projects/7' }
const statusUpdate = { id: 'PVT_status_1', status: 'AT_RISK', body: 'Dependencies need attention', startDate: '2026-10-01', targetDate: '2026-10-31', createdAt: '2026-10-02T12:00:00Z', creator: { login: 'operator' } }

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'megabrain-github-project-status-')))
  env = { HOME: join(root, 'home'), MEGABRAIN_STATE_DIR: join(root, 'state') }
  mkdirSync(env.HOME)
  assertUnitStateDirectory(env)
  const git = await real.run('git', ['init', '-q', '-b', 'main'], { cwd: root })
  if (git.kind !== 'ok') throw new Error(git.error)
  await real.run('git', ['remote', 'add', 'origin', 'git@github.com:operator/sample.git'], { cwd: root })
  calls = []
  answer = () => failed('gh was not expected')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))
const run = (args: string[]) => executeGithub(args, env, fakeGh)
const parsed = async <T>(args: string[]) => {
  const result = await run(args)
  if (result.kind !== 'ok') throw new Error(result.error)
  return JSON.parse(result.value) as T
}

describe('github project status updates', () => {
  test('lists and normalizes project status updates', async () => {
    answer = () => stdout({ data: { repositoryOwner: { projectV2: { ...project, statusUpdates: { nodes: [statusUpdate], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    const result = await parsed<{ updates: { status: string; creator: string }[] }>(['project-status', root, '7', '--json'])
    expect(result.updates).toEqual([{ ...statusUpdate, creator: 'operator' }])
    expect(query(calls[0] ?? [])).toContain('statusUpdates')
  })

  test('creates a status update with optional dates and body through the fake gh', async () => {
    answer = (args) => query(args).includes('createProjectV2StatusUpdate')
      ? stdout({ data: { createProjectV2StatusUpdate: { statusUpdate } } })
      : stdout({ data: { repositoryOwner: { projectV2: project } } })
    const result = await parsed<{ update: { id: string; status: string } }>(['project-status-create', root, '7', '--status', 'AT_RISK', '--body', 'Dependencies need attention', '--start', '2026-10-01', '--target', '2026-10-31', '--json'])
    expect(result.update).toMatchObject({ id: statusUpdate.id, status: 'AT_RISK' })
    expect(variables(calls.at(-1) ?? [])).toMatchObject({ status: 'AT_RISK', body: 'Dependencies need attention', startDate: '2026-10-01', targetDate: '2026-10-31' })
  })

  test('rejects unsupported status values before sending a mutation', async () => {
    expect(await run(['project-status-create', root, '7', '--status', 'UNKNOWN'])).toMatchObject({ kind: 'failed', error: expect.stringContaining('status') })
    expect(calls).toHaveLength(0)
  })
})

describe('github project workflows', () => {
  test('lists project workflows without a mutation', async () => {
    answer = () => stdout({ data: { repositoryOwner: { projectV2: { ...project, workflows: { nodes: [{ id: 'PWF_1', name: 'Auto-close issue', number: 9, enabled: true }], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    const result = await parsed<{ workflows: { id: string; name: string; number: number; enabled: boolean }[] }>(['project-workflows', root, '7', '--json'])
    expect(result.workflows).toEqual([{ id: 'PWF_1', name: 'Auto-close issue', number: 9, enabled: true }])
    expect(query(calls[0] ?? [])).toContain('workflows')
    expect(query(calls[0] ?? [])).not.toContain('mutation')
  })
})
