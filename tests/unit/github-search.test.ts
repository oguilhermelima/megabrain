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
const variable = (args: GhCall, key: string) => { const entry = args.find((arg) => arg.startsWith(`${key}=`)); return entry?.slice(key.length + 1) }
const base = { number: 17, title: 'A filtered item', state: 'OPEN', isDraft: false, url: 'https://github.com/operator/sample/issues/17', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', author: { login: 'dev', name: 'Dev' }, labels: { nodes: [{ name: 'Good First Issue', color: 'aabbcc', description: 'help wanted' }] }, assignees: { nodes: [{ login: 'dev', name: 'Dev' }] }, comments: { totalCount: 2 }, milestone: null }
const searchAnswer = (queryText: string) => ({ data: {
  open: { issueCount: 3 }, closed: { issueCount: 2 }, merged: { issueCount: 1 }, all: { issueCount: 5 },
  items: { issueCount: 4, pageInfo: { hasNextPage: true, endCursor: 'cursor-next' }, nodes: [{ ...base, __typename: queryText.includes('is:pr') ? 'PullRequest' : 'Issue' }] },
} })

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'megabrain-github-search-')))
  env = { HOME: join(root, 'home'), MEGABRAIN_STATE_DIR: join(root, 'state') }
  mkdirSync(env.HOME)
  assertUnitStateDirectory(env)
  await real.run('git', ['init', '-q', '-b', 'main'], { cwd: root })
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

describe('GitHub issue and PR search', () => {
  test('builds issue search with state, repeated labels, assignee and escaped search text', async () => {
    answer = (args) => { expect(query(args)).toContain('search(type: ISSUE, query: "repo:operator/sample is:issue is:open label:\\"Good First Issue\\" label:bug assignee:dev \\\"quoted\\\" in:title,body")'); return stdout(searchAnswer(query(args))) }
    const result = await parsed<{ totalCount: number; nextCursor: string | null }>(['issues', root, '--state', 'open', '--label', 'Good First Issue', '--label', 'bug', '--assignee', 'dev', '--search', '"quoted"', '--json'])
    expect(result).toMatchObject({ totalCount: 4, nextCursor: 'cursor-next' })
  })

  test('builds PR search for author and draft filters', async () => {
    answer = (args) => { expect(query(args)).toContain('author:octocat draft:true'); expect(query(args)).toContain('is:pr'); return stdout(searchAnswer(query(args))) }
    await parsed(['prs', root, '--author', 'octocat', '--draft', 'true', '--json'])
  })

  test('uses filtered issue count reads and page total from search', async () => {
    answer = (args) => { const q = query(args); expect(q.match(/open: search/g)).toBeTruthy(); expect(q.match(/closed: search/g)).toBeTruthy(); expect(q.match(/all: search/g)).toBeTruthy(); return stdout(searchAnswer(q)) }
    const result = await parsed<{ counts: Record<string, number>; totalCount: number }>(['issues', root, '--label', 'bug', '--json'])
    expect(result.counts).toEqual({ open: 3, closed: 2, all: 5 })
    expect(result.totalCount).toBe(4)
  })

  test('keeps the existing GraphQL listing path when there are no filters', async () => {
    answer = (args) => { expect(query(args)).toContain('items: issues('); expect(query(args)).not.toContain('search('); return stdout({ data: { repository: { open: { totalCount: 3 }, closed: { totalCount: 2 }, items: { totalCount: 3, pageInfo: { hasNextPage: false }, nodes: [] } } } }) }
    const result = await parsed<{ counts: Record<string, number> }>(['issues', root, '--json'])
    expect(result.counts).toEqual({ open: 3, closed: 2, all: 5 })
  })

  test('rejects an unknown state before calling GitHub', async () => {
    expect(await run(['issues', root, '--state', 'pending', '--json'])).toMatchObject({ kind: 'failed' })
    expect(calls).toHaveLength(0)
  })

  test('pages every repository label', async () => {
    answer = (args) => variable(args, 'after') === undefined
      ? stdout({ data: { repository: { labels: { nodes: [{ name: 'feature', color: 'aabbcc', description: '' }], pageInfo: { hasNextPage: true, endCursor: 'labels-2' } } } } })
      : stdout({ data: { repository: { labels: { nodes: [{ name: 'Good First Issue', color: 'ddeeff', description: 'help wanted' }], pageInfo: { hasNextPage: false, endCursor: null } } } } })
    const result = await parsed<{ labels: { name: string }[] }>(['labels', root, '--json'])
    expect(result.labels.map((label) => label.name)).toEqual(['feature', 'Good First Issue'])
    expect(calls).toHaveLength(2)
    expect(variable(calls[1] ?? [], 'after')).toBe('labels-2')
  })

  test('fails clearly when GitHub repeats a labels cursor', async () => {
    answer = () => stdout({ data: { repository: { labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'same-cursor' } } } } })
    expect(await run(['labels', root, '--json'])).toMatchObject({ kind: 'failed', error: expect.stringContaining('invalid labels cursor') })
    expect(calls).toHaveLength(2)
  })
})
