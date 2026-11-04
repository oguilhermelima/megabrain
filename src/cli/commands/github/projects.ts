import { failed, ok, type Result } from '../../../core/result.js'
import { usageMessage, usageText } from '../../../core/usage.js'
import { graphqlCall, readCache, repositoryVariables, resolveRepository, writeCache } from './client.js'
import type { ProcessAdapter } from '../../../adapters/proc.js'

const record = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === 'object' ? value as Record<string, any> : undefined
const list = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === 'object') : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const nullableText = (value: unknown): string | null => typeof value === 'string' ? value : null

export const PROJECT_VERBS = ['projects', 'project', 'project-move'] as const
type ProjectVerb = typeof PROJECT_VERBS[number]
type Environment = Readonly<Record<string, string | undefined>>
const PROJECT_DISCOVERY_CACHE_TTL = 10 * 60_000
const PROJECT_PROBE_CONCURRENCY = 5

export type ProjectStatusOption = { id: string; name: string; color: string }
export type ProjectField = { id: string; name: string; dataType: string; options: ProjectStatusOption[]; iterations: { id: string; title: string; startDate: string; duration: number }[] }
export type ProjectView = { id: string; number: number; name: string; layout: string; filter: string; groupByFields: { id: string; name: string }[]; verticalGroupByFields: { id: string; name: string }[]; sortByFields: { direction: string; field: { id: string; name: string } }[]; visibleFields: { id: string; name: string }[] }
export type ProjectStatusField = { id: string; name: string; options: ProjectStatusOption[] }
export type Project = { id: string; number: number; title: string; url: string; owner: string; closed: boolean; statusField: ProjectStatusField | null; fields: ProjectField[]; views: ProjectView[] }
export type ProjectItem = {
  id: string; type: 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE'; number: number | null; title: string; url: string | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED' | null; repository: string | null; status: string | null;
  assignees: { login: string; avatarUrl: string }[]; labels: { name: string; color: string }[]; updatedAt: string; isArchived: boolean;
  fieldValues: { kind: 'singleSelect' | 'number' | 'date' | 'text' | 'iteration' | 'labels' | 'milestone' | 'users' | 'repository' | 'pullRequests' | 'reviewers' | 'issue'; field: string; value: unknown }[]
  body: string | null
  milestone: { title: string; dueOn: string | null } | null; parentIssue: { number: number; title: string; url: string; repository: string | null } | null; subIssuesProgress: { total: number; completed: number } | null
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
  const recordValue = record(value)
  const entries = Array.isArray(recordValue?.nodes) ? recordValue.nodes : Object.values(recordValue ?? {}).filter((entry) => record(entry)?.__typename !== undefined)
  return list(entries).flatMap((raw) => {
    const entry = record(raw)
    if (!entry || typeof entry.__typename !== 'string') return []
    const suffix = entry.__typename.replace('ProjectV2ItemField', '').replace('Value', '').replace('ProjectV2Item', '').replace('Field', '')
    const kinds: Record<string, ProjectItem['fieldValues'][number]['kind']> = { SingleSelect: 'singleSelect', Number: 'number', Date: 'date', Text: 'text', Iteration: 'iteration', Label: 'labels', Milestone: 'milestone', User: 'users', Repository: 'repository', PullRequest: 'pullRequests', Reviewer: 'reviewers', Issue: 'issue' }
    const kind = kinds[suffix]
    if (!kind) return []
    const field = text(record(entry.field)?.name)
    const value = kind === 'singleSelect' ? { optionId: nullableText(entry.optionId), name: nullableText(entry.name) }
      : kind === 'iteration' ? { title: text(entry.title), startDate: text(entry.startDate), duration: typeof entry.duration === 'number' ? entry.duration : null }
      : kind === 'labels' ? list(record(entry.labels)?.nodes).map((label) => ({ name: text(label.name), color: text(label.color) }))
      : kind === 'milestone' ? record(entry.milestone) ? { title: text(record(entry.milestone)?.title), dueOn: nullableText(record(entry.milestone)?.dueOn) } : null
      : kind === 'users' ? list(record(entry.users)?.nodes).map((user) => text(user.login))
      : kind === 'repository' ? nullableText(record(entry.repository)?.nameWithOwner)
      : kind === 'pullRequests' ? list(record(entry.pullRequests)?.nodes).map((pr) => ({ number: pr.number, title: text(pr.title), url: text(pr.url) }))
      : kind === 'reviewers' ? list(record(entry.reviewers)?.nodes).map((reviewer) => text(reviewer.login ?? reviewer.name))
      : kind === 'issue' ? record(entry.issueFieldValue) ? { kind: text(record(entry.issueFieldValue)?.__typename), value: record(entry.issueFieldValue)?.value ?? record(entry.issueFieldValue)?.optionId ?? null, name: nullableText(record(entry.issueFieldValue)?.name) } : null
      : entry.number ?? entry.date ?? entry.text ?? null
    return [{ kind, field, value: value ?? null }]
  })
}

const FIELD_NODE = `__typename ... on ProjectV2Field { id name dataType } ... on ProjectV2SingleSelectField { id name dataType options { id name color description } } ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } } ... on ProjectV2MultiSelectField { id name dataType }`
const STATUS_FIELD = `fields(first: 100) { nodes { ${FIELD_NODE} } }`
export const PROJECT_FIELDS = `id number title url closed owner { ... on User { login } ... on Organization { login } } ${STATUS_FIELD}`
const VIEW_FIELDS = `views(first: 50) { nodes { id number name layout filter groupByFields(first: 50) { nodes { ${FIELD_NODE} } } verticalGroupByFields(first: 50) { nodes { ${FIELD_NODE} } } sortByFields(first: 50) { nodes { direction field { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name } ... on ProjectV2IterationField { id name } ... on ProjectV2MultiSelectField { id name } } } } configuration { visibleFields(first: 50) { nodes { ${FIELD_NODE} } } } } } fields(first: 100) { nodes { ${FIELD_NODE} } }`
export const CONTENT_FIELDS = `
  __typename
  ... on Issue { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } milestone { title dueOn } parent { number title url repository { nameWithOwner } } subIssuesSummary { total completed } }
  ... on PullRequest { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } milestone { title dueOn } }
  ... on DraftIssue { title body }
`
const ITEM_FIELD_VALUES = `fieldValues(first: 30) { nodes { __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { name } } labels(first: 20) { nodes { name color } } } ... on ProjectV2ItemFieldMilestoneValue { field { ... on ProjectV2FieldCommon { name } } milestone { title dueOn } } ... on ProjectV2ItemFieldUserValue { users(first: 20) { nodes { login } } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldRepositoryValue { repository { nameWithOwner } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldPullRequestValue { pullRequests(first: 20) { nodes { number title url } } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldReviewerValue { field { ... on ProjectV2FieldCommon { name } } reviewers(first: 20) { nodes { __typename ... on User { login } ... on Team { name } } } } ... on ProjectV2ItemIssueFieldValue { field { ... on ProjectV2FieldCommon { name } } issueFieldValue { __typename ... on IssueFieldDateValue { value } ... on IssueFieldNumberValue { value } ... on IssueFieldTextValue { value } ... on IssueFieldSingleSelectValue { name optionId } } } } }`
export const PROJECT_ITEM_FIELD_VALUES = ITEM_FIELD_VALUES
const CARD_CONTENT_FIELDS = `__typename ... on Issue { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } } ... on PullRequest { number title url state updatedAt repository { nameWithOwner } assignees(first: 100) { nodes { login avatarUrl } } labels(first: 100) { nodes { name color } } } ... on DraftIssue { title }`

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

const projectPageQuery = (fieldNames: readonly string[] = []) => {
  const declarations = fieldNames.map((_, index) => `$field${index}: String!`).join(', ')
  const values = fieldNames.map((_, index) => `field${index}: fieldValueByName(name: $field${index}) { __typename ... on ProjectV2ItemFieldSingleSelectValue { name optionId field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { name } } labels(first: 20) { nodes { name color } } } ... on ProjectV2ItemFieldMilestoneValue { field { ... on ProjectV2FieldCommon { name } } milestone { title dueOn } } ... on ProjectV2ItemFieldUserValue { users(first: 20) { nodes { login } } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldRepositoryValue { repository { nameWithOwner } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldPullRequestValue { pullRequests(first: 20) { nodes { number title url } } field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldReviewerValue { field { ... on ProjectV2FieldCommon { name } } reviewers(first: 20) { nodes { __typename ... on User { login } ... on Team { name } } } } ... on ProjectV2ItemIssueFieldValue { field { ... on ProjectV2FieldCommon { name } } issueFieldValue { __typename ... on IssueFieldDateValue { value } ... on IssueFieldNumberValue { value } ... on IssueFieldTextValue { value } ... on IssueFieldSingleSelectValue { name optionId } } } }`).join('\n')
  return `query($owner: String!, $name: String!, $number: Int!, $after: String${declarations ? `, ${declarations}` : ''}) {
  repository(owner: $owner, name: $name) { owner { login } }
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { items(first: 100, after: $after) { totalCount nodes { id isArchived updatedAt ${values} fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } } content { ${CARD_CONTENT_FIELDS} } } pageInfo { hasNextPage endCursor } } } } }
}`
}
export const PROJECT_QUERY = projectPageQuery()

export const PROJECT_METADATA_QUERY = `query projectMetadata($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { owner { login } }
  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { id number title url closed owner { ... on User { login } ... on Organization { login } } ${VIEW_FIELDS} items(first: 1, after: $after) { totalCount } } } }
}`

export const PROJECT_ITEM_QUERY = `query projectItemDetail($itemId: ID!) {
  node(id: $itemId) { ... on ProjectV2Item { id isArchived updatedAt ${ITEM_FIELD_VALUES} fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId } } content { ${CONTENT_FIELDS} } } }
}`

const PROJECT_MEMBERSHIP_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { owner { login } }
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner { projectV2(number: $number) { items(first: 100, after: $after) { nodes { content { ... on Issue { repository { nameWithOwner } } ... on PullRequest { repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } }
  }
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
    milestone: record(content.milestone) ? { title: text(record(content.milestone)?.title), dueOn: nullableText(record(content.milestone)?.dueOn) } : null,
    parentIssue: record(content.parent) ? { number: typeof record(content.parent)?.number === 'number' ? record(content.parent)!.number : 0, title: text(record(content.parent)?.title), url: text(record(content.parent)?.url), repository: nullableText(record(record(content.parent)?.repository)?.nameWithOwner) } : null,
    subIssuesProgress: record(content.subIssuesSummary) ? { total: typeof record(content.subIssuesSummary)?.total === 'number' ? record(content.subIssuesSummary)!.total : 0, completed: typeof record(content.subIssuesSummary)?.completed === 'number' ? record(content.subIssuesSummary)!.completed : 0 } : null,
    body: nullableText(content.body),
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
    const repositoryName = repository.split('/')[1] ?? ''
    const page = await graphqlCall(process, 'gh api graphql', PROJECT_MEMBERSHIP_QUERY, { owner, name: repositoryName, number: project.number, after: cursor })
    if (page.kind !== 'ok') return page
    const items = connection(connection(record(page.value.data.repositoryOwner)?.projectV2).items)
    if (containsRepository(items, repository)) return ok(true)
    cursorResult = nextConnectionCursor(items)
    if (cursorResult.kind !== 'ok') return cursorResult
    cursor = cursorResult.value
  }
  return ok(false)
}

type Parsed = { selector: string; number?: number; owner?: string; after?: string | null; itemId?: string; fields?: string[]; json: boolean }
function parse(verb: ProjectVerb, args: readonly string[]): Result<Parsed> {
  const positionals = verb === 'projects' ? 1 : 2
  const selector = args[0]
  const numberText = positionals > 1 ? args[1] : undefined
  const flags = args.slice(positionals)
  if (selector === undefined || (verb !== 'projects' && (numberText === undefined || !/^\d+$/.test(numberText) || Number(numberText) < 1))) return failed(usageMessage(`github-${verb}`), 2)
  const values: Record<string, string> = {}
  const fields: string[] = []
  let json = false
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]
    if (flag === '--json') { json = true; continue }
    if (flag === '--field' && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('--')) {
      const field = flags[++i]!
      if (field.trim() === '' || field.length > 200 || fields.length >= 100) return failed('--field must be non-empty and supplied at most 100 times', 2)
      fields.push(field)
      continue
    }
    if ((flag === '--owner' || flag === '--after' || flag === '--item') && flags[i + 1] !== undefined && !flags[i + 1]!.startsWith('--')) {
      if (values[flag] !== undefined) return failed(`${flag} may only be supplied once`, 2)
      values[flag] = flags[++i]!
      continue
    }
    return failed(usageMessage(`github-${verb}`), 2)
  }
  return ok({ selector, ...(numberText === undefined ? {} : { number: Number(numberText) }), ...(values['--owner'] === undefined ? {} : { owner: values['--owner'] }), ...(values['--after'] === undefined ? {} : { after: values['--after'] }), ...(values['--item'] === undefined ? {} : { itemId: values['--item'] }), ...(fields.length === 0 ? {} : { fields: [...new Set(fields)] }), json })
}

async function projectQuery(repositoryName: string, owner: string, number: number, after: string | null, fields: readonly string[], environment: Environment, process: ProcessAdapter) {
  const variables = { ...repositoryVariables(repositoryName), owner, number, ...(after === null ? {} : { after }), ...Object.fromEntries(fields.map((field, index) => [`field${index}`, field])) }
  const cacheKey = JSON.stringify(['github-project-metadata', owner, number])
  const cachedProject = readCache(environment, cacheKey, Date.now(), 10 * 60_000)
  const pagePromise = graphqlCall(process, 'gh api graphql', projectPageQuery(fields), variables)
  let projectValue = cachedProject === undefined ? null : normalizeProject(cachedProject)
  let pageAnswer: Awaited<typeof pagePromise>
  if (projectValue === null) {
    const [metadata, answer] = await Promise.all([
      graphqlCall(process, 'gh api graphql', PROJECT_METADATA_QUERY, { ...repositoryVariables(repositoryName), owner, number, ...(after === null ? {} : { after }) }),
      pagePromise,
    ])
    if (metadata.kind !== 'ok') return metadata
    if (answer.kind !== 'ok') return answer
    pageAnswer = answer
    const rawMetadata = record(metadata.value.data.repositoryOwner)?.projectV2
    projectValue = normalizeProject(rawMetadata)
    if (projectValue !== null) writeCache(environment, cacheKey, Date.now(), rawMetadata, 10 * 60_000)
  } else {
    pageAnswer = await pagePromise
    if (pageAnswer.kind !== 'ok') return pageAnswer
  }
  if (projectValue === null) return failed(`GitHub project ${number} was not found for ${owner}`)
  const ownerValue = record(pageAnswer.value.data.repositoryOwner)?.projectV2
  const items = record(ownerValue)?.items
  const pageInfo = record(record(items)?.pageInfo)
  const totalCount = record(items)?.totalCount
  return ok({ project: projectValue, items: list(record(items)?.nodes).flatMap((node) => { const normalized = normalizeProjectItem(node); return normalized === null ? [] : [normalized] }), ...(typeof totalCount === 'number' ? { totalCount } : {}), next: pageInfo?.hasNextPage === true ? nullableText(pageInfo.endCursor) : null })
}

async function projectItemQuery(itemId: string, process: ProcessAdapter) {
  const answer = await graphqlCall(process, 'gh api graphql', PROJECT_ITEM_QUERY, { itemId })
  if (answer.kind !== 'ok') return answer
  const item = normalizeProjectItem(answer.value.data.node)
  return item === null ? failed(`GitHub project item ${itemId} was not found`) : ok({ item })
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
    const cacheKey = JSON.stringify(['projects-discovery', repositoryName])
    const started = Date.now()
    const cached = readCache(environment, cacheKey, started, PROJECT_DISCOVERY_CACHE_TTL)
    if (cached !== undefined) return options.json ? ok(`${JSON.stringify(cached, null, 2)}\n`) : ok(list(record(cached)?.projects).map((item) => { const project = normalizeProject(item); return project ? `#${project.number}\t${project.title}\t${project.owner}\t${project.url}` : '' }).filter(Boolean).join('\n') + (list(record(cached)?.projects).length ? '\n' : ''))
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
    const candidates = ownerNodes.flatMap((node) => {
      const project = normalizeProject(node)
      return project === null || project.closed ? [] : [{ node, project }]
    })
    for (let start = 0; start < candidates.length; start += PROJECT_PROBE_CONCURRENCY) {
      const batch = candidates.slice(start, start + PROJECT_PROBE_CONCURRENCY)
      const memberships = await Promise.all(batch.map(({ node }) => ownerProjectContainsRepository(node, repositoryName, ownerLogin, process)))
      for (let index = 0; index < batch.length; index += 1) {
        const membership = memberships[index]!
        if (membership.kind !== 'ok') return membership
        if (membership.value) ownerProjects.push(batch[index]!.project)
      }
    }
    const unique = new Map([...linked, ...ownerProjects].map((item) => [item.id, item]))
    const output = { projects: [...unique.values()] }
    writeCache(environment, cacheKey, started, output, PROJECT_DISCOVERY_CACHE_TTL)
    return options.json ? ok(`${JSON.stringify(output, null, 2)}\n`) : ok(output.projects.map((item) => `#${item.number}\t${item.title}\t${item.owner}\t${item.url}`).join('\n') + (output.projects.length ? '\n' : ''))
  }
  const number = options.number!
  if (options.itemId !== undefined) {
    const item = await projectItemQuery(options.itemId, process)
    if (item.kind !== 'ok') return item
    return options.json ? ok(`${JSON.stringify(item.value, null, 2)}\n`) : ok(`${item.value.item.title}\n`)
  }
  const owner = options.owner ?? repositoryName.split('/')[0] ?? ''
  const page = await projectQuery(repositoryName, owner, number, options.after ?? null, options.fields ?? [], environment, process)
  if (page.kind !== 'ok') return page
  return options.json ? ok(`${JSON.stringify(page.value, null, 2)}\n`) : ok(page.value.items.map((item) => `${item.status ?? '-'}\t${item.type}\t${item.number ?? '-'}\t${item.title}`).join('\n') + (page.value.items.length ? '\n' : ''))
}
