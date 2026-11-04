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
let answer: (args: GhCall) => Result<ProcessOutput> | Promise<Result<ProcessOutput>> = () => failed('gh was not expected')
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

  test('caches the complete project discovery for ten minutes', async () => {
    answer = () => stdout({ data: { repository: { projectsV2: { nodes: [base], pageInfo: { hasNextPage: false } }, owner: { __typename: 'User', login: 'operator', projectsV2: { nodes: [{ ...base, items: { nodes: [projectItem('I1')], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } } } } })
    const first = await parsed<{ projects: unknown[] }>(['projects', root, '--json'])
    const firstCallCount = calls.length
    expect((await parsed(['projects', root, '--json']))).toEqual(first)
    expect(calls).toHaveLength(firstCallCount)
    const cacheDirectory = join(env.MEGABRAIN_STATE_DIR!, 'cache', 'github')
    const cacheFile = (await import('node:fs')).readdirSync(cacheDirectory)[0]!
    const cachePath = join(cacheDirectory, cacheFile)
    const entry = JSON.parse((await import('node:fs')).readFileSync(cachePath, 'utf8')) as { fetchedAt: number }
    expect(entry.fetchedAt).toBeGreaterThan(0)
  })

  test('runs independent owner project item probes concurrently, capped at five', async () => {
    let active = 0
    let maximum = 0
    answer = async (args) => {
      const gql = query(args)
      if (!gql.includes('query projectsDiscovery') && gql.includes('projectV2(number: $number)')) {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return stdout({ data: { repositoryOwner: { projectV2: { ...base, number: Number(variables(args).number), items: { nodes: [projectItem(`I${variables(args).number}`)], pageInfo: { hasNextPage: false } } } } } })
      }
      const projects = Array.from({ length: 6 }, (_, index) => ({ ...base, id: `PVT_${index + 1}`, number: index + 1, items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: `cursor-${index + 1}` } } }))
      return stdout({ data: { repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } }, owner: { __typename: 'User', login: 'operator', projectsV2: { nodes: projects, pageInfo: { hasNextPage: false } } } } } })
    }
    const result = await parsed<{ projects: { number: number }[] }>(['projects', root, '--json'])
    expect(result.projects).toHaveLength(6)
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(5)
  })

  test('continues owner project and membership scans through their cursors', async () => {
    answer = (args) => {
      const gql = query(args)
      const cursor = variables(args).after
      if (gql.includes('query repositoryProjects')) return stdout({ data: { repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } })
      if (gql.includes('query ownerProjects')) {
        if (cursor === undefined) return stdout({ data: { repositoryOwner: { projectsV2: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'owner-cursor' } } } } })
        expect(cursor).toBe('owner-cursor')
        return stdout({ data: { repositoryOwner: { projectsV2: { nodes: [{ ...base, items: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'item-cursor' } } }], pageInfo: { hasNextPage: false, endCursor: null } } } } })
      }
      if (gql.includes('query($owner: String!, $name: String!, $number: Int!, $after: String)')) {
        expect(cursor).toBe('item-cursor')
        return stdout({ data: { repositoryOwner: { projectV2: { ...base, items: { nodes: [projectItem('I-late')], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
      }
      return stdout({ data: { repository: { projectsV2: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'owner-cursor' } }, owner: { __typename: 'User', login: 'operator', projectsV2: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'owner-cursor' } } } } } })
    }

    const result = await parsed<{ projects: { number: number }[] }>(['projects', root, '--json'])

    expect(result.projects.map((project) => project.number)).toEqual([7])
    expect(calls.length).toBeGreaterThanOrEqual(4)
  })

  test('reads issue and pull request items with status and normalizes their fields', async () => {
    answer = () => stdout({ data: { repositoryOwner: { projectV2: { ...base, items: { nodes: [projectItem('I1'), { ...projectItem('I2'), type: 'PULL_REQUEST', content: { ...projectItem('I2').content, __typename: 'PullRequest', state: 'MERGED' } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    const result = await parsed<{ items: { type: string; status: string | null; state: string | null }[] }>(['project', root, '7', '--json'])
    expect(result.items.map(({ type, status, state }) => ({ type, status, state }))).toEqual([{ type: 'ISSUE', status: 'todo', state: 'OPEN' }, { type: 'PULL_REQUEST', status: 'todo', state: 'MERGED' }])
  })

  for (const ownerType of ['User', 'Organization'] as const) {
    test(`reads ${ownerType.toLowerCase()}-owned projects without querying an incompatible owner type`, async () => {
      answer = (args) => {
        const gql = query(args)
        expect(gql).toContain('repositoryOwner(login: $owner)')
        expect(gql).not.toContain('user(login: $owner)')
        expect(gql).not.toContain('organization(login: $owner)')
        return stdout({ data: { repositoryOwner: { projectV2: { ...base, items: { nodes: [projectItem('I1')], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
      }
      const result = await parsed<{ items: { id: string }[] }>(['project', root, '7', '--json'])
      expect(result.items.map(({ id }) => id)).toEqual(['I1'])
    })
  }

  test('returns null status for a project without a Status field', async () => {
    answer = () => stdout({ data: { repositoryOwner: { projectV2: { ...base, fields: { nodes: [] }, items: { nodes: [projectItem('I1', null)], pageInfo: { hasNextPage: false, endCursor: null } } } } } })
    const result = await parsed<{ project: { statusField: unknown }; items: { status: unknown }[] }>(['project', root, '7', '--json'])
    expect(result.project.statusField).toBeNull()
    expect(result.items[0]?.status).toBeNull()
  })

  test('passes an item cursor and returns the next cursor', async () => {
    answer = (args) => {
      expect(variables(args).after).toBe('cursor-one')
      return stdout({ data: { repositoryOwner: { projectV2: { ...base, items: { nodes: [projectItem('I2')], pageInfo: { hasNextPage: true, endCursor: 'cursor-two' } } } } } })
    }
    const result = await parsed<{ next: string }>(['project', root, '7', '--after', 'cursor-one', '--json'])
    expect(result.next).toBe('cursor-two')
  })

  test('loads project metadata once and keeps item pages lightweight', async () => {
    answer = (args) => {
      const gql = query(args)
      if (gql.includes('projectMetadata')) return stdout({ data: { repositoryOwner: { projectV2: { ...base, views: { nodes: [] } } } } })
      return stdout({ data: { repositoryOwner: { projectV2: { ...base, items: { totalCount: 2, nodes: [projectItem('I1')], pageInfo: { hasNextPage: true, endCursor: 'cursor-two' } } } } } })
    }
    const first = await parsed<{ project: { number: number }; items: { id: string; status: string }[]; next: string }>(['project', root, '7', '--json'])
    expect(first.project.number).toBe(7)
    expect(first.items).toEqual([{ id: 'I1', type: 'ISSUE', number: 42, title: 'Add feature', url: 'https://github.com/operator/sample/issues/42', state: 'OPEN', repository: 'operator/sample', status: 'todo', assignees: [], labels: [], updatedAt: '2026-10-01T12:00:00Z', isArchived: false, fieldValues: [], milestone: null, parentIssue: null, subIssuesProgress: null, body: null }])
    expect(calls).toHaveLength(2)
    const itemQuery = query(calls.find((call) => query(call).includes('items(first: 100')) ?? [])
    expect(itemQuery).toContain('fieldValueByName(name: "Status")')
    expect(itemQuery).not.toContain('fieldValues(first: 30)')
    expect(itemQuery).not.toContain('labels(first: 100)')
    expect(itemQuery).not.toContain('assignees(first: 100)')
    expect(itemQuery).not.toContain('subIssuesSummary')
    expect(itemQuery).not.toContain('milestone {')
    expect(itemQuery).not.toContain('body')

    calls = []
    await parsed(['project', root, '7', '--after', 'cursor-two', '--json'])
    expect(calls).toHaveLength(1)
    expect(query(calls[0] ?? [])).not.toContain('views(first: 50)')
  })

  test('returns the total project item count with each page', async () => {
    answer = (args) => {
      expect(query(args)).toContain('totalCount')
      return stdout({ data: { repositoryOwner: { projectV2: { ...base, items: { totalCount: 2, nodes: [projectItem('I1')], pageInfo: { hasNextPage: true, endCursor: 'cursor-two' } } } } } })
    }
    const result = await parsed<{ totalCount: number }>(['project', root, '7', '--json'])
    expect(result.totalCount).toBe(2)
  })

  test('moves an item using the selected project field and status option ids', async () => {
    answer = (args) => query(args).includes('updateProjectV2ItemFieldValue')
      ? stdout({ data: { updateProjectV2ItemFieldValue: { projectV2Item: projectItem('I1', { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Done', optionId: 'done' }) } } })
      : stdout({ data: { repositoryOwner: { projectV2: base } } })
    const result = await parsed<{ item: { id: string; status: string } }>(['project-move', root, '7', 'I1', '--status', 'done', '--json'])
    expect(result.item).toMatchObject({ id: 'I1', status: 'done' })
    expect(calls).toHaveLength(2)
    expect(query(calls[0] ?? [])).toContain('projectV2(number: $number)')
    expect(query(calls[1] ?? [])).toContain('updateProjectV2ItemFieldValue')
    expect(variables(calls[1] ?? [])).toMatchObject({ itemId: 'I1', fieldId: 'F_status', optionId: 'done' })
  })

  for (const ownerType of ['User', 'Organization'] as const) {
    test(`moves items in ${ownerType.toLowerCase()}-owned projects`, async () => {
      answer = (args) => {
        const gql = query(args)
        if (gql.includes('updateProjectV2ItemFieldValue')) return stdout({ data: { updateProjectV2ItemFieldValue: { projectV2Item: projectItem('I1', { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Done', optionId: 'done' }) } } })
        expect(gql).toContain('repositoryOwner(login: $owner)')
        expect(gql).not.toContain('user(login: $owner)')
        expect(gql).not.toContain('organization(login: $owner)')
        return stdout({ data: { repositoryOwner: { projectV2: base } } })
      }
      const result = await parsed<{ item: { id: string; status: string } }>(['project-move', root, '7', 'I1', '--status', 'done', '--json'])
      expect(result.item).toMatchObject({ id: 'I1', status: 'done' })
    })
  }

  test('rejects an option absent from the project field before mutating', async () => {
    answer = () => stdout({ data: { repositoryOwner: { projectV2: base } } })
    expect(await run(['project-move', root, '7', 'I1', '--status', 'unknown', '--json'])).toMatchObject({ kind: 'failed', error: expect.stringContaining('status option') })
    expect(calls).toHaveLength(1)
    expect(query(calls[0] ?? [])).not.toContain('updateProjectV2ItemFieldValue')
  })

  test('surfaces gh errors to the caller', async () => {
    answer = () => failed('HTTP 403: Resource not accessible by integration', 1)
    expect(await run(['projects', root, '--json'])).toMatchObject({ kind: 'failed', error: expect.stringContaining('HTTP 403') })
  })
})
