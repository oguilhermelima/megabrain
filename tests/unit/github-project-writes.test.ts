import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessAdapter, type ProcessAdapter, type ProcessOutput } from '../../src/adapters/proc.js'
import { executeGithub } from '../../src/cli/commands/github.js'
import { failed, ok, type Result } from '../../src/core/result.js'
import { assertUnitStateDirectory } from './state-db-guard.js'

type Call = readonly string[]
let root = '', env: Record<string, string>, calls: Call[] = []
const real = createProcessAdapter()
const stdout = (value: unknown): Result<ProcessOutput> => ok({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 })
const query = (args: Call) => args.find((arg) => arg.startsWith('query='))?.slice(6) ?? ''
let answer: (args: Call) => Result<ProcessOutput> = () => failed('unexpected gh call')
const fake: ProcessAdapter = { run: async (command, args, options) => { if (command !== 'gh') return real.run(command, args, options); calls.push(args); return answer(args) }, startDetached: async () => failed('unexpected detached'), invocationCount: () => calls.length }
beforeEach(async () => { root = realpathSync(mkdtempSync(join(tmpdir(), 'project-writes-'))); env = { HOME: join(root, 'home'), MEGABRAIN_STATE_DIR: join(root, 'state') }; mkdirSync(env.HOME); assertUnitStateDirectory(env); await real.run('git', ['init', '-q', '-b', 'main'], { cwd: root }); await real.run('git', ['remote', 'add', 'origin', 'git@github.com:operator/sample.git'], { cwd: root }); calls = []; answer = () => failed('unexpected gh call') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const run = (args: string[]) => executeGithub(args, env, fake)
const base = { id: 'P1', number: 7, title: 'Board', url: 'https://github.com/orgs/operator/projects/7', closed: false, owner: { login: 'operator' }, fields: { nodes: [{ __typename: 'ProjectV2SingleSelectField', id: 'F1', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'O1', name: 'Ready', color: 'GREEN', description: '' }] }, { __typename: 'ProjectV2Field', id: 'F2', name: 'Estimate', dataType: 'NUMBER' }] } }
describe('GitHub project writes', () => {
  test('rejects unknown single-select option before sending a mutation', async () => { answer = () => stdout({ data: { repositoryOwner: { projectV2: base } } }); const result = await run(['project-field', root, '7', 'I1', '--field', 'Status', '--type', 'single-select', '--value', 'missing', '--json']); expect(result).toMatchObject({ kind: 'failed' }); expect(calls.every((call) => !query(call).includes('mutation'))).toBe(true) })
  test('sends a validated field update once with the option id', async () => { answer = (args) => query(args).includes('mutation') ? stdout({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'I1', isArchived: false, updatedAt: '2026-10-01', content: { __typename: 'DraftIssue', title: 'Draft' }, fieldValues: { nodes: [] } } } } }) : stdout({ data: { repositoryOwner: { projectV2: base } } }); const result = await run(['project-field', root, '7', 'I1', '--field', 'Status', '--type', 'single-select', '--value', 'Ready', '--json']); expect(result.kind).toBe('ok'); const mutation = calls.find((call) => query(call).includes('updateProjectV2ItemFieldValue')); expect(mutation).toBeDefined(); expect(mutation?.join(' ')).toContain('O1') })
  test('archive uses the GitHub archive mutation and does not retry it', async () => { answer = (args) => query(args).includes('archiveProjectV2Item') ? stdout({ data: { archiveProjectV2Item: { item: { id: 'I1', isArchived: true } } } }) : stdout({ data: { repositoryOwner: { projectV2: base } } }); const result = await run(['project-archive', root, '7', 'I1', '--json']); expect(result.kind).toBe('ok'); expect(calls.filter((call) => query(call).includes('archiveProjectV2Item'))).toHaveLength(1) })
})
