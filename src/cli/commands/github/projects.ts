import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, repositoryVariables, resolveRepository } from './client.js'
import type { ProcessAdapter } from '../../../adapters/proc.js'

const record = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === 'object' ? value as Record<string, any> : undefined
const list = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === 'object') : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const nullableText = (value: unknown): string | null => typeof value === 'string' ? value : null

export const PROJECT_VERBS = ['projects', 'project', 'project-move'] as const
type ProjectVerb = typeof PROJECT_VERBS[number]
type Environment = Readonly<Record<string, string | undefined>>

export type ProjectStatusOption = { id: string; name: string; color: string }
export type ProjectField = { id: string; name: string; dataType: string; options: ProjectStatusOption[]; iterations: { id: string; title: string; startDate: string; duration: number }[] }
export type ProjectView = { id: string; number: number; name: string; layout: string; filter: string; groupByFields: { id: string; name: string }[]; verticalGroupByFields: { id: string; name: string }[]; sortByFields: { direction: string; field: { id: string; name: string } }[]; visibleFields: { id: string; name: string }[] }
export type ProjectStatusField = { id: string; name: string; options: ProjectStatusOption[] }
export type Project = { id: string; number: number; title: string; url: string; owner: string; closed: boolean; statusField: ProjectStatusField | null; fields: ProjectField[]; views: ProjectView[] }
export type ProjectItem = {
  id: string; type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE'; number: number | null; title: string; url: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | null; repository: string | null; status: string | null;
  assignees: { login: string; avatarUrl: string }[]; labels: { name: string; color: string }[]; updatedAt: string; isArchived: boolean;
  fieldValues: { kind: string; field: string; value: unknown }[]
}

function normalizeFieldRef(value: unknown): { id: string; name: string } | null {
  const entry = record(value)
  return typeof entry?.id === 'string' && typeof entry.name === 'string' ? { id: entry.id, name: entry.name } : null
}

export function normalizeProjectFields(value: unknown): ProjectField[] {
  return list(value).flatMap((raw) => {
    const entry = record(raw)
    if (typeof entry?.id !== 'string' || typeof entry.name !== 'string') return []
    const options = list(entry.options).flatMap((option) => typeof option.id === 'string' && typeof option.name === 'string'
      ? [{ id: option.id, name: option.name, color: text(option.color), description: text(option.description) }] : [])
    const iterations = list(record(entry.configuration)?.iterations).flatMap((iteration) => typeof iteration.id === 'string'
      ? [{ id: iteration.id, title: text(iteration.title), startDate: text(iteration.startDate), duration: typeof iteration.duration === 'number' ? iteration.duration : 0 }] : [])
    return [{ id: entry.id, name: entry.name, dataType: text(entry.dataType), options, iterations }]
  })
}

export function normalizeProjectViews(value: unknown): ProjectView[] {
  return list(value).flatMap((raw) => {
    const entry = record(raw)
    if (typeof entry?.id !== 'string' || typeof entry.number !== 'number') return []
    const refs = (node: unknown) => list(record(node)?.nodes).flatMap((field) => { const normalized = normalizeFieldRef(field); return normalized ? [normalized] : [] })
    const sortByFields = list(record(entry.sortByFields)?.nodes).flatMap((row) => {
      const direction = record(row)?.direction
      const field = normalizeFieldRef(record(row)?.field)
      return field && typeof direction === 'string' ? [{ direction, field }] : []
    })
    return [{ id: entry.id, number: entry.number, name: text(entry.name), layout: text(entry.layout), filter: text(entry.filter), groupByFields: refs(entry.groupByFields), verticalGroupByFields: refs(entry.verticalGroupByFields), sortByFields, visibleFields: refs(record(entry.configuration)?.visibleFields) }]
  })
}

function normalizeFieldValues(value: unknown): ProjectItem['fieldValues'] {
  return list(record(value)?.nodes).flatMap((raw) => {
    const entry = record(raw)
    if (!entry || typeof entry.__typename !== 'string') return []
    const kind = entry.__typename.replace('ProjectV2ItemField', '').replace('Value', '').toLowerCase()
    const field = text(record(entry.field)?.name)
    const value = entry.optionId ?? entry.number ?? entry.date ?? entry.text ?? (entry.title ? { title: entry.title, startDate: entry.startDate, duration: entry.duration } : entry.users ?? entry.repository ?? entry.pullRequests ?? entry.labels ?? entry.milestone)
    return [{ kind, field, value: value ?? null }]
  })
}

const STATUS_FIELD = `fields(first: 100) { nodes { __typename ... on ProjectV2SingleSelectField { id name options { id name color } } } }`
export const PROJECT_FIELDS = `id number title url closed owner { ... on User { login } ... on Organization { login } } ${STATUS_FIELD}`
const FIELD_NODE = `__typename ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name color description } } ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } } ... on ProjectV2MultiSelectField { id name dataType options { id name color description } }`
const VIEW_FIELDS = `views(first: 50) { nodes { id number name layout filter groupByFields(first: 50) { nodes { ${FIELD_NODE} } } verticalGroupByFields(first: 50) { nodes { ${FIELD_NODE} } } sortByFields(first: 50) { nodes { direction field { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } } } configuration { visibleFields(first: 50) { nodes { ${FIELD_NODE} } } } } } fields(first: 100) { nodes { ${FIELD_NODE} } }`
export const CONTENT_FIELDS = `
  __typename
  ... on Issue { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } }
  ... on PullRequest { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } }
  ... on DraftIssue { title }
`
const ITEM_FIELD_VALUES = `fieldValues(first: 30) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldLabelValue { labels(first: 20) { nodes { name color } } } ... on ProjectV2ItemFieldMilestoneValue { milestone { title } } ... on ProjectV2ItemFieldUserValue { users(first: 20) { nodes { login } } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldRepositoryValue { repository { nameWithOwner } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldPullRequestValue { pullRequests(first: 20) { nodes { number title url } } field { ... on ProjectV2FieldCommon { name } } } } }`
const PROJECT_ITEMS = `items(first: 100, after: $after) { nodes { id isArchived updatedAt ${ITEM_FIELD_VALUES} fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } } content { ${CONTENT_FIELDS} } } pageInfo { hasNextPage endCursor } }`

export const PROJECTS_QUERY = `query projectsDiscovery($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 100) { nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor } }
    owner {
      __typename login
      ... on User { projectsV2(first: 100) { nodes { ${PROJECT_FIELDS} items(first: 100) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }
      ... on Organization { projectsV2(first: 100) { nodes { ${PROJECT_FIELDS} items(first: 100) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }
    }
  }
}`

export const REPOSITORY_PROJECTS_PAGE_QUERY = `query repositoryProjects($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) { projectsV2(first: 100, after: $after) { nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor } } }
}`

export const OWNER_PROJECTS_PAGE_QUERY = `query ownerProjects($owner: String!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on User { projectsV2(first: 100, after: $after) { nodes { ${PROJECT_FIELDS} items(first: 100) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }
    ... on Organization { projectsV2(first: 100, after: $after) { nodes { ${PROJECT_FIELDS} items(first: 100) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } } }
  }
}`

export const PROJECT_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { owner { login } }
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { ${PROJECT_FIELDS} ${VIEW_FIELDS} ${PROJECT_ITEMS} } } }
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
    owner: text(record(entry.owner)?.login), closed: entry.closed === true, statusField: statusField(entry.fields), fields: normalizeProjectFields(record(entry.fields)?.nodes), views: normalizeProjectViews(record(entry.views)?.nodes),
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
    updatedAt: text(entry.updatedAt ?? content.updatedAt), isArchived: entry.isArchived === true, fieldValues: normalizeFieldValues(entry.fieldValues),
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

function nextConnectionCursor(value: unknown): Result<string | null> {
  const info = record(record(value)?.pageInfo)
  if (info?.hasNextPage !== true) return ok(null)
  const cursor = nullableText(info.endCursor)
  return cursor === null ? failed('GitHub project discovery returned a next page without a cursor') : ok(cursor)
}

async function ownerProjectContainsRepository(node: unknown, repository: string, owner: string, process: ProcessAdapter): Promise<Result<boolean>> {
  const project = normalizeProject(node)
  if (project === null || containsRepository(record(node)?.items, repository)) return ok(project !== null && containsRepository(record(node)?.items, repository))
  let cursorResult = nextConnectionCursor(record(node)?.items)
  if (cursorResult.kind !== 'ok') return cursorResult
  let cursor = cursorResult.value
  while (cursor !== null) {
    const page = await projectQuery(repository, owner, project.number, cursor, process)
    if (page.kind !== 'ok') return page
    if (page.value.items.some((item) => item.repository === repository)) return ok(true)
    cursorResult = nextConnectionCursor({ pageInfo: { hasNextPage: page.value.next !== null, endCursor: page.value.next } })
    if (cursorResult.kind !== 'ok') return cursorResult
    cursor = cursorResult.value
  }
  return ok(false)
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
    const repositoryVariablesValue = repositoryVariables(repositoryName)
    const initial = await graphqlCall(process, 'gh api graphql', PROJECTS_QUERY, repositoryVariablesValue)
    if (initial.kind !== 'ok') return initial
    const initialRepo = connection(initial.value.data.repository)
    const initialOwner = record(initialRepo.owner) ?? {}
    const linked: Project[] = list(record(initialRepo.projectsV2)?.nodes).flatMap((node) => { const found = normalizeProject(node); return found === null ? [] : [found] })
    const ownerNodes = ownerProjectNodes(initialOwner)
    const repositoryNext = nextConnectionCursor(initialRepo.projectsV2)
    if (repositoryNext.kind !== 'ok') return repositoryNext
    const ownerNext = nextConnectionCursor(initialOwner.projectsV2)
    if (ownerNext.kind !== 'ok') return ownerNext

    let repositoryAfter = repositoryNext.value
    while (repositoryAfter !== null) {
      const answer = await graphqlCall(process, 'gh api graphql', REPOSITORY_PROJECTS_PAGE_QUERY, { ...repositoryVariablesValue, after: repositoryAfter })
      if (answer.kind !== 'ok') return answer
      const connectionPage = connection(connection(answer.value.data.repository).projectsV2)
      linked.push(...list(connectionPage.nodes).flatMap((node) => { const found = normalizeProject(node); return found === null ? [] : [found] }))
      const next = nextConnectionCursor(connectionPage)
      if (next.kind !== 'ok') return next
      repositoryAfter = next.value
    }

    const ownerLogin = repositoryVariablesValue.owner
    let ownerAfter = ownerNext.value
    while (ownerAfter !== null) {
      const answer = await graphqlCall(process, 'gh api graphql', OWNER_PROJECTS_PAGE_QUERY, { owner: ownerLogin, after: ownerAfter })
      if (answer.kind !== 'ok') return answer
      const ownerPage = connection(answer.value.data.repositoryOwner)
      ownerNodes.push(...ownerProjectNodes(ownerPage))
      const next = nextConnectionCursor(ownerPage.projectsV2)
      if (next.kind !== 'ok') return next
      ownerAfter = next.value
    }

    const ownerProjects: Project[] = []
    for (const node of ownerNodes) {
      const found = normalizeProject(node)
      if (found === null || found.closed) continue
      const membership = await ownerProjectContainsRepository(node, repositoryName, ownerLogin, process)
      if (membership.kind !== 'ok') return membership
      if (membership.value) ownerProjects.push(found)
    }
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
