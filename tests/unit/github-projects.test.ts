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
const base = { __typename: 'ProjectV2', id: 'PVT_1', number: 7, title: 'Roadmap', url: 'https://github.com/orgs/operator/projects/7', closed: false, owner: { login: 'operator' }, fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'F_status', name: 'Status', options: [{ id: 'todo', name: 'Todo', color: 'GRAY' }, { id: 'done', name: 'Done', color: 'GREEN' }] }] } }
const projectItem = (id: string, status: unknown = { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', optionId: 'todo' }) => ({ id, type: 'ISSUE', content: { __typename: 'Issue', number: 42, title: 'Add feature', url: 'https://github.com/operator/sample/issues/42', state: 'OPEN', repository: { nameWithOwner: 'operator/sample' }, updatedAt: '2026-10-01T12:00:00Z', assignees: { nodes: [{ login: 'dev', avatarUrl: 'https://example.test/avatar.png' }] }, labels: { nodes: [{ name: 'feature', color: 'aabbcc' }] } }, fieldValueByName: status })

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'megabrain-github-projects-')))
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

describe('github projects', () => {
  test('lists linked repository projects and owner projects containing a repository item', async () => {
    answer = (args) => stdout({ data: { repository: { projectsV2: { nodes: [base] }, owner: { __typename: 'User', login: 'operator', projectsV2: { nodes: [{ ...base, items: { nodes: [projectItem('I1')] } }] } } } } })
    const result = await parsed<{ projects: { number: number; statusField: { options: { id: string }[] } | null }[] }>(['projects', root, '--json'])
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0]?.number).toBe(7)
    expect(result.projects[0]?.statusField?.options[0]?.id).toBe('todo')
    expect(calls).toHaveLength(1)
  })

  test('reads issue and pull request items with status and normalizes their fields', async () => {
    answer = () => stdout({ data: { user: { projectV2: { ...base, items: { nodes: [projectItem('I1'), { ...projectItem('I2'), type: 'PULL_REQUEST', content: { ...projectItem('I2').content, __typename: 'PullRequest', state: 'MERGED' } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    const result = await parsed<{ items: { type: string; status: string | null; state: string | null }[] }>(['project', root, '7', '--json'])
    expect(result.items.map(({ type, status, state }) => ({ type, status, state }))).toEqual([{ type: 'ISSUE', status: 'todo', state: 'OPEN' }, { type: 'PULL_REQUEST', status: 'todo', state: 'MERGED' }])
  })

  test('returns null status for a project without a Status field', async () => {
    answer = () => stdout({ data: { user: { projectV2: { ...base, fields: { nodes: [] }, items: { nodes: [projectItem('I1', null)], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    const result = await parsed<{ project: { statusField: unknown }; items: { status: unknown }[] }>(['project', root, '7', '--json'])
    expect(result.project.statusField).toBeNull()
    expect(result.items[0]?.status).toBeNull()
  })

  test('passes an item cursor and returns the next cursor', async () => {
    answer = (args) => {
      expect(variables(args).after).toBe('cursor-one')
      return stdout({ data: { user: { projectV2: { ...base, items: { nodes: [projectItem('I2')], pageInfo: { hasNextPage: true, endCursor: 'cursor-two' } } } } } })
    }
    const result = await parsed<{ next: string }>(['project', root, '7', '--after', 'cursor-one', '--json'])
    expect(result.next).toBe('cursor-two')
  })

  test('moves an item using the selected project field and status option ids', async () => {
    answer = (args) => query(args).includes('updateProjectV2ItemFieldValue')
      ? stdout({ data: { updateProjectV2ItemFieldValue: { projectV2Item: projectItem('I1', { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Done', optionId: 'done' }) } } })
      : stdout({ data: { user: { projectV2: base } } })
    const result = await parsed<{ item: { id: string; status: string } }>(['project-move', root, '7', 'I1', '--status', 'done', '--json'])
    expect(result.item).toMatchObject({ id: 'I1', status: 'done' })
    expect(calls).toHaveLength(2)
    expect(query(calls[0] ?? [])).toContain('projectV2(number: $number)')
    expect(query(calls[1] ?? [])).toContain('updateProjectV2ItemFieldValue')
    expect(variables(calls[1] ?? [])).toMatchObject({ itemId: 'I1', fieldId: 'F_status', optionId: 'done' })
  })

  test('rejects an option absent from the project field before mutating', async () => {
    answer = () => stdout({ data: { user: { projectV2: base } } })
    expect(await run(['project-move', root, '7', 'I1', '--status', 'unknown', '--json'])).toMatchObject({ kind: 'failed', error: expect.stringContaining('status option') })
    expect(calls).toHaveLength(1)
    expect(query(calls[0] ?? [])).not.toContain('updateProjectV2ItemFieldValue')
  })

  test('surfaces gh errors to the caller', async () => {
    answer = () => failed('HTTP 403: Resource not accessible by integration', 1)
    expect(await run(['projects', root, '--json'])).toMatchObject({ kind: 'failed', error: expect.stringContaining('HTTP 403') })
  })
})
