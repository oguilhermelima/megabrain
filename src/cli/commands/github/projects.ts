import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, repositoryVariables, resolveRepository } from './client.js'
import { list, nullableText, record, text } from './views.js'
import type { ProcessAdapter } from '../../../adapters/proc.js'

export const PROJECT_VERBS = ['projects', 'project', 'project-move'] as const
type ProjectVerb = typeof PROJECT_VERBS[number]
type Environment = Readonly<Record<string, string | undefined>>

export type ProjectStatusOption = { id: string; name: string; color: string }
export type ProjectStatusField = { id: string; name: string; options: ProjectStatusOption[] }
export type Project = { id: string; number: number; title: string; url: string; owner: string; closed: boolean; statusField: ProjectStatusField | null }
export type ProjectItem = {
  id: string; type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE'; number: number | null; title: string; url: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | null; repository: string | null; status: string | null;
  assignees: { login: string; avatarUrl: string }[]; labels: { name: string; color: string }[]; updatedAt: string;
}

const STATUS_FIELD = `fields(first: 100) { nodes { __typename ... on ProjectV2SingleSelectField { id name options { id name color } } } }`
export const PROJECT_FIELDS = `id number title url closed owner { ... on User { login } ... on Organization { login } } ${STATUS_FIELD}`
export const CONTENT_FIELDS = `
  __typename
  ... on Issue { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } }
  ... on PullRequest { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } }
  ... on DraftIssue { title }
`
const PROJECT_ITEMS = `items(first: 100, after: $after) { nodes { id fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } } content { ${CONTENT_FIELDS} } } pageInfo { hasNextPage endCursor } }`

export const PROJECTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 100) { nodes { ${PROJECT_FIELDS} } }
    owner {
      __typename login
      ... on User { projectsV2(first: 100) { nodes { ${PROJECT_FIELDS} items(first: 100) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } } } } }
      ... on Organization { projectsV2(first: 100) { nodes { ${PROJECT_FIELDS} items(first: 100) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } } } } }
    }
  }
}`

export const PROJECT_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { owner { login } }
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { ${PROJECT_FIELDS} ${PROJECT_ITEMS} } } }
}`

function statusField(value: unknown): ProjectStatusField | null {
  const fields = list(record(value)?.nodes)
  const field = fields.find((candidate) => candidate.__typename === 'ProjectV2SingleSelectField' && candidate.name === 'Status')
  if (field === undefined || typeof field.id !== 'string') return null
  return {
    id: field.id,
    name: 'Status',
    options: list(field.options).flatMap((option) => typeof option.id === 'string' && typeof option.name === 'string' && typeof option.color === 'string'
      ? [{ id: option.id, name: option.name, color: option.color }] : []),
  }
}

export function normalizeProject(value: unknown): Project | null {
  const entry = record(value)
  if (entry === undefined || typeof entry.id !== 'string' || typeof entry.number !== 'number') return null
  return {
    id: entry.id, number: entry.number, title: text(entry.title), url: text(entry.url),
    owner: text(record(entry.owner)?.login), closed: entry.closed === true, statusField: statusField(entry.fields),
  }
}

export function normalizeProjectItem(value: unknown): ProjectItem | null {
  const entry = record(value)
  const content = record(entry?.content)
  if (entry === undefined || typeof entry.id !== 'string' || content === undefined) return null
  const typename = text(content.__typename)
  const type = typename === 'PullRequest' ? 'PULL_REQUEST' : typename === 'DraftIssue' ? 'DRAFT_ISSUE' : typename === 'Issue' ? 'ISSUE' : null
  if (type === null) return null
  const stateText = text(content.state)
  const state = stateText === 'OPEN' || stateText === 'CLOSED' || stateText === 'MERGED' ? stateText : null
  return {
    id: entry.id, type, number: typeof content.number === 'number' ? content.number : null,
    title: text(content.title), url: nullableText(content.url), state,
    repository: nullableText(record(content.repository)?.nameWithOwner),
    status: nullableText(record(entry.fieldValueByName)?.optionId),
    assignees: list(record(content.assignees)?.nodes).flatMap((assignee) => typeof assignee.login === 'string'
      ? [{ login: assignee.login, avatarUrl: text(assignee.avatarUrl) }] : []),
    labels: list(record(content.labels)?.nodes).flatMap((label) => typeof label.name === 'string'
      ? [{ name: label.name, color: text(label.color) }] : []),
    updatedAt: text(content.updatedAt),
  }
}

function connection(value: unknown): Record<string, unknown> {
  return record(value) ?? {}
}

function ownerProjectNodes(owner: Record<string, unknown>): Record<string, unknown>[] {
  return list(record(owner.projectsV2)?.nodes)
}

function containsRepository(value: unknown, repository: string): boolean {
  return list(record(value)?.nodes).some((item) => {
    const name = record(record(item)?.content)?.repository
    return record(name)?.nameWithOwner === repository
  })
}

type Parsed = { selector: string; number?: number; owner?: string; after?: string | null; json: boolean }
function parse(verb: ProjectVerb, args: readonly string[]): Result<Parsed> {
  const positionals = verb === 'projects' ? 1 : 2
  const selector = args[0]
  const numberText = positionals > 1 ? args[1] : undefined
  const flags = args.slice(positionals)
  if (selector === undefined || (verb !== 'projects' && (numberText === undefined || !/^\d+$/.test(numberText) || Number(numberText) < 1))) return failed(usageMessage(`github-${verb}`), 2)
  const values: Record<string, string> = {}
  let json = false
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]
    if (flag === '--json') { json = true; continue }
    if ((flag === '--owner' || flag === '--after') && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('--')) {
      if (values[flag] !== undefined) return failed(`${flag} may only be supplied once`, 2)
      values[flag] = flags[++i]!
      continue
    }
    return failed(usageMessage(`github-${verb}`), 2)
  }
  return ok({ selector, ...(numberText === undefined ? {} : { number: Number(numberText) }), ...(values['--owner'] === undefined ? {} : { owner: values['--owner'] }), ...(values['--after'] === undefined ? {} : { after: values['--after'] }), json })
}

async function projectQuery(repositoryName: string, owner: string, number: number, after: string | null, process: ProcessAdapter) {
  const variables = { ...repositoryVariables(repositoryName), owner, number, ...(after === null ? {} : { after }) }
  const answer = await graphqlCall(process, 'gh api graphql', PROJECT_QUERY, variables)
  if (answer.kind !== 'ok') return answer
  const ownerValue = record(answer.value.data.repositoryOwner)?.projectV2
  const projectValue = normalizeProject(ownerValue)
  if (projectValue === null) return failed(`GitHub project ${number} was not found for ${owner}`)
  const items = record(ownerValue)?.items
  const pageInfo = record(record(items)?.pageInfo)
  return ok({ project: projectValue, items: list(record(items)?.nodes).flatMap((node) => { const normalized = normalizeProjectItem(node); return normalized === null ? [] : [normalized] }), next: pageInfo?.hasNextPage === true ? nullableText(pageInfo.endCursor) : null })
}

export async function executeProjects(verb: ProjectVerb, args: readonly string[], environment: Environment, process: ProcessAdapter): Promise<Result<string>> {
  if (args.includes('-h') || args.includes('--help')) return ok(usageText(`github-${verb}`))
  const parsed = parse(verb, args)
  if (parsed.kind !== 'ok') return parsed
  const options = parsed.value
  const resolved = await resolveRepository(options.selector, environment, process)
  if (resolved.kind !== 'ok') return resolved
  const repositoryName = resolved.value.nameWithOwner
  if (verb === 'projects') {
    const answer = await graphqlCall(process, 'gh api graphql', PROJECTS_QUERY, repositoryVariables(repositoryName))
    if (answer.kind !== 'ok') return answer
    const repo = connection(answer.value.data.repository)
    const owner = record(repo.owner) ?? {}
    const linked = list(record(repo.projectsV2)?.nodes).flatMap((node) => { const found = normalizeProject(node); return found === null ? [] : [found] })
    const ownerProjects = ownerProjectNodes(owner).flatMap((node) => {
      const found = normalizeProject(node)
      return found !== null && !found.closed && containsRepository(record(node)?.items, repositoryName) ? [found] : []
    })
    const unique = new Map([...linked, ...ownerProjects].map((item) => [item.id, item]))
    const output = { projects: [...unique.values()] }
    return options.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(output.projects.map((item) => `#${item.number}\t${item.title}\t${item.owner}\t${item.url}`).join('\n') + (output.projects.length ? '\n' : ''))
  }
  const number = options.number!
  const owner = options.owner ?? repositoryName.split('/')[0] ?? ''
  const page = await projectQuery(repositoryName, owner, number, options.after ?? null, process)
  if (page.kind !== 'ok') return page
  return options.json ? ok(`${JSON.stringify(page.value, null, 2)}\n`) : ok(page.value.items.map((item) => `${item.status ?? '-'}\t${item.type}\t${item.number ?? '-'}\t${item.title}`).join('\n') + (page.value.items.length ? '\n' : ''))
}
