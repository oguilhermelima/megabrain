import type { ProcessAdapter } from '../../../adapters/proc.js'
import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, resolveRepository } from './client.js'
import { nullableText, record } from './views.js'

type Environment = Readonly<Record<string, string | undefined>>
export type ProjectWorkflow = { id: string; name: string; number: number; enabled: boolean }

export const PROJECT_WORKFLOWS_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {
    id number workflows(first: 100, after: $after) { nodes { id name number enabled } pageInfo { hasNextPage endCursor } }
  } } }
}`

type Options = { selector: string; number: number; owner?: string; json: boolean }
function parse(args: readonly string[]): Result<Options> {
  const [selector, numberText, ...flags] = args
  const usage = usageMessage('github-project-workflows')
  if (selector === undefined || numberText === undefined || !/^[1-9]\d*$/.test(numberText)) return failed(usage, 2)
  let owner: string | undefined
  let json = false
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]!
    if (flag === '--json') { json = true; continue }
    if (flag === '--owner' && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('--')) {
      if (owner !== undefined) return failed('--owner may only be supplied once', 2)
      owner = flags[++i]!
      continue
    }
    return failed(usage, 2)
  }
  return ok({ selector, number: Number(numberText), ...(owner === undefined ? {} : { owner }), json })
}

function normalizeWorkflow(value: unknown): ProjectWorkflow | null {
  const entry = record(value)
  return entry !== undefined && typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.number === 'number' && typeof entry.enabled === 'boolean'
    ? { id: entry.id, name: entry.name, number: entry.number, enabled: entry.enabled }
    : null
}

export async function executeProjectWorkflows(args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText('github-project-workflows'))
  const parsed = parse(args)
  if (parsed.kind !== 'ok') return parsed
  const options = parsed.value
  const repository = await resolveRepository(options.selector, environment, process)
  if (repository.kind !== 'ok') return repository
  const owner = options.owner ?? repository.value.nameWithOwner.split('/')[0] ?? ''
  let after: string | null = null
  const workflows: ProjectWorkflow[] = []
  do {
    const answer = await graphqlCall(process, 'gh api graphql', PROJECT_WORKFLOWS_QUERY, { owner, number: options.number, after })
    if (answer.kind !== 'ok') return answer
    const project = record(answer.value.data.repositoryOwner)?.projectV2
    const entry = record(project)
    if (entry === undefined || typeof entry.id !== 'string') return failed(`GitHub project ${options.number} was not found for ${owner}`)
    const connection = record(entry.workflows) ?? {}
    for (const node of Array.isArray(connection.nodes) ? connection.nodes : []) {
      const workflow = normalizeWorkflow(node)
      if (workflow !== null) workflows.push(workflow)
    }
    const page = record(connection.pageInfo)
    if (page?.hasNextPage !== true) after = null
    else {
      after = nullableText(page.endCursor)
      if (after === null) return failed('GitHub project workflows returned a next page without a cursor')
    }
  } while (after !== null)
  const output = { workflows }
  return options.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(workflows.map(({ number, name, enabled }) => `${number}\t${enabled ? 'enabled' : 'disabled'}\t${name}`).join('\n') + (workflows.length ? '\n' : ''))
}
