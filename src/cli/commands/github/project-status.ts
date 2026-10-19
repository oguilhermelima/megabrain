import type { ProcessAdapter } from '../../../adapters/proc.js'
import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, resolveRepository } from './client.js'
import { nullableText, record } from './views.js'

type Environment = Readonly<Record<string, string | undefined>>
export const PROJECT_STATUS_VALUES = ['INACTIVE', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETE'] as const
export type ProjectStatusUpdateStatus = typeof PROJECT_STATUS_VALUES[number]
export type ProjectStatusUpdate = {
  id: string
  status: ProjectStatusUpdateStatus
  body: string
  startDate: string | null
  targetDate: string | null
  createdAt: string
  creator: string | null
}

const STATUS_UPDATE_FIELDS = 'id status body startDate targetDate createdAt creator { login }'
export const PROJECT_STATUS_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
    id number statusUpdates(first: 100, after: $after) { nodes { ${STATUS_UPDATE_FIELDS} } pageInfo { hasNextPage endCursor } }
  } } }
}`
export const CREATE_PROJECT_STATUS_UPDATE = `mutation($projectId: ID!, $status: ProjectV2StatusUpdateStatus!, $body: String, $startDate: Date, $targetDate: Date) {
  createProjectV2StatusUpdate(input: { projectId: $projectId, status: $status, body: $body, startDate: $startDate, targetDate: $targetDate }) {
    statusUpdate { ${STATUS_UPDATE_FIELDS} }
  }
}`

type Options = { selector: string; number: number; owner?: string; json: boolean }
type CreateOptions = Options & { status: ProjectStatusUpdateStatus; body?: string; start?: string; target?: string }

function projectArguments(args: readonly string[], write: false): Result<Options>
function projectArguments(args: readonly string[], write: true): Result<CreateOptions>
function projectArguments(args: readonly string[], write: boolean): Result<Options | CreateOptions> {
  const [selector, numberText, ...flags] = args
  const usage = usageMessage(write ? 'github-project-status-create' : 'github-project-status')
  if (selector === undefined || numberText === undefined || !/^[1-9]\d*$/.test(numberText)) return failed(usage, 2)
  const values: Record<string, string> = {}
  let json = false
  const supported = write ? ['--owner', '--status', '--body', '--start', '--target'] : ['--owner']
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]!
    if (flag === '--json') { json = true; continue }
    if (supported.includes(flag) && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('--')) {
      if (values[flag] !== undefined) return failed(`${flag} may only be supplied once`, 2)
      values[flag] = flags[++i]!
      continue
    }
    return failed(usage, 2)
  }
  if (!write) return ok({ selector, number: Number(numberText), ...(values['--owner'] === undefined ? {} : { owner: values['--owner'] }), json })
  const status = values['--status']
  if (status === undefined) return failed('--status is required', 2)
  if (!(PROJECT_STATUS_VALUES as readonly string[]).includes(status)) return failed(`unsupported project status ${status}; expected ${PROJECT_STATUS_VALUES.join(', ')}`, 2)
  return ok({ selector, number: Number(numberText), status: status as ProjectStatusUpdateStatus,
    ...(values['--owner'] === undefined ? {} : { owner: values['--owner'] }),
    ...(values['--body'] === undefined ? {} : { body: values['--body'] }),
    ...(values['--start'] === undefined ? {} : { start: values['--start'] }),
    ...(values['--target'] === undefined ? {} : { target: values['--target'] }), json })
}

function normalizeStatusUpdate(value: unknown): ProjectStatusUpdate | null {
  const entry = record(value)
  if (entry === undefined || typeof entry.id !== 'string' || typeof entry.status !== 'string' || !(PROJECT_STATUS_VALUES as readonly string[]).includes(entry.status)) return null
  return {
    id: entry.id, status: entry.status as ProjectStatusUpdateStatus,
    body: typeof entry.body === 'string' ? entry.body : '',
    startDate: nullableText(entry.startDate), targetDate: nullableText(entry.targetDate),
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : '',
    creator: nullableText(record(entry.creator)?.login),
  }
}

async function projectMetadata(owner: string, number: number, process: ProcessAdapter) {
  const answer = await graphqlCall(process, 'gh api graphql', PROJECT_STATUS_QUERY, { owner, number, after: null })
  if (answer.kind !== 'ok') return answer
  const project = record(answer.value.data.repositoryOwner)?.projectV2
  const entry = record(project)
  if (entry === undefined || typeof entry.id !== 'string') return failed(`GitHub project ${number} was not found for ${owner}`)
  return ok({ id: entry.id, statusUpdates: record(entry.statusUpdates) ?? {} })
}

export async function executeProjectStatus(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText('github-project-status'))
  const parsed = projectArguments(args, false)
  if (parsed.kind !== 'ok') return parsed
  const options = parsed.value
  const repository = await resolveRepository(options.selector, environment, process)
  if (repository.kind !== 'ok') return repository
  const owner = options.owner ?? repository.value.nameWithOwner.split('/')[0] ?? ''
  let after: string | null = null
  const updates: ProjectStatusUpdate[] = []
  do {
    const variables = { owner, number: options.number, after }
    const answer = await graphqlCall(process, 'gh api graphql', PROJECT_STATUS_QUERY, variables)
    if (answer.kind !== 'ok') return answer
    const project = record(answer.value.data.repositoryOwner)?.projectV2
    const entry = record(project)
    if (entry === undefined || typeof entry.id !== 'string') return failed(`GitHub project ${options.number} was not found for ${owner}`)
    const connection = record(entry.statusUpdates) ?? {}
    for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
      const update = normalizeStatusUpdate(node)
      if (update !== null) updates.push(update)
    }
    const page = record(connection.pageInfo)
    if (page?.hasNextPage !== true) after = null
    else {
      after = nullableText(page.endCursor)
      if (after === null) return failed('GitHub project status updates returned a next page without a cursor')
    }
  } while (after !== null)
  const output = { updates }
  return options.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(updates.map((item) => `${item.status}\t${item.createdAt}\t${item.creator ?? '-'}\t${item.body}`).join('\n') + (updates.length ? '\n' : ''))
}

export async function executeProjectStatusCreate(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText('github-project-status-create'))
  const parsed = projectArguments(args, true)
  if (parsed.kind !== 'ok') return parsed
  const options = parsed.value
  const repository = await resolveRepository(options.selector, environment, process)
  if (repository.kind !== 'ok') return repository
  const owner = options.owner ?? repository.value.nameWithOwner.split('/')[0] ?? ''
  const project = await projectMetadata(owner, options.number, process)
  if (project.kind !== 'ok') return project
  const created = await graphqlCall(process, 'gh api graphql', CREATE_PROJECT_STATUS_UPDATE, {
    projectId: project.value.id, status: options.status, body: options.body ?? null,
    startDate: options.start ?? null, targetDate: options.target ?? null,
  }, { retry: false })
  if (created.kind !== 'ok') return created
  const update = normalizeStatusUpdate(record(created.value.data.createProjectV2StatusUpdate)?.statusUpdate)
  if (update === null) return failed('GitHub project status update returned an unexpected answer')
  const output = { update }
  return options.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(`${update.id}\t${update.status}\n`)
}
